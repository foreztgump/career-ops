# Autonomous Job Search (Apify) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone `/career-ops search` command (`node search.mjs`) that searches LinkedIn + Indeed via paid Apify actors, auto-derives criteria from the user's profile, filters/dedupes through the existing scanner logic, and feeds fresh matches into `data/pipeline.md`.

**Architecture:** A standalone orchestrator (`search.mjs`) calls one source adapter per job board (`sources/*.mjs`), each of which builds the actor input and normalizes the dataset output. Shared filter/dedup/pipeline-write helpers are extracted from `scan.mjs` into `pipeline-io.mjs` and reused by both commands. Discovery is **feed-only**: it stops at populating `pipeline.md`; evaluation stays in the existing `/career-ops pipeline`.

**Tech Stack:** Node.js ESM (`.mjs`), `dotenv` (token from `.env.local`), `js-yaml` (profile/portals), native `fetch` (Apify HTTP), `test-all.mjs` custom harness (no test framework).

**Spec:** `docs/superpowers/specs/2026-06-09-autonomous-job-search-apify-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `pipeline-io.mjs` (new) | Shared: path constants, `buildTitleFilter`, `buildLocationFilter`, `loadSeenUrls`, `loadSeenCompanyRoles`, `appendToPipeline`, `appendToScanHistory`. |
| `scan.mjs` (edit) | Import the above from `pipeline-io.mjs`; delete the local copies. Behavior unchanged. |
| `sources/_apify.mjs` (new) | Apify transport: `runActorSync()`, `mapApifyError()`. `_`-prefixed = not an adapter. |
| `sources/_types.js` (new) | JSDoc contract (`Criteria`, `SearchSource`). |
| `sources/linkedin-apify.mjs` (new) | LinkedIn adapter `{ id, actorId, buildInput, normalize }`. |
| `sources/indeed-apify.mjs` (new) | Indeed adapter `{ id, actorId, buildInput, normalize }`. |
| `search.mjs` (new) | `deriveCriteria()`, `loadProfile()`, CLI orchestrator. |
| `.gitignore` (edit) | Add `.env.local`. |
| `.env.example` (edit) | Document `APIFY_API_TOKEN`. |
| `package.json` (edit) | Add `"search": "node search.mjs"`. |
| `modes/search.md` (new) | Agent-mode instructions (English). |
| `.claude/skills/career-ops/SKILL.md` (edit) | Add `search` to routing table + menu. |
| `test-all.mjs` (edit) | New tests; repoint one existing import to `pipeline-io.mjs`. |
| `README.md`, `CHANGELOG.md`, `AGENTS.md`, `CLAUDE.md` (edit) | Document the new command. |

**Convention note (verify before merge):** the Apify **output** field names used in each `normalize()` are mapped defensively (multiple fallbacks) because the actors' output schemas were not machine-verified during planning. Task 3 and Task 4 each include a checkpoint to confirm field names against the actor README / a real dataset sample and adjust the field map if needed. Tests use fixtures, so they stay valid regardless.

---

## Task 1: Extract shared pipeline helpers into `pipeline-io.mjs`

**Files:**
- Create: `pipeline-io.mjs`
- Modify: `scan.mjs` (delete moved functions + constants, add import)
- Modify: `test-all.mjs:511` (repoint `buildLocationFilter` import)

- [ ] **Step 1: Create `pipeline-io.mjs` with the helpers moved verbatim from `scan.mjs`**

Create `pipeline-io.mjs`:

```js
// pipeline-io.mjs — shared filter / dedup / pipeline-write helpers.
//
// Extracted from scan.mjs so both scan.mjs (zero-cost ATS scanner) and
// search.mjs (paid Apify search) write identical pipeline.md / scan-history.tsv
// formats and share one dedup brain. Behavior is identical to the original
// scan.mjs definitions.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';

export const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
export const PIPELINE_PATH = 'data/pipeline.md';
export const APPLICATIONS_PATH = 'data/applications.md';

// ── Title filter ────────────────────────────────────────────────────
export function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = String(title || '').toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Location filter ─────────────────────────────────────────────────
function normalizeKeywordList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .filter(k => typeof k === 'string')
    .map(k => k.toLowerCase().trim())
    .filter(Boolean);
}

export function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => true;
  const alwaysAllow = normalizeKeywordList(locationFilter.always_allow);
  const allow = normalizeKeywordList(locationFilter.allow);
  const block = normalizeKeywordList(locationFilter.block);

  return (location) => {
    if (typeof location !== 'string' || location.trim() === '') return true;
    const lower = location.toLowerCase();
    if (alwaysAllow.length > 0 && alwaysAllow.some(k => lower.includes(k))) return true;
    if (block.length > 0 && block.some(k => lower.includes(k))) return false;
    if (allow.length === 0) return true;
    return allow.some(k => lower.includes(k));
  };
}

