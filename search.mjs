#!/usr/bin/env node

// search.mjs — Autonomous job search via paid Apify actors (LinkedIn + Indeed).
// Feed-only: derives criteria from config/profile.yml, runs source adapters,
// filters/dedupes via pipeline-io, and appends matches to data/pipeline.md.
//
// Layered so the pure criteria functions (deriveCriteria/loadProfile) stay
// unit-testable in isolation, with the CLI orchestrator (main) below them.

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';
import {
  buildTitleFilter,
  buildLocationFilter,
  loadSeenUrls,
  loadSeenCompanyRoles,
  filterAndDedupOffers,
  appendToPipeline,
  appendToScanHistory,
  PIPELINE_PATH,
  SCAN_HISTORY_PATH,
} from './pipeline-io.mjs';
import { runActorSync } from './sources/_apify.mjs';
import linkedinSource from './sources/linkedin-apify.mjs';
import indeedSource from './sources/indeed-apify.mjs';
import { config as loadDotenv } from 'dotenv';

const ROOT = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_POSTED_DAYS = 7;
export const DEFAULT_COUNTRY = 'us';

const COUNTRY_NAME_TO_ISO2 = {
  'united states': 'us', usa: 'us', 'united kingdom': 'gb', uk: 'gb',
  canada: 'ca', germany: 'de', france: 'fr', spain: 'es', italy: 'it',
  netherlands: 'nl', ireland: 'ie', switzerland: 'ch', sweden: 'se',
  norway: 'no', denmark: 'dk', finland: 'fi', portugal: 'pt', belgium: 'be',
  austria: 'at', poland: 'pl', turkey: 'tr', 'türkiye': 'tr', japan: 'jp',
  australia: 'au', india: 'in', singapore: 'sg', brazil: 'br', mexico: 'mx',
};

function parseKeywordOverride(value) {
  if (Array.isArray(value)) return value.filter((k) => k != null).map((k) => String(k).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((k) => k.trim()).filter(Boolean);
  return [];
}

function dedupeKeywords(list) {
  const seen = new Set();
  const out = [];
  for (const k of list) {
    const key = String(k).trim();
    if (key && !seen.has(key.toLowerCase())) { seen.add(key.toLowerCase()); out.push(key); }
  }
  return out;
}

function resolveCountry(countryName) {
  if (typeof countryName !== 'string') return DEFAULT_COUNTRY;
  const key = countryName.toLowerCase().trim();
  if (COUNTRY_NAME_TO_ISO2[key]) return COUNTRY_NAME_TO_ISO2[key];
  if (/^[a-z]{2}$/.test(key)) return key; // already an ISO-3166 alpha-2 code.
  return DEFAULT_COUNTRY;
}

function detectRemote(profile) {
  const flex = String(profile?.compensation?.location_flexibility || '').toLowerCase();
  return flex.includes('remote') ? 'remote' : undefined;
}

/**
 * Load config/profile.yml as a plain object ({} when absent).
 */
export function loadProfile(root = ROOT) {
  const p = join(root, 'config', 'profile.yml');
  if (!existsSync(p)) return {};
  try {
    return yaml.load(readFileSync(p, 'utf-8')) || {};
  } catch (err) {
    throw new Error(`config/profile.yml is malformed: ${err.message}`);
  }
}

/**
 * Derive search Criteria from a parsed profile plus CLI overrides.
 * Pure — no file or network I/O. Throws when no keywords can be derived.
 */
export function deriveCriteria(profile = {}, overrides = {}) {
  const targetRoles = profile?.target_roles || {};
  const primary = Array.isArray(targetRoles.primary) ? targetRoles.primary : [];
  const archetypes = Array.isArray(targetRoles.archetypes)
    ? targetRoles.archetypes.map((a) => a?.name).filter(Boolean)
    : [];

  const overrideKeywords = parseKeywordOverride(overrides.keywords);
  const keywords = overrideKeywords.length > 0
    ? dedupeKeywords(overrideKeywords)
    : dedupeKeywords([...primary, ...archetypes]);

  if (keywords.length === 0) {
    throw new Error(
      'No search keywords — set target_roles.primary in config/profile.yml or pass --keywords "Role A,Role B".',
    );
  }

  const loc = profile?.location || {};
  const location = String(loc.city || loc.country || '').trim();
  const country = resolveCountry(loc.country);
  const remote = detectRemote(profile);
  const postedDays = Number.isFinite(overrides.postedDays) ? overrides.postedDays : DEFAULT_POSTED_DAYS;

  return { keywords, location, country, remote, postedDays };
}

// ── Sources & pricing ───────────────────────────────────────────────
const SOURCES = { linkedin: linkedinSource, indeed: indeedSource };
const PRICE_PER_1000_USD = { linkedin: 1.0, indeed: 5.0 };

export const DEFAULT_MAX_ITEMS = 100;
export const MAX_ITEMS_CEILING = 500;
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';

const ITEMS_PER_PRICING_UNIT = 1000;
const COST_SAFETY_MULTIPLIER = 2; // charge cap = 2× the worst-case estimate.
const MIN_CHARGE_USD = 1;

/** Worst-case cost for a source at a given item cap. */
export function estimateCostUsd(sourceId, maxItems) {
  const price = PRICE_PER_1000_USD[sourceId] || 0;
  return (maxItems / ITEMS_PER_PRICING_UNIT) * price;
}

export function parseArgs(argv) {
  const args = argv.slice(2);
  const has = (f) => args.includes(f);
  // Return the token after a flag, treating a missing value or another
  // `--flag` as "absent" so e.g. `--keywords --max` doesn't capture "--max".
  const val = (f) => {
    const i = args.indexOf(f);
    if (i === -1) return undefined;
    const next = args[i + 1];
    return next === undefined || next.startsWith('--') ? undefined : next;
  };

  let max = Number(val('--max'));
  if (!Number.isFinite(max) || max <= 0) max = DEFAULT_MAX_ITEMS;
  if (max > MAX_ITEMS_CEILING) {
    console.warn(`⚠️  --max ${max} exceeds ceiling ${MAX_ITEMS_CEILING}; clamping.`);
    max = MAX_ITEMS_CEILING;
  }

  const postedDaysRaw = val('--posted-days');
  const postedDays = postedDaysRaw !== undefined ? Number(postedDaysRaw) : undefined;

  const only = val('--source');
  const sourceIds = only ? [only] : Object.keys(SOURCES);

  return {
    dryRun: has('--dry-run'),
    maxItems: max,
    keywords: val('--keywords'),
    postedDays: Number.isFinite(postedDays) ? postedDays : undefined,
    sourceIds,
  };
}

function loadFilters() {
  if (!existsSync(PORTALS_PATH)) return { titleFilter: () => true, locationFilter: () => true };
  let cfg;
  try {
    cfg = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
  } catch (err) {
    throw new Error(`${PORTALS_PATH} is malformed: ${err.message}`);
  }
  return {
    titleFilter: buildTitleFilter(cfg.title_filter),
    locationFilter: buildLocationFilter(cfg.location_filter),
  };
}

function runDryRun(opts, criteria) {
  let total = 0;
  console.log(`\n(dry run — no API calls, no spend)`);
  for (const id of opts.sourceIds) {
    const input = SOURCES[id].buildInput(criteria, { maxItems: opts.maxItems });
    const cost = estimateCostUsd(id, opts.maxItems);
    total += cost;
    console.log(`\n[${id}] est ≤ $${cost.toFixed(2)} for ${opts.maxItems} results`);
    console.log(`  input: ${JSON.stringify(input)}`);
  }
  console.log(`\nWorst-case total: ≤ $${total.toFixed(2)}`);
}

async function fetchSources(opts, criteria, token) {
  const rawJobs = [];
  const errors = [];
  let totalFound = 0;
  for (const id of opts.sourceIds) {
    const source = SOURCES[id];
    try {
      const input = source.buildInput(criteria, { maxItems: opts.maxItems });
      const maxTotalChargeUsd = Math.max(
        MIN_CHARGE_USD,
        Math.ceil(estimateCostUsd(id, opts.maxItems) * COST_SAFETY_MULTIPLIER),
      );
      const items = await runActorSync(source.actorId, input, {
        token, maxItems: opts.maxItems, maxTotalChargeUsd,
      });
      const jobs = source.normalize(items);
      totalFound += jobs.length;
      for (const j of jobs) rawJobs.push({ ...j, source: `${id}-apify` });
      console.log(`  [${id}] ${jobs.length} job(s)`);
    } catch (err) {
      errors.push({ source: id, error: err.message });
      console.error(`  [${id}] error: ${err.message}`);
    }
  }
  return { rawJobs, errors, totalFound };
}

function printSummary({ opts, totalFound, filteredTitle, filteredLocation, dupes, newOffers, errors }) {
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Sources searched:      ${opts.sourceIds.length} (${opts.sourceIds.join(', ')})`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${filteredTitle} removed`);
  console.log(`Filtered by location:  ${filteredLocation} removed`);
  console.log(`Duplicates:            ${dupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);
  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
  }
  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ ${e.source}: ${e.error}`);
  }
  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
}

