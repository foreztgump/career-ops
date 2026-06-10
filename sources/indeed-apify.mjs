// @ts-check
/** @typedef {import('./_types.js').SearchSource} SearchSource */

// Indeed jobs via Apify actor borderline/indeed-scraper ($5/1k). Takes plain
// query/location/country fields — no search-URL building needed. Input field
// types/enums are pinned to the actor's documented input schema (verified
// 2026-06): fromDays ∈ {"1","3","7","14"} (string), remote ∈ {"remote",
// "hybrid"} (omit when none), sort ∈ {"relevance","date"}.

const FROM_DAYS_ALLOWED = [1, 3, 7, 14]; // actor enum (sent as strings).

// Snap an arbitrary freshness window to the smallest allowed value that still
// covers it (so 5 widens to 7, not narrows to 3); clamp to the 14-day max.
function snapFromDays(days) {
  const n = Number(days);
  for (const allowed of FROM_DAYS_ALLOWED) {
    if (n <= allowed) return String(allowed);
  }
  return String(FROM_DAYS_ALLOWED[FROM_DAYS_ALLOWED.length - 1]);
}

// Indeed returns `location` as a nested object; pull the best human string.
function extractLocation(it) {
  const loc = it.location;
  if (typeof loc === 'string') return loc.trim();
  if (loc && typeof loc === 'object') {
    return String(loc.formattedAddressShort || loc.formattedAddressLong || loc.city || '').trim();
  }
  return String(it.formattedLocation || '').trim();
}

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
      fromDays: snapFromDays(criteria.postedDays),
      maxRows: maxItems,
      sort: 'date',
    };
    if (criteria.remote === 'remote') input.remote = 'remote';
    return input;
  },

  // Output keys verified against the actor README sample (2026-06):
  // title / jobUrl / companyName / location{...}. Fallbacks kept defensive.
  normalize(items) {
    if (!Array.isArray(items)) return [];
    return items
      .filter((it) => it && typeof it === 'object')
      .map((it) => ({
        title: String(it.title || it.positionName || it.jobTitle || '').trim(),
        url: String(it.jobUrl || it.url || it.applyUrl || it.link || '').trim(),
        company: String(it.companyName || it.company || '').trim(),
        location: extractLocation(it),
      }))
      .filter((j) => j.title && j.url);
  },
};
