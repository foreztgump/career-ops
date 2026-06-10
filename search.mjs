#!/usr/bin/env node

// search.mjs — Autonomous job search via paid Apify actors (LinkedIn + Indeed).
// Feed-only: derives criteria from config/profile.yml, runs source adapters,
// filters/dedupes via pipeline-io, and appends matches to data/pipeline.md.
//
// Orchestrator (main) is added in Task 6; this file first defines the pure
// criteria layer so it is unit-testable in isolation.

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';

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