async function runLiveSearch(opts, criteria, date) {
  loadDotenv({ path: join(ROOT, '.env.local') });
  loadDotenv(); // .env fallback (won't override already-set vars)
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    console.error('Error: APIFY_API_TOKEN missing — add it to .env.local (see .env.example).');
    process.exit(1);
  }

  const { titleFilter, locationFilter } = loadFilters();
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  const { rawJobs, errors, totalFound } = await fetchSources(opts, criteria, token);
  const { kept: newOffers, filteredTitle, filteredLocation, dupes } =
    filterAndDedupOffers(rawJobs, { titleFilter, locationFilter, seenUrls, seenCompanyRoles });

  if (newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  printSummary({ opts, totalFound, filteredTitle, filteredLocation, dupes, newOffers, errors });

  // Exit non-zero only if every requested source failed.
  if (errors.length === opts.sourceIds.length) process.exit(1);
}

async function main() {
  const opts = parseArgs(process.argv);

  // Validate requested sources up front.
  for (const id of opts.sourceIds) {
    if (!SOURCES[id]) {
      console.error(`Error: unknown --source "${id}" (valid: ${Object.keys(SOURCES).join(', ')})`);
      process.exit(1);
    }
  }

  // Derive criteria (overrides win; profile optional when --keywords given).
  let criteria;
  try {
    criteria = deriveCriteria(loadProfile(), { keywords: opts.keywords, postedDays: opts.postedDays });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const date = new Date().toISOString().slice(0, 10);
  console.log(`\nJob Search — ${date}`);
  console.log(`Keywords: ${criteria.keywords.join(', ')}`);
  console.log(`Location: ${criteria.location || 'any'} | Country: ${criteria.country} | Remote: ${criteria.remote || 'any'} | Posted ≤ ${criteria.postedDays}d`);

  if (opts.dryRun) {
    runDryRun(opts, criteria);
    return;
  }
  await runLiveSearch(opts, criteria, date);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
}
