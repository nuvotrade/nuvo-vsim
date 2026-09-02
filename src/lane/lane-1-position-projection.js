const POSITION_SIDES = Object.freeze(['FLAT', 'LONG', 'SHORT']);

function validSide(value) { return POSITION_SIDES.includes(value); }
function validTime(value) { return Number.isFinite(Date.parse(value ?? '')); }

function coordinatorView(state) {
  const positionSide = validSide(state?.positionSide) ? state.positionSide : 'UNKNOWN';
  return Object.freeze({
    positionSide,
    stage: typeof state?.stage === 'string' ? state.stage : 'UNKNOWN',
    armed: state?.armed === true,
    updatedAt: validTime(state?.updatedAt) ? state.updatedAt : null,
  });
}

function brokerView(snapshot) {
  if (!snapshot || !validSide(snapshot.positionSide) || !validTime(snapshot.acquiredAt)) return null;
  return Object.freeze({ positionSide: snapshot.positionSide, acquiredAt: snapshot.acquiredAt,
    accountHash: snapshot.accountHash ?? null, workingOrderCount: snapshot.workingOrderCount ?? null });
}

export class Lane1PositionRefreshGate {
  #inFlight = null;

  async run(task) {
    if (typeof task !== 'function') throw new Error('LANE_1_POSITION_REFRESH_TASK_REQUIRED');
    if (this.#inFlight) return this.#inFlight;
    const current = Promise.resolve().then(task);
    this.#inFlight = current;
    try { return await current; }
    finally { if (this.#inFlight === current) this.#inFlight = null; }
  }
}

/**
 * One position projection for every Lane 1 surface. It never converts missing,
 * faulted, or unreadable state to FLAT.
 */
export function buildLane1PositionProjection({ coordinatorState, brokerSnapshot = null,
  brokerRead = null, projectedAt = new Date().toISOString() }) {
  const coordinator = coordinatorView(coordinatorState);
  const broker = brokerView(brokerSnapshot);
  const brokerError = brokerRead?.ok === false
    ? String(brokerRead.error ?? 'BROKER_UNREACHABLE') : null;
  const coordinatorUnknown = coordinator.positionSide === 'UNKNOWN'
    || ['UNKNOWN', 'FAULT'].includes(coordinator.stage);

  if (brokerError || !broker) {
    return Object.freeze({ status: 'UNVERIFIED', positionSide: coordinatorUnknown
      ? 'UNKNOWN' : coordinator.positionSide, coordinator, broker,
    brokerRead: { ok: false, error: brokerError ?? 'BROKER_SNAPSHOT_UNAVAILABLE',
      attemptedAt: brokerRead?.attemptedAt ?? null,
      lastSuccessfulAt: broker?.acquiredAt ?? null }, projectedAt });
  }
  if (coordinator.positionSide !== broker.positionSide || coordinatorUnknown) {
    return Object.freeze({ status: 'POSITION_DRIFT', positionSide: 'UNKNOWN',
      coordinator, broker, brokerRead: { ok: true, error: null,
        attemptedAt: brokerRead?.attemptedAt ?? broker.acquiredAt,
        lastSuccessfulAt: broker.acquiredAt }, projectedAt });
  }
  return Object.freeze({ status: 'AGREE', positionSide: broker.positionSide,
    coordinator, broker, brokerRead: { ok: true, error: null,
      attemptedAt: brokerRead?.attemptedAt ?? broker.acquiredAt,
      lastSuccessfulAt: broker.acquiredAt }, projectedAt });
}
