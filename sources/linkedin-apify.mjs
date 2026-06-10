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

  // Output keys verified against a live run (2026-06): title / jobUrl /
  // companyName / location. Extra fallbacks kept defensive.
  normalize(items) {
    if (!Array.isArray(items)) return [];
    return items
      .filter((it) => it && typeof it === 'object')
      .map((it) => ({
        title: String(it.title || it.jobTitle || '').trim(),
        url: String(it.jobUrl || it.link || it.url || '').trim(),
        company: String(it.companyName || it.company || it.companyUrl || '').trim(),
        location: String(it.location || it.place || it.formattedLocation || '').trim(),
      }))
      .filter((j) => j.title && j.url);
  },
};
