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
