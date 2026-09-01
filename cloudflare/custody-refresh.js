export const CUSTODY_REFRESH_DEBOUNCE_MS = 60_000;

function epochMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function custodyRefreshPolicy(latest, now = Date.now(), thresholdMs = CUSTODY_REFRESH_DEBOUNCE_MS) {
  const observedAtMs = epochMs(latest?.observedAt);
  const ageMs = observedAtMs === null ? null : Math.max(0, now - observedAtMs);
  return {
    refreshRequired: ageMs === null || ageMs >= thresholdMs,
    ageMs,
    thresholdMs,
  };
}

export function custodyRefreshFailure(error) {
  const message = String(error?.message ?? error);
  const rateLimited = /(?:HTTP[_ ]?429|RATE[_ -]?LIMIT|TOO MANY REQUESTS|THROTTL)/iu.test(message);
  return {
    code: rateLimited ? 'SCHWAB_CUSTODY_RATE_LIMITED' : 'SCHWAB_CUSTODY_REFRESH_FAILED',
    status: rateLimited ? 429 : 503,
    message,
  };
}

export function queueCustodyRefresh(previous, operation) {
  const task = previous.then(operation);
  return { task, next: task.catch(() => undefined) };
}

export async function performCustodyRefresh({
  readStored, readBroker, now = () => Date.now(), thresholdMs = CUSTODY_REFRESH_DEBOUNCE_MS,
}) {
  const stored = await readStored();
  const policy = custodyRefreshPolicy(stored, now(), thresholdMs);
  if (!policy.refreshRequired) {
    return { refreshed: false, debounced: true, observedAt: stored.observedAt,
      snapshotHash: stored.hash, ageMs: policy.ageMs, thresholdMs };
  }
  const snapshot = await readBroker();
  return { refreshed: true, debounced: false,
    observedAt: new Date(snapshot.asOf).toISOString(), snapshotHash: snapshot.snapshotHash,
    ageMs: 0, thresholdMs, positionCount: snapshot.positions.length,
    openOrderCount: snapshot.openOrders.length };
}