// ── Dedup ───────────────────────────────────────────────────────────
export function loadSeenUrls() {
  const seen = new Set();

  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) {
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

export function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Writers ─────────────────────────────────────────────────────────
export function appendToPipeline(offers) {
  if (offers.length === 0) return;
  mkdirSync('data', { recursive: true });

  let text = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf-8') : '';

  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;
    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

export function appendToScanHistory(offers, date, status = 'added') {
  mkdirSync('data', { recursive: true });
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\t${status}\t${o.location || ''}`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}
```

> Note: `appendToPipeline` here adds an `existsSync` guard (original assumed the file existed). This is behavior-preserving when the file exists and merely makes a fresh run safe.

- [ ] **Step 2: Edit `scan.mjs` — add the import, delete the moved definitions**

At the top of `scan.mjs`, the existing imports include:
```js
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
```
Leave that line as-is. Immediately after the existing `import { makeHttpCtx } from './providers/_http.mjs';` line, add:
```js
import {
  SCAN_HISTORY_PATH,
  PIPELINE_PATH,
  APPLICATIONS_PATH,
  buildTitleFilter,
  buildLocationFilter,
  loadSeenUrls,
  loadSeenCompanyRoles,
  appendToPipeline,
  appendToScanHistory,
} from './pipeline-io.mjs';
```

Then **delete** these now-duplicated pieces from `scan.mjs`:
- The three constants `const SCAN_HISTORY_PATH = ...`, `const PIPELINE_PATH = ...`, `const APPLICATIONS_PATH = ...`.
- The entire functions `buildTitleFilter`, `normalizeKeywordList`, `buildLocationFilter` (including its `export` keyword), `loadSeenUrls`, `loadSeenCompanyRoles`, `appendToPipeline`, `appendToScanHistory`.

Keep everything else (provider loading, `verifyOffers`, `main`, etc.) untouched. Keep the `const PORTALS_PATH = ...` and `mkdirSync('data', { recursive: true })` lines.

- [ ] **Step 3: Repoint the existing test import in `test-all.mjs`**

At `test-all.mjs:511`, change:
```js
  const { buildLocationFilter } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);
```
to:
```js
  const { buildLocationFilter } = await import(pathToFileURL(join(ROOT, 'pipeline-io.mjs')).href);
```

- [ ] **Step 4: Run the full suite to verify the extraction is behavior-preserving**

Run: `node test-all.mjs --quick`
Expected: all existing location-filter tests still PASS; syntax checks PASS for the new `pipeline-io.mjs`; `0 failed`.

- [ ] **Step 5: Verify `scan.mjs` still runs**

Run: `node scan.mjs --dry-run --company Anthropic`
Expected: it loads providers and runs without `ReferenceError` (it may print errors about missing `portals.yml` in a fresh checkout — that is fine; the point is no crash from the refactor).

- [ ] **Step 6: Commit**

```bash
git add pipeline-io.mjs scan.mjs test-all.mjs
git commit -m "refactor(scan): extract shared pipeline-io helpers for reuse by search"
```

---

## Task 2: Apify transport (`sources/_apify.mjs`) + types

**Files:**
- Create: `sources/_apify.mjs`
- Create: `sources/_types.js`
- Test: `test-all.mjs` (new section 13a)

- [ ] **Step 1: Write the failing test for `mapApifyError`**

Append a new section to `test-all.mjs` immediately before the `// ── SUMMARY ──` block:

```js
// ── 13. JOB SEARCH (Apify) ──────────────────────────────────────

console.log('\n13. Job search — Apify transport');

try {
  const { mapApifyError } = await import(pathToFileURL(join(ROOT, 'sources/_apify.mjs')).href);

  const e408 = mapApifyError(408, '');
  if (/too broad|--max|narrow/i.test(e408.message)) {
    pass('mapApifyError(408) explains broad-search timeout');
  } else {
    fail(`mapApifyError(408) wrong message: ${e408.message}`);
  }

  const e402 = mapApifyError(402, '');
  if (/payment|credit|plan/i.test(e402.message)) {
    pass('mapApifyError(402) explains billing');
  } else {
    fail(`mapApifyError(402) wrong message: ${e402.message}`);
  }

  const e401 = mapApifyError(401, '');
  if (/auth|token/i.test(e401.message)) {
    pass('mapApifyError(401) explains auth/token');
  } else {
    fail(`mapApifyError(401) wrong message: ${e401.message}`);
  }
} catch (e) {
  fail(`Apify transport tests crashed: ${e.message}`);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-all.mjs --quick`
Expected: FAIL — `Apify transport tests crashed: Cannot find module .../sources/_apify.mjs`.

- [ ] **Step 3: Create `sources/_types.js`**

```js
// Type catalog for the search source contract (JSDoc-only, no runtime).
// Files prefixed with _ are never loaded as adapters.

/**
 * @typedef {object} Criteria
 * @property {string[]} keywords    Non-empty role keywords.
 * @property {string}   location    Free-text location ('' if unknown).
 * @property {string}   country     ISO-3166 alpha-2, lowercase (e.g. 'us').
 * @property {('remote'|undefined)} remote
 * @property {number}   postedDays  Freshness window in days.
 */

/**
 * @typedef {object} BuildOpts
 * @property {number} maxItems  Per-source charged-item cap.
 */

/**
 * @typedef {object} Job
 * @property {string} title
 * @property {string} url
 * @property {string} company
 * @property {string} location
 */

/**
 * @typedef {object} SearchSource
 * @property {string} id                                  Unique adapter id ('linkedin' | 'indeed').
 * @property {string} actorId                             Apify tilde id.
 * @property {(c: Criteria, o: BuildOpts) => object} buildInput   Actor input builder.
 * @property {(items: unknown) => Job[]} normalize        Dataset → normalized jobs.
 */

export {};
```

- [ ] **Step 4: Create `sources/_apify.mjs`**

```js
// @ts-check
// Apify transport for paid job-source actors. Files prefixed with _ are
// never loaded as adapters by search.mjs.

const APIFY_ACTORS_BASE = 'https://api.apify.com/v2/actors';
const SYNC_TIMEOUT_MS = 300_000; // Apify sync endpoint hard-caps at 300s → 408.

/**
 * Translate an Apify HTTP error status into an actionable Error.
 * @param {number} status
 * @param {string} [bodySnippet]
 * @returns {Error}
 */
export function mapApifyError(status, bodySnippet = '') {
  if (status === 408) {
    return new Error('Apify run timed out (>300s) — search too broad. Lower --max or narrow keywords.');
  }
  if (status === 402) {
    return new Error('Apify payment required — check your plan/credits at console.apify.com.');
  }
  if (status === 401 || status === 403) {
    return new Error('Apify auth failed — verify APIFY_API_TOKEN in .env.local (see .env.example).');
  }
  const snippet = String(bodySnippet).replace(/\s+/g, ' ').trim().slice(0, 200);
  return new Error(`Apify request failed (HTTP ${status})${snippet ? `: ${snippet}` : ''}`);
}

/**
 * Run an actor synchronously and return its dataset items.
 * @param {string} actorId  Tilde id, e.g. 'borderline~indeed-scraper'.
 * @param {object} input    Actor input (the POST body).
 * @param {{token:string, maxItems:number, maxTotalChargeUsd:number, timeoutMs?:number, fetchImpl?:typeof fetch}} opts
 * @returns {Promise<unknown[]>}
 */
export async function runActorSync(actorId, input, opts) {
  const { token, maxItems, maxTotalChargeUsd, timeoutMs = SYNC_TIMEOUT_MS, fetchImpl = fetch } = opts;
  if (!token) {
    throw new Error('APIFY_API_TOKEN missing — add it to .env.local (see .env.example).');
  }
  const params = new URLSearchParams({
    maxItems: String(maxItems),
    maxTotalChargeUsd: String(maxTotalChargeUsd),
    format: 'json',
  });
  const url = `${APIFY_ACTORS_BASE}/${actorId}/run-sync-get-dataset-items?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw mapApifyError(res.status, text);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node test-all.mjs --quick`
Expected: PASS — the three `mapApifyError` assertions pass; `0 failed`.

- [ ] **Step 6: Commit**

```bash
git add sources/_apify.mjs sources/_types.js test-all.mjs
git commit -m "feat(search): add Apify sync transport + source type contract"
```

---

## Task 3: LinkedIn source adapter

**Files:**
- Create: `sources/linkedin-apify.mjs`
- Test: `test-all.mjs` (extend section 13)

- [ ] **Step 1: Write the failing test**

Append to the section 13 `try` block in `test-all.mjs` (before its `} catch`):

```js
  const linkedin = (await import(pathToFileURL(join(ROOT, 'sources/linkedin-apify.mjs')).href)).default;

  const liInput = linkedin.buildInput(
    { keywords: ['AI Engineer', 'LLM'], location: 'Madrid', country: 'es', remote: undefined, postedDays: 7 },
    { maxItems: 100 },
  );
  const liUrl = liInput.urls?.[0] || '';
  if (liUrl.includes('linkedin.com/jobs/search') &&
      liUrl.includes('f_TPR=r604800') &&
      /keywords=AI(\+|%20)Engineer/.test(liUrl) &&
      liInput.scrapeCompany === false &&
      liInput.count === 100) {
    pass('linkedin.buildInput builds a 7-day search URL, scrapeCompany off, count honored');
  } else {
    fail(`linkedin.buildInput wrong: ${JSON.stringify(liInput)}`);
  }

  const liMin = linkedin.buildInput(
    { keywords: ['AI'], location: '', country: 'us', remote: undefined, postedDays: 7 },
    { maxItems: 3 },
  );
  if (liMin.count === 10) {
    pass('linkedin.buildInput clamps count up to the actor minimum (10)');
  } else {
    fail(`linkedin.buildInput did not clamp count: ${liMin.count}`);
  }

  const liJobs = linkedin.normalize([
    { title: 'Senior AI Engineer', jobUrl: 'https://linkedin.com/jobs/view/1', companyName: 'Acme', location: 'Madrid' },
    { title: '', jobUrl: 'https://linkedin.com/jobs/view/2', companyName: 'NoTitle' }, // dropped
    { title: 'ML Eng', companyName: 'NoUrl' }, // dropped (no url)
  ]);
  if (liJobs.length === 1 && liJobs[0].url === 'https://linkedin.com/jobs/view/1' &&
      liJobs[0].company === 'Acme' && liJobs[0].location === 'Madrid') {
    pass('linkedin.normalize maps fields and drops malformed items');
  } else {
    fail(`linkedin.normalize wrong: ${JSON.stringify(liJobs)}`);
  }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-all.mjs --quick`
Expected: FAIL — `Cannot find module .../sources/linkedin-apify.mjs`.

- [ ] **Step 3: Create `sources/linkedin-apify.mjs`**

```js
// @ts-check
/** @typedef {import('./_types.js').SearchSource} SearchSource */

// LinkedIn jobs via Apify actor curious_coder/linkedin-jobs-scraper ($1/1k).
// The actor needs LinkedIn *search* URLs, so buildInput constructs one from
// the derived criteria. f_TPR=r<seconds> is LinkedIn's "date posted" filter.

const SECONDS_PER_DAY = 86_400;
const COUNT_MIN = 10; // actor input minimum for `count`.

function buildSearchUrl({ keywords, location, postedDays }) {
  const params = new URLSearchParams();
  params.set('keywords', keywords.join(' OR '));
  if (location) params.set('location', location);
  if (postedDays > 0) params.set('f_TPR', `r${postedDays * SECONDS_PER_DAY}`);
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

/** @type {SearchSource} */
export default {
  id: 'linkedin',
  actorId: 'curious_coder~linkedin-jobs-scraper',

  buildInput(criteria, { maxItems }) {
    return {
      urls: [buildSearchUrl(criteria)],
      scrapeCompany: false, // actor default is true → extra requests, slower, pricier.
      count: Math.max(COUNT_MIN, maxItems),
    };
  },

  // Output field names are mapped defensively (see plan "Convention note").
  normalize(items) {
    if (!Array.isArray(items)) return [];
    return items
      .map((it) => ({
        title: String(it.title || it.jobTitle || '').trim(),
        url: String(it.jobUrl || it.link || it.url || '').trim(),
        company: String(it.companyName || it.company || it.companyUrl || '').trim(),
        location: String(it.location || it.place || it.formattedLocation || '').trim(),
      }))
      .filter((j) => j.title && j.url);
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-all.mjs --quick`
Expected: PASS — all three LinkedIn assertions pass; `0 failed`.

- [ ] **Step 5: Checkpoint — verify output field names**

Open the actor README at https://apify.com/curious_coder/linkedin-jobs-scraper (the "JSON example" / output section) OR run one real 10-item search later (Task 6) and inspect a dataset item. Confirm the keys used in `normalize` (`title`, `jobUrl`, `companyName`, `location`). If a key differs, add it to the corresponding fallback chain. The fixture tests remain valid either way.

- [ ] **Step 6: Commit**

```bash
git add sources/linkedin-apify.mjs test-all.mjs
git commit -m "feat(search): add LinkedIn Apify source adapter"
```

---

## Task 4: Indeed source adapter

**Files:**
- Create: `sources/indeed-apify.mjs`
- Test: `test-all.mjs` (extend section 13)

- [ ] **Step 1: Write the failing test**

Append to the section 13 `try` block in `test-all.mjs` (before its `} catch`):

```js
  const indeed = (await import(pathToFileURL(join(ROOT, 'sources/indeed-apify.mjs')).href)).default;

  const inInput = indeed.buildInput(
    { keywords: ['AI Engineer', 'LLM'], location: 'Remote', country: 'us', remote: 'remote', postedDays: 7 },
    { maxItems: 80 },
  );
  if (inInput.query.includes('AI Engineer') &&
      inInput.location === 'Remote' &&
      inInput.country === 'us' &&
      inInput.remote === 'remote' &&
      inInput.fromDays === '7' &&
      inInput.maxRows === 80) {
    pass('indeed.buildInput maps query/location/country/remote/fromDays/maxRows');
  } else {
    fail(`indeed.buildInput wrong: ${JSON.stringify(inInput)}`);
  }

  const inJobs = indeed.normalize([
    { positionName: 'AI Engineer', url: 'https://indeed.com/viewjob?jk=1', company: 'Beta', location: 'Remote' },
    { positionName: 'X', company: 'NoUrl' }, // dropped
  ]);
  if (inJobs.length === 1 && inJobs[0].title === 'AI Engineer' &&
      inJobs[0].url === 'https://indeed.com/viewjob?jk=1' && inJobs[0].company === 'Beta') {
    pass('indeed.normalize maps fields and drops malformed items');
  } else {
    fail(`indeed.normalize wrong: ${JSON.stringify(inJobs)}`);
  }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-all.mjs --quick`
Expected: FAIL — `Cannot find module .../sources/indeed-apify.mjs`.

- [ ] **Step 3: Create `sources/indeed-apify.mjs`**

```js
// @ts-check
/** @typedef {import('./_types.js').SearchSource} SearchSource */

// Indeed jobs via Apify actor borderline/indeed-scraper ($5/1k). This actor
// takes plain query/location/country — no search-URL building needed.

/** @type {SearchSource} */
export default {
  id: 'indeed',
  actorId: 'borderline~indeed-scraper',

  buildInput(criteria, { maxItems }) {
    /** @type {Record<string, unknown>} */
    const input = {
      query: criteria.keywords.join(' '),
      location: criteria.location || '',
      country: criteria.country || 'us',
      fromDays: String(criteria.postedDays),
      maxRows: maxItems,
      sort: 'date',
    };
    if (criteria.remote === 'remote') input.remote = 'remote';
    return input;
  },

  // Output field names are mapped defensively (see plan "Convention note").
  normalize(items) {
    if (!Array.isArray(items)) return [];
    return items
      .map((it) => ({
        title: String(it.positionName || it.title || it.jobTitle || '').trim(),
        url: String(it.url || it.jobUrl || it.link || '').trim(),
        company: String(it.company || it.companyName || '').trim(),
        location: String(it.location || it.formattedLocation || '').trim(),
      }))
      .filter((j) => j.title && j.url);
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-all.mjs --quick`
Expected: PASS — both Indeed assertions pass; `0 failed`.

- [ ] **Step 5: Checkpoint — verify output field names**

Confirm `positionName` / `url` / `company` / `location` against the actor README at https://apify.com/borderline/indeed-scraper (JSON example) or a real dataset item from Task 6. Adjust the fallback chains if needed.

- [ ] **Step 6: Commit**

```bash
git add sources/indeed-apify.mjs test-all.mjs
git commit -m "feat(search): add Indeed Apify source adapter"
```

---

## Task 5: Criteria derivation (`deriveCriteria` + `loadProfile`)

**Files:**
- Create: `search.mjs` (criteria functions + exports only — orchestrator added in Task 6)
- Test: `test-all.mjs` (extend section 13)

- [ ] **Step 1: Write the failing test**

Append to the section 13 `try` block in `test-all.mjs` (before its `} catch`):

```js
  const { deriveCriteria } = await import(pathToFileURL(join(ROOT, 'search.mjs')).href);

  const c = deriveCriteria({
    target_roles: { primary: ['Senior AI Engineer'], archetypes: [{ name: 'Solutions Architect' }] },
    location: { city: 'Madrid', country: 'Spain' },
    compensation: { location_flexibility: 'Remote preferred' },
  }, {});
  if (c.keywords.includes('Senior AI Engineer') && c.keywords.includes('Solutions Architect') &&
      c.location === 'Madrid' && c.country === 'es' && c.remote === 'remote' && c.postedDays === 7) {
    pass('deriveCriteria maps roles, archetypes, location, country code, remote, default freshness');
  } else {
    fail(`deriveCriteria wrong: ${JSON.stringify(c)}`);
  }

  const cOverride = deriveCriteria({}, { keywords: 'ML Engineer, Data Scientist', postedDays: 1 });
  if (cOverride.keywords.length === 2 && cOverride.keywords[0] === 'ML Engineer' &&
      cOverride.country === 'us' && cOverride.postedDays === 1) {
    pass('deriveCriteria honors --keywords/--posted-days overrides and defaults country to us');
  } else {
    fail(`deriveCriteria overrides wrong: ${JSON.stringify(cOverride)}`);
  }

  let refused = false;
  try { deriveCriteria({}, {}); } catch { refused = true; }
  if (refused) {
    pass('deriveCriteria refuses empty criteria (no roles, no --keywords)');
  } else {
    fail('deriveCriteria did not refuse empty criteria');
  }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-all.mjs --quick`
Expected: FAIL — `Cannot find module .../search.mjs`.

- [ ] **Step 3: Create `search.mjs` with the criteria layer**

```js
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
  if (Array.isArray(value)) return value.map((k) => String(k).trim()).filter(Boolean);
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
  return COUNTRY_NAME_TO_ISO2[countryName.toLowerCase().trim()] || DEFAULT_COUNTRY;
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
  return yaml.load(readFileSync(p, 'utf-8')) || {};
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-all.mjs --quick`
Expected: PASS — all three `deriveCriteria` assertions pass; `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add search.mjs test-all.mjs
git commit -m "feat(search): derive search criteria from profile with overrides"
```

---

## Task 6: Orchestrator + CLI (`search.mjs` main)

**Files:**
- Modify: `search.mjs` (add pricing, cost estimate, CLI, `main`)
- Test: `test-all.mjs` (extend section 13 with a dry-run integration check)

- [ ] **Step 1: Write the failing test (dry-run does zero network I/O and exits 0)**

Append to the section 13 `try` block in `test-all.mjs` (before its `} catch`):

```js
  // Dry-run must succeed with NO token and NO network: --keywords bypasses the
  // profile dependency, --dry-run returns before any Apify call.
  const dryEnv = { ...process.env };
  delete dryEnv.APIFY_API_TOKEN;
  const dryOut = run(NODE, ['search.mjs', '--dry-run', '--keywords', 'AI Engineer', '--max', '25'],
    { env: dryEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  if (dryOut !== null && /dry run/i.test(dryOut) && /AI Engineer/.test(dryOut)) {
    pass('search.mjs --dry-run prints criteria and cost estimate without a token or network');
  } else {
    fail(`search.mjs --dry-run failed or missing output: ${String(dryOut).slice(0, 200)}`);
  }

  const { estimateCostUsd } = await import(pathToFileURL(join(ROOT, 'search.mjs')).href);
  const est = estimateCostUsd('linkedin', 1000);
  if (Math.abs(est - 1.0) < 1e-9) {
    pass('estimateCostUsd(linkedin, 1000) = $1.00');
  } else {
    fail(`estimateCostUsd wrong: ${est}`);
  }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-all.mjs --quick`
Expected: FAIL — `estimateCostUsd` is not exported yet and/or `--dry-run` is unrecognized (no `main`).

- [ ] **Step 3: Append the orchestrator to `search.mjs`**

Add these imports to the existing import block at the top of `search.mjs`:
```js
import {
  buildTitleFilter,
  buildLocationFilter,
  loadSeenUrls,
  loadSeenCompanyRoles,
  appendToPipeline,
  appendToScanHistory,
  PIPELINE_PATH,
  SCAN_HISTORY_PATH,
} from './pipeline-io.mjs';
import { runActorSync } from './sources/_apify.mjs';
import linkedinSource from './sources/linkedin-apify.mjs';
import indeedSource from './sources/indeed-apify.mjs';
import { config as loadDotenv } from 'dotenv';
```

Then append to the end of `search.mjs`:

```js
// ── Sources & pricing ───────────────────────────────────────────────
const SOURCES = { linkedin: linkedinSource, indeed: indeedSource };
const PRICE_PER_1000_USD = { linkedin: 1.0, indeed: 5.0 };

export const DEFAULT_MAX_ITEMS = 100;
export const MAX_ITEMS_CEILING = 500;
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';

/** Worst-case cost for a source at a given item cap. */
export function estimateCostUsd(sourceId, maxItems) {
  const price = PRICE_PER_1000_USD[sourceId] || 0;
  return (maxItems / 1000) * price;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const has = (f) => args.includes(f);
  const val = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : undefined; };

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
  const cfg = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
  return {
    titleFilter: buildTitleFilter(cfg.title_filter),
    locationFilter: buildLocationFilter(cfg.location_filter),
  };
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

  // Dry run: show inputs + cost estimate, never touch the network.
  if (opts.dryRun) {
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
    return;
  }

  // Live run: token required.
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

  const rawJobs = [];
  const errors = [];
  let totalFound = 0;
  for (const id of opts.sourceIds) {
    const source = SOURCES[id];
    try {
      const input = source.buildInput(criteria, { maxItems: opts.maxItems });
      const maxTotalChargeUsd = Math.max(1, Math.ceil(estimateCostUsd(id, opts.maxItems) * 2));
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

  // Filter → dedup.
  let filteredTitle = 0, filteredLocation = 0, dupes = 0;
  const newOffers = [];
  for (const job of rawJobs) {
    if (!titleFilter(job.title)) { filteredTitle++; continue; }
    if (!locationFilter(job.location)) { filteredLocation++; continue; }
    if (seenUrls.has(job.url)) { dupes++; continue; }
    const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
    if (seenCompanyRoles.has(key)) { dupes++; continue; }
    seenUrls.add(job.url);
    seenCompanyRoles.add(key);
    newOffers.push(job);
  }

  if (newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // Summary.
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

  // Exit non-zero only if every requested source failed.
  if (errors.length === opts.sourceIds.length) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-all.mjs --quick`
Expected: PASS — dry-run integration test and `estimateCostUsd` test pass; `0 failed`.

- [ ] **Step 5: Manual smoke (dry-run)**

Run: `node search.mjs --dry-run --keywords "AI Engineer,LLM" --max 50`
Expected: prints criteria, a `linkedin` input with `f_TPR=r604800`, an `indeed` input, and `Worst-case total: ≤ $0.30`. No network call.

- [ ] **Step 6: Commit**

```bash
git add search.mjs test-all.mjs
git commit -m "feat(search): orchestrator CLI with dry-run, cost guardrails, pipeline feed"
```

---

## Task 7: Security + config wiring

**Files:**
- Modify: `.gitignore`
- Modify: `.env.example`
- Modify: `package.json`

- [ ] **Step 1: Gitignore `.env.local`**

In `.gitignore`, find:
```
# Secrets (never commit — use .env.example as template)
.env
```
Replace with:
```
# Secrets (never commit — use .env.example as template)
.env
.env.local
```

- [ ] **Step 2: Verify the token file is now ignored**

Run: `git check-ignore .env.local`
Expected: prints `.env.local` (i.e. it is ignored). If it was ever tracked, also run `git rm --cached .env.local` (only if `git ls-files --error-unmatch .env.local` succeeds).

- [ ] **Step 3: Document the token in `.env.example`**

Append to `.env.example`:
```
# ── Apify Integration (autonomous job search: /career-ops search) ────────────
# Required for: node search.mjs   (LinkedIn + Indeed via Apify actors)
# Get a token at https://console.apify.com/account#/integrations
# Store it in .env.local (gitignored), NOT .env.example.
APIFY_API_TOKEN=your_apify_api_token_here
```

- [ ] **Step 4: Add the npm script**

In `package.json`, in `"scripts"`, after the `"scan": "node scan.mjs",` line add:
```json
    "search": "node search.mjs",
```

- [ ] **Step 5: Verify**

Run: `node test-all.mjs --quick`
Expected: syntax + JSON checks pass; `0 failed`. (`package.json` must remain valid JSON.)

- [ ] **Step 6: Commit**

```bash
git add .gitignore .env.example package.json
git commit -m "chore(search): gitignore .env.local, document APIFY_API_TOKEN, add npm script"
```

---

## Task 8: Agent mode + skill routing

**Files:**
- Create: `modes/search.md`
- Modify: `.claude/skills/career-ops/SKILL.md`

- [ ] **Step 1: Create `modes/search.md`**

```markdown
# Mode: search — Autonomous Job Search (LinkedIn + Indeed via Apify)

Search LinkedIn and Indeed for jobs matching the user's CV/profile using paid
Apify actors, then feed fresh, deduplicated matches into `data/pipeline.md` for
evaluation. **Feed-only** — scoring stays in `/career-ops pipeline`.

> **Paid:** LinkedIn ≈ $1 / 1,000 results, Indeed ≈ $5 / 1,000 jobs. Always
> show the user the dry-run cost estimate before the first paid run of a session.

## Prerequisites

- `APIFY_API_TOKEN` in `.env.local` (see `.env.example`). If missing, tell the
  user where to get it and stop.
- `config/profile.yml` with `target_roles.primary` (criteria are auto-derived).

## Recommended execution

Run as a subagent so it doesn't consume main context:

```
Agent(
  subagent_type="general-purpose",
  prompt="[contents of modes/_shared.md + this file + invocation args]",
  description="career-ops search"
)
```

## Workflow

1. **Enrich keywords (optional).** Read `cv.md` to pull 3–6 high-signal role
   keywords; pass them via `--keywords "A,B,C"`. Otherwise criteria come from
   `config/profile.yml` automatically.
2. **Dry run first.** Execute `node search.mjs --dry-run [--keywords ...]` and
   show the user the derived criteria + worst-case cost.
3. **Confirm, then run live.** On user OK, execute `node search.mjs [flags]`.
4. **Report.** Summarize new offers added and point the user to
   `/career-ops pipeline` to evaluate them.

## Flags

| Flag | Effect |
|------|--------|
| `--dry-run` | Print criteria + cost estimate, no API call, no spend. |
| `--source linkedin\|indeed` | Limit to one source. |
| `--max N` | Per-source result cap (default 100, ceiling 500). |
| `--posted-days N` | Freshness window (default 7). |
| `--keywords "A,B"` | Override derived keywords. |

## Cost guardrails

- Every live run sends `maxItems` + `maxTotalChargeUsd` so Apify caps spend
  server-side.
- Default 100 results/source ≈ $0.60 worst case for both sources.
- Never run live without showing the user the dry-run estimate first.

## Output

Matches are appended to `data/pipeline.md` (`## Pendientes`) and recorded in
`data/scan-history.tsv`. Dedup is shared with `/career-ops scan`, so re-runs
won't re-add known jobs.
```

- [ ] **Step 2: Add `search` to the SKILL.md routing table**

In `.claude/skills/career-ops/SKILL.md`, in the "Mode Routing" table, after the `| \`scan\` | \`scan\` |` row add:
```
| `search` | `search` |
```

In the `argument-hint` frontmatter line, add `search` to the list (after `scan`):
```
argument-hint: "[scan | search | deep | pdf | oferta | ofertas | apply | batch | tracker | pipeline | contacto | training | project | interview-prep | update]"
```

In the Discovery Mode menu block, after the `/career-ops scan` line add:
```
  /career-ops search    → Autonomous search (LinkedIn + Indeed via Apify, paid)
```

In "Context Loading by Mode", add `search` to the `_shared.md`-requiring list and to the subagent-delegated list (alongside `scan`):
- Change `Applies to: auto-pipeline, oferta, ofertas, pdf, contacto, apply, pipeline, scan, batch` → append `, search`.
- Change `For scan, apply (with Playwright), and pipeline (3+ URLs)` → `For scan, search, apply (with Playwright), and pipeline (3+ URLs)`.

- [ ] **Step 3: Verify**

Run: `node test-all.mjs --quick`
Expected: `0 failed` (these are doc/markdown edits; suite stays green).

- [ ] **Step 4: Commit**

```bash
git add modes/search.md .claude/skills/career-ops/SKILL.md
git commit -m "feat(search): add search agent mode + skill routing"
```

---

## Task 9: Documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md` (if present and maintained)
- Modify: `AGENTS.md`, `CLAUDE.md` (Main Files table + mode table)

- [ ] **Step 1: README — document the command**

Add a short subsection under the existing scanning/commands area:
```markdown
### Autonomous search (`/career-ops search`)

Search LinkedIn + Indeed for jobs matching your profile via Apify and feed
matches into your pipeline. Paid (LinkedIn ≈ $1/1k, Indeed ≈ $5/1k).

1. Add `APIFY_API_TOKEN` to `.env.local` (see `.env.example`).
2. Preview cost: `node search.mjs --dry-run`
3. Run: `node search.mjs` (or `npm run search`)
4. Evaluate: `/career-ops pipeline`

Flags: `--dry-run`, `--source linkedin|indeed`, `--max N` (default 100,
ceiling 500), `--posted-days N` (default 7), `--keywords "A,B"`.
```

- [ ] **Step 2: CHANGELOG — add an entry (only if the repo maintains one manually)**

Inspect the top of `CHANGELOG.md`. If entries are hand-written (not purely release-please-generated), add under an Unreleased/feat heading:
```markdown
* **search:** autonomous LinkedIn + Indeed job search via Apify (`/career-ops search`, `node search.mjs`), feed-only into the pipeline with cost guardrails.
```
If the changelog is fully auto-generated, skip and note "CHANGELOG auto-generated — skipped" in the commit body.

- [ ] **Step 3: AGENTS.md + CLAUDE.md — register the mode and file**

In both files: add `search.mjs` to the "Main Files" table:
```
| `search.mjs` | Autonomous LinkedIn + Indeed search via Apify (paid). Feeds pipeline.md. |
```
And add a row to the "Skill Modes" table:
```
| Searches LinkedIn/Indeed via Apify for matching jobs | `search` |
```

- [ ] **Step 4: Verify**

Run: `node test-all.mjs --quick`
Expected: `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md AGENTS.md CLAUDE.md
git commit -m "docs(search): document autonomous job search command"
```

---

## Task 10: Full verification

- [ ] **Step 1: Run the complete suite (not just --quick)**

Run: `node test-all.mjs`
Expected: `🟢 All tests passed` (or passed-with-warnings for pre-existing warnings unrelated to this work). `0 failed`.

- [ ] **Step 2: Final dry-run smoke across both sources**

Run: `node search.mjs --dry-run --keywords "AI Engineer,Solutions Architect" --max 100 --posted-days 7`
Expected: both source inputs printed, LinkedIn URL contains `f_TPR=r604800`, worst-case total `≤ $0.60`, zero network.

- [ ] **Step 3 (optional, costs money): one real minimal live run to confirm field names**

Only with the user's explicit OK and a valid token:
Run: `node search.mjs --source linkedin --max 10`
Expected: prints `[linkedin] N job(s)` and adds offers to `pipeline.md`. Inspect one added row; if `company`/`title`/`location` look empty, revisit the Task 3/4 normalize field maps. Repeat for `--source indeed --max 10`.

---

## Self-Review Checklist (completed by plan author)

- **Spec coverage:** standalone command (T6) ✓, source-adapter pattern (T2–4) ✓, auto-derive criteria (T5) ✓, feed-only (T6 appendToPipeline, no scoring) ✓, reuse scanner logic via pipeline-io (T1) ✓, balanced guardrails: maxItems+maxTotalChargeUsd+dry-run+ceiling (T2,T6) ✓, `.env.local` gitignore + `.env.example` (T7) ✓, 7-day freshness default (T3/T5) ✓, 100/source default (T6) ✓, error handling 408/402/one-source-fails/empty-criteria (T2,T5,T6) ✓, tests (T2–6) ✓, agent mode + routing (T8) ✓, docs (T9) ✓.
- **Placeholders:** none — every code step has complete code; the two "verify field names" steps are explicit verification checkpoints (defensive fallbacks already in place), not deferred implementation.
- **Type consistency:** `Criteria` shape `{keywords,location,country,remote,postedDays}` consistent across `deriveCriteria` (T5), both `buildInput` (T3/T4), and `main` (T6). Adapter shape `{id,actorId,buildInput,normalize}` consistent. `estimateCostUsd`, `DEFAULT_MAX_ITEMS`, `MAX_ITEMS_CEILING` defined once in T6 and used consistently.
