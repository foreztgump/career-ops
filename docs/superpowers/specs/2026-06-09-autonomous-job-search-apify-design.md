# Design: Autonomous Job Search via Apify

**Date:** 2026-06-09
**Status:** Approved (pending implementation plan)
**Mode:** `/career-ops search` + `node search.mjs`

## Summary

A new standalone command that autonomously searches **LinkedIn** and **Indeed**
for jobs matching the user's CV/profile, filters them through the existing
relevance logic, and drops fresh, deduplicated matches into `data/pipeline.md`
for evaluation by the existing `/career-ops pipeline` flow.

It is **feed-only**: discovery stops at populating the pipeline. Deep A–F
CV-fit scoring stays in the existing (token-costing) evaluator, keeping **paid
discovery** and **token-costing evaluation** cleanly separated.

Job data is fetched via two paid [Apify](https://apify.com) actors:

| Source | Actor (tilde id) | Price |
|--------|------------------|-------|
| LinkedIn | `curious_coder~linkedin-jobs-scraper` | $1.00 / 1,000 results |
| Indeed | `borderline~indeed-scraper` | $5.00 / 1,000 jobs |

## Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Run outcome | **Feed only** — deduped matches into `pipeline.md`; no auto-evaluation |
| 2 | Targeting | **Auto-derive** from `cv.md` + `config/profile.yml` (hands-off, zero config) |
| 3 | Cost guardrails | **Balanced** — sensible caps always sent, no per-run prompt, `--dry-run` available |
| 4 | Integration shape | **Standalone** `search.mjs` + `/career-ops search` (not Apify-as-scanner-provider) |
| 5 | Internal structure | **Source-adapter pattern** — one file per source under `sources/` |
| 6 | Security fix | **Yes** — gitignore `.env.local`, document `APIFY_API_TOKEN` in `.env.example` |
| 7 | Freshness default | **Last 7 days** (overridable via `--posted-days`) |
| 8 | Default per-source cap | **100 results/source** (overridable via `--max`; hard ceiling 500) |

## Why standalone (not a scanner provider)

`scan.mjs` and its `providers/*.mjs` are **company-driven**, **synchronous**,
and branded **zero-token / zero-cost** — each provider fetches one company's
public ATS board via a one-shot `fetchJson`. The Apify actors are the opposite:
**query-driven** (search all of LinkedIn/Indeed by role + location) and **paid**.
Folding paid, query-driven sources into the zero-cost scanner would break its
core guarantee. A standalone command isolates the paid/query-driven concern
while **reusing** the scanner's filter/dedup/pipeline-write logic.

## Architecture & Data Flow

```
config/profile.yml ──┐
cv.md (agent mode) ───┼──► deriveCriteria() ──► { keywords[], location, country, remote, postedDays }
portals.yml filters ──┘                              │
                                                     ▼
                            ┌──────── search.mjs (orchestrator) ────────┐
                            │  for each enabled source adapter:         │
                            │    1. buildInput(criteria, caps)          │
                            │    2. POST run-sync-get-dataset-items      │ ◄── APIFY_API_TOKEN (.env.local)
                            │    3. normalize(items) → Job[]             │
                            └───────────────────────────────────────────┘
                                                     │  raw Job[]
                                                     ▼
              title_filter ─► location_filter ─► dedup(3 sources) ─► appendToPipeline + appendToScanHistory
                                                     │
                                                     ▼
                                    data/pipeline.md  →  /career-ops pipeline (existing evaluator)
```

**Reused, not reinvented.** `buildTitleFilter`, `buildLocationFilter`,
`loadSeenUrls`, `loadSeenCompanyRoles`, `appendToPipeline`, and
`appendToScanHistory` currently live inside `scan.mjs`. They will be extracted
into a shared `pipeline-io.mjs` and imported by **both** `scan.mjs` and
`search.mjs`, so the two commands write identical pipeline/history formats and
share one dedup brain. The extraction is behavior-preserving — `scan.mjs`'s
observable output is unchanged.

## Components & Files

| File | Status | Purpose |
|------|--------|---------|
| `search.mjs` | new | Orchestrator + CLI. Derive criteria → run adapters → filter → dedup → write. |
| `sources/linkedin-apify.mjs` | new | `{ id, buildInput, normalize }` — builds LinkedIn search URL, maps output. |
| `sources/indeed-apify.mjs` | new | `{ id, buildInput, normalize }` — query/location input, maps output. |
| `sources/_apify.mjs` | new | Shared Apify transport: POST `run-sync-get-dataset-items`, Bearer auth, `maxItems`/`maxTotalChargeUsd`, timeout, error mapping. `_`-prefixed = not an adapter. |
| `sources/_types.js` | new | JSDoc contract (`Criteria`, `SearchSource`), mirrors `providers/_types.js`. |
| `pipeline-io.mjs` | new | Extracted shared filter/dedup/write helpers. |
| `scan.mjs` | edit | Import helpers from `pipeline-io.mjs` instead of local defs (behavior unchanged). |
| `modes/search.md` | new | Agent-mode instructions (English), parallel to `modes/scan.md`. |
| `.claude/skills/career-ops/SKILL.md` | edit | Add `search` to routing table + discovery menu. |
| `.gitignore` | edit | Add `.env.local`. |
| `.env.example` | edit | Document `APIFY_API_TOKEN`. |
| `package.json` | edit | Add `"search": "node search.mjs"` script. |
| `test-all.mjs` | edit | Tests for criteria derivation, input building, normalization, filter reuse. |

### Source-adapter contract

```js
// sources/linkedin-apify.mjs
export default {
  id: 'linkedin',
  actorId: 'curious_coder~linkedin-jobs-scraper',
  buildInput(criteria, { maxItems }) { /* → actor input object */ },
  normalize(items) { /* → [{ title, url, company, location }] */ },
};
```

The two adapters differ exactly where the actors differ:

- **LinkedIn** — `buildInput` constructs a LinkedIn jobs search URL and wraps it:
  ```
  https://www.linkedin.com/jobs/search/?keywords=<kw>&location=<loc>&f_TPR=r604800
  ```
  `f_TPR=r<seconds>` is LinkedIn's "date posted" filter; `604800 = 7 days`.
  Actor input: `{ urls: [searchUrl], scrapeCompany: false, count: maxItems }`.
  `scrapeCompany` defaults to `true` in the actor (extra requests, slower,
  pricier) — we explicitly set it `false`.

- **Indeed** — `buildInput` maps criteria directly (no URL building):
  ```
  { query, location, country, remote, fromDays: '7', maxRows: maxItems }
  ```

Both `normalize()` map raw dataset items to the scanner's unit of currency:
`{ title, url, company, location }`, dropping items missing `title` or `url`.

## Apify transport (`sources/_apify.mjs`)

- Endpoint: `POST https://api.apify.com/v2/actors/{actorId}/run-sync-get-dataset-items`
- Query params: `?maxItems=<cap>&maxTotalChargeUsd=<ceiling>&format=json`
- Auth: `Authorization: Bearer ${APIFY_API_TOKEN}` (header — not query param)
- Body: the actor input object from `buildInput`
- Response: dataset items as a JSON array (returned directly by this endpoint)
- Timeout: client connection timeout > 300s (sync runs can take up to 5 min)
- `maxItems` caps **charged** items server-side; `maxTotalChargeUsd` is a
  second, absolute spend ceiling enforced by Apify regardless of result count.

## CLI & Cost Guardrails

```bash
node search.mjs                              # both sources, criteria from profile, 100/source, last 7d
node search.mjs --dry-run                    # build inputs + print derived criteria + cost ESTIMATE, no API call
node search.mjs --source linkedin            # one source only (linkedin | indeed)
node search.mjs --max 50                      # override per-source cap
node search.mjs --posted-days 1               # override freshness window
node search.mjs --keywords "AI Engineer,LLM"  # override derived keywords
```

Guardrails (decision #3 — balanced):

- Default **100 results/source**. Every run sends **both** `maxItems` and
  `maxTotalChargeUsd` so Apify enforces the ceiling server-side even if a
  result count is wrong.
- `--dry-run` prints derived criteria + worst-case cost
  (`100×$1/1k + 100×$5/1k ≈ $0.60`) and exits before any paid call (zero
  network I/O).
- Hard ceiling constant `MAX_ITEMS_CEILING = 500`; `--max` above it clamps
  with a warning.
- Missing/empty `APIFY_API_TOKEN` → clear error pointing to `.env.example`,
  exit 1, zero network.
- Token loaded via `dotenv` from `.env.local` (already a dependency; pattern
  from `gemini-eval.mjs`) into `process.env.APIFY_API_TOKEN`; **never** logged.

## Targeting / criteria derivation

`deriveCriteria()` runs with **zero config**:

- **Keywords** ← `config/profile.yml` `target_roles.primary` (+ archetype
  names as secondary keywords).
- **Location / country / remote** ← profile `location` block and
  `compensation.location_flexibility` / remote hints.
- **Post-filter** ← results still pass through the **existing**
  `title_filter` and `location_filter` from `portals.yml`, so search and scan
  apply identical relevance rules.

When invoked through the `/career-ops search` agent mode, the agent may read
`cv.md` to enrich keywords and pass them via `--keywords`. The user never
authors a dedicated search-criteria block.

## Error Handling & Edge Cases

- **408** (sync run > 300s): caught, mapped to a friendly "search too broad —
  lower `--max` or narrow keywords" message. The other source still runs.
- **402** (payment / credits): surfaced with a "check Apify billing" hint.
- **One source fails**: log the error, continue with the other (mirrors
  `scan.mjs`'s per-target try/catch). Exit non-zero only if **all** sources fail.
- **Empty criteria**: if no `target_roles.primary` and no `--keywords`, refuse
  to run (would burn budget on a junk-broad search) with guidance to fill the
  profile or pass `--keywords`.
- **Malformed actor item** (missing `url`/`title`): skipped, counted in the
  summary, never reaches the pipeline.
- **Dedup**: normalized URLs flow through the same `loadSeenUrls` /
  `loadSeenCompanyRoles` dedup, so re-runs won't re-add jobs already in
  `pipeline.md`, `applications.md`, or `scan-history.tsv`.

## Output summary (mirrors `scan.mjs`)

```
Job Search — 2026-06-09
━━━━━━━━━━━━━━━━━━━━━━━━━━
Sources searched:      2 (linkedin, indeed)
Total jobs found:      N
Filtered by title:     N removed
Filtered by location:  N removed
Duplicates:            N skipped
New offers added:      N

  + {company} | {title} | {location}
  ...

→ Run /career-ops pipeline to evaluate new offers.
```

## Testing & Verification

Pure-function tests in `test-all.mjs` (no live API calls — adapters tested
against fixture dataset items):

- `deriveCriteria()` maps profile → criteria correctly; refuses empty criteria.
- LinkedIn `buildInput` produces a valid URL-encoded search URL with the right
  `f_TPR` window, `scrapeCompany:false`, and respects `maxItems`.
- Indeed `buildInput` maps freshness / remote / country correctly.
- Both `normalize()` map fixtures → clean `{title,url,company,location}` and
  drop malformed items.
- `pipeline-io.mjs` extraction is a regression guard: existing `scan.mjs`
  tests still pass.
- `--dry-run` performs zero network I/O (a no-token run succeeds).

## Out of Scope (YAGNI)

- No auto-evaluation / scoring inside search (feed-only by decision #1).
- No async/polling Apify run mode — sync endpoint only (counts stay modest).
- No additional job sources yet (Glassdoor, etc.) — the adapter pattern makes
  them a later drop-in.
- No scheduling/cron — the user can wire the existing scheduling skills to
  `node search.mjs` if desired.
