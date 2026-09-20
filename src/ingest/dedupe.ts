/**
 * Meta retries a webhook delivery when we are slow or return non-2xx, so the same
 * `mid` can arrive several times. This is a process-local guard only.
 *
 * It does NOT survive a restart and does NOT coordinate across instances. The
 * durable guard is a UNIQUE constraint on the message id in Postgres; this just
 * avoids paying for a duplicate AI parse in the common case.
 */
const TTL_MS = 60 * 60 * 1000; // 1 hour — comfortably longer than Meta's retry window.
const MAX_ENTRIES = 10_000;

const seen = new Map<string, number>();

function evictExpired(now: number): void {
  for (const [mid, expiresAt] of seen) {
    if (expiresAt <= now) seen.delete(mid);
  }
}

/**
 * Records the id and reports whether it had already been seen.
 * Returns true if this is a duplicate that should be skipped.
 */
export function isDuplicate(mid: string): boolean {
  const now = Date.now();
  const expiresAt = seen.get(mid);

  if (expiresAt !== undefined && expiresAt > now) return true;

  // Map preserves insertion order, so the oldest key is the first one.
  if (seen.size >= MAX_ENTRIES) {
    evictExpired(now);
    while (seen.size >= MAX_ENTRIES) {
      const oldest = seen.keys().next();
      if (oldest.done) break;
      seen.delete(oldest.value);
    }
  }

  seen.set(mid, now + TTL_MS);
  return false;
}

/** Test hook. */
export function resetDedupe(): void {
  seen.clear();
}
