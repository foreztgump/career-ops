// @ts-check
// Apify transport for paid job-source actors. Files prefixed with _ are
// never loaded as adapters by search.mjs.

const APIFY_ACTORS_BASE = 'https://api.apify.com/v2/actors';
const SYNC_TIMEOUT_MS = 300_000; // Apify sync endpoint hard-caps at 300s → 408.
const MAX_ERROR_SNIPPET_CHARS = 200;

/**
 * Translate an Apify HTTP error status into an actionable Error.
 * @param {number} status
 * @param {string} [bodySnippet]
 * @returns {Error}
 */
export function mapApifyError(status, bodySnippet = '') {
  const make = (msg) => Object.assign(new Error(msg), { apifyMapped: true });
  if (status === 408) {
    return make('Apify run timed out (>300s) — search too broad. Lower --max or narrow keywords.');
  }
  if (status === 402) {
    return make('Apify payment required — check your plan/credits at console.apify.com.');
  }
  if (status === 401 || status === 403) {
    return make('Apify auth failed — verify APIFY_API_TOKEN in .env.local (see .env.example).');
  }
  const snippet = String(bodySnippet).replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_SNIPPET_CHARS);
  return make(`Apify request failed (HTTP ${status})${snippet ? `: ${snippet}` : ''}`);
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
  } catch (err) {
    if (err && err.apifyMapped) throw err;
    if (err && err.name === 'AbortError') {
      throw new Error(`Apify run aborted after ${Math.round(timeoutMs / 1000)}s — search too broad. Lower --max or narrow keywords.`);
    }
    throw new Error(`Apify request failed: ${err && err.message ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}
