// Per-sessionId mutex for cookie store read-modify-write operations.
// The lock is in-memory only — it deduplicates concurrency within one service
// worker lifecycle. Cross-restart races fall back to Chrome's event-loop order.
const locks: Map<string, Promise<void>> = new Map();

export async function withCookieLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const curr = new Promise<void>(r => { release = r; });
  locks.set(sessionId, curr);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(sessionId) === curr) locks.delete(sessionId);
  }
}
