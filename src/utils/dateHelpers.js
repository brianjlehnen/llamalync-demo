/**
 * Return true when `dateStr` is missing, unparseable, or earlier than the
 * cutoff Date.
 *
 * Originally written to fix two latent staleness checks in the mock
 * loaders:
 *
 *   - `data.filter(r => r.status === 'Open' && new Date(r.lastReviewedAt) < overdueCutoff)`
 *   - `active.filter(d => new Date(d.lastSeen) < thirtyDaysAgo)`
 *
 * `new Date(undefined) < cutoff` evaluates to `false` (NaN comparisons),
 * so records missing `lastReviewedAt` / `lastSeen` would NEVER flag as
 * overdue or stale — exactly the opposite of the intended semantics.
 * Missing or invalid timestamps should be treated as overdue/stale, since
 * those are the records most worth a human's attention.
 *
 * Semantics:
 *   - missing (null / undefined / '')   → true   (treat as stale)
 *   - invalid string (NaN parse)        → true   (treat as stale)
 *   - valid date earlier than cutoff    → true
 *   - valid date at or after cutoff     → false
 */
function isBeforeOrMissing(dateStr, cutoff) {
  if (dateStr === null || dateStr === undefined || dateStr === '') return true;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return true;
  return d < cutoff;
}

module.exports = { isBeforeOrMissing };
