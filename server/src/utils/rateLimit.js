// Minimal in-memory sliding-window rate limiter shared by the login and
// one-time account-claim endpoints. Single-process only (matches the rest of
// this app's in-memory caches) - acceptable because both endpoints are also
// backed by durable state (passwordHash / accountClaimed) that a restart
// cannot bypass.
const buckets = new Map();
const MAX_BUCKETS = 5000;

function pruneIfLarge() {
  if (buckets.size <= MAX_BUCKETS) return;
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > bucket.windowMs) buckets.delete(key);
  }
}

// Returns true when the caller is within the allowed rate, false when the
// caller should be rejected. `key` should combine the endpoint name and a
// caller identifier (IP) so different endpoints don't share a budget.
export function checkRateLimit(key, { max = 10, windowMs = 15 * 60_000 } = {}) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart > windowMs) {
    buckets.set(key, { count: 1, windowStart: now, windowMs });
    pruneIfLarge();
    return true;
  }
  bucket.count += 1;
  return bucket.count <= max;
}

export function resetRateLimit(key) {
  buckets.delete(key);
}
