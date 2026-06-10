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
