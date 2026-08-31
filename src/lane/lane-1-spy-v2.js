import { fromEquityBrokerEvents } from '../economic/from-broker-events.js';
import { foldEquityRoundTrip } from '../economic/fold-resolved-unit.js';
import { emitResolvedUnitBundleRuntime } from '../economic/emit-resolved-unit-bundle-runtime.js';
import { moneyCents } from '../economic/money-cents.js';
import { assertLane1InstructionState, assertLane1PositionAgreement,
  assertLane1SendSnapshot } from './lane-1-position-guards.js';

export const LANE_1_SPY_V2 = 'LANE_1_SPY_V2_1_MARKET_ONLY';
export const LANE_1_SPY_MARKET_V2_1 = 'LANE_1_SPY_MARKET_ONLY_V2_1';
const EXACT_SIGNAL_KEYS = Object.freeze(['qty', 'secret', 'side', 'ticker']);
const EXACT_REPLAY_KEYS = Object.freeze(['qty', 'side', 'ticker']);
const encoder = new TextEncoder();

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

async function secretMatches(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string' || !expected) return false;
  const [left, right] = await Promise.all([sha256(supplied), sha256(expected)]);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function normalizeLane1V21Signal(side) {
  if (side === 'BUY' || side === 'LONG') return { signal: 'LONG', exitScope: null };
  if (side === 'SHORT') return { signal: 'SHORT', exitScope: null };
  if (side === 'EXIT' || side === 'SELL') return { signal: 'EXIT', exitScope: 'ANY' };
  return null;
}

export function lane1V21ReplayBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(EXACT_REPLAY_KEYS)
    || body.ticker !== 'SPY' || normalizeLane1V21Signal(body.side) === null
    || body.qty !== 1) return null;
  return { ticker: body.ticker, side: body.side, qty: body.qty };
}

function replayBodyFromSignal(body) {
  return lane1V21ReplayBody({ ticker: body?.ticker, side: body?.side, qty: body?.qty });
}

function validSignalShape(body) {
  return body && typeof body === 'object' && !Array.isArray(body)
    && JSON.stringify(Object.keys(body).sort()) === JSON.stringify(EXACT_SIGNAL_KEYS)
    && replayBodyFromSignal(body) !== null && typeof body.secret === 'string';
}

export function replayBodyFromAuthenticatedLane1V21Signal(body) {
  return validSignalShape(body) ? replayBodyFromSignal(body) : null;
}

export async function bindLane1V21ReplayBody(body) {
  const replayBody = lane1V21ReplayBody(body);
  if (!replayBody) throw new Error('LANE_1_REPLAY_BODY_INVALID');
  const normalized = normalizeLane1V21Signal(replayBody.side);
  const signalBinding = { source: 'TRADINGVIEW_WEBHOOK', ticker: replayBody.ticker,
    rawSide: replayBody.side, signal: normalized.signal, qty: replayBody.qty,
    secretAuthenticated: true };
  return { replayBody, normalized,
    tvBodyBindingSha256: await sha256(canonical(signalBinding)) };
}

function response(status, body) { return { status, body }; }
function noSend(disposition, state, extra = {}) {
  return response(200, { state: state?.stage ?? 'DISARMED', disposition, sent: false, ...extra });
}

function faultCode(error) {
  const text = String(error?.message ?? error);
  if (text.includes('MISSING_FILL_ID')) return 'MISSING_FILL_ID';
  if (text.includes('MISSING_FEE')) return 'MISSING_FEE';
  return /(?:BROKER_EVENT_ADAPTER:)?([A-Z][A-Z0-9_]+)(?::|$)/u.exec(text)?.[1]
    ?? 'LANE_1_SYSTEM_FAULT';
}

export async function lane1V2ProposalSeal({ signal, rawSignalSide = signal,
  tvBodyBindingSha256, positionSide, now, uuid, prior = null }) {
  const sealedAt = new Date(now).toISOString();
  const decisionId = `DEC-LANE1-SPY-V2-${uuid()}`;
  const proposalId = `PROP-LANE1-SPY-V2-${uuid()}`;
  const brokerInstruction = signal === 'LONG' ? 'BUY' : signal === 'SHORT' ? 'SELL_SHORT'
    : positionSide === 'LONG' ? 'SELL' : 'BUY_TO_COVER';
  const seed = {
    recordType: 'SEALED_EQUITY_PROPOSAL', lane: 'LANE_1_SPY', laneContract: LANE_1_SPY_V2,
    authorityLevel: 2, principalException: 'LANE_1_SPY', decisionId, proposalId,
    parentProposalHash: prior?.proposalHash ?? null, symbol: 'SPY', assetType: 'EQUITY',
    signalSource: 'TRADINGVIEW_WEBHOOK', rawSignalSide, signal,
    tvBodyBindingSha256, positionSide: positionSide ?? signal,
    brokerInstruction, quantityShares: 1,
    orderType: 'MARKET', session: 'NORMAL', duration: 'DAY', sealedAt,
  };
  const clientOrderId = `LANE1-SPY-V2-${(await sha256(canonical(seed))).slice(0, 20)}`;
  const proposal = { ...seed, clientOrderId };
  return { ...proposal, proposalHash: await sha256(canonical(proposal)) };
}

function openedEvent(state, seal) {
  return state.latestUnit?.events?.[0] ?? {
    eventType: 'UNIT_OPENED', appendSequence: 1,
    economicEpisodeId: `EP-LANE1-SPY-V2-${seal.decisionId.slice(-36)}`,
    resolvedUnitId: `RU-LANE1-SPY-V2-${seal.proposalId.slice(-36)}`,
    symbol: 'SPY', quantityShares: 1, openedAt: seal.sealedAt,
  };
}

export function appendLane1V2BrokerEvents(state, seal, accepted, fill, stop = null) {
  const prior = seal.signal === 'EXIT' && state.latestUnit?.events
    ? structuredClone(state.latestUnit.events) : [];
  const events = prior.length ? prior : [openedEvent(state, seal)];
  const next = () => events.length + 1;
  events.push({ eventType: 'PROPOSAL_SEALED', appendSequence: next(), side: seal.brokerInstruction,
    signal: seal.signal, clientOrderId: seal.clientOrderId, proposalHash: seal.proposalHash,
    proposal: structuredClone(seal) });
  events.push({ eventType: 'ORDER_ACCEPTED', appendSequence: next(), side: seal.brokerInstruction,
    clientOrderId: seal.clientOrderId, brokerOrderId: accepted.brokerOrderId,
    acceptedAt: accepted.acceptedAt });
  if (stop) events.push({ eventType: 'PROTECTIVE_STOP_ACCEPTED', appendSequence: next(),
    brokerOrderId: stop.orderId, parentBrokerOrderId: accepted.brokerOrderId,
    instruction: stop.instruction, stopPriceLinkBasis: stop.stopPriceLinkBasis,
    stopPriceLinkType: stop.stopPriceLinkType, stopPriceOffset: stop.stopPriceOffset,
    duration: stop.duration, acceptedAt: stop.acceptedAt ?? accepted.acceptedAt });
  events.push({ eventType: 'EQUITY_FILL', appendSequence: next(), fillId: fill.fillId,
    brokerOrderId: fill.brokerOrderId, clientOrderId: fill.clientOrderId, symbol: fill.symbol,
    side: fill.side, quantityShares: fill.quantityShares,
    executionPriceUsdPerShare: fill.executionPriceUsdPerShare, feeCents: moneyCents(fill.feeUsd),
    brokerOccurredAt: fill.brokerOccurredAt, acquiredAt: fill.acquiredAt,
    rawBrokerEvidenceSha256: fill.rawBrokerEvidenceSha256 });
  return events;
}

export function appendLane1V2StopCanceled(events, cancellation) {
  const result = structuredClone(events);
  result.push({ eventType: 'PROTECTIVE_STOP_CANCELED', appendSequence: result.length + 1,
    brokerOrderId: cancellation.stopOrderId, status: cancellation.status,
    confirmedAt: cancellation.confirmedAt });
  return result;
}

export function appendLane1V2StopFill(events, fill) {
  const result = structuredClone(events);
  result.push({ eventType: 'EQUITY_FILL', appendSequence: result.length + 1,
    fillId: fill.fillId, brokerOrderId: fill.brokerOrderId,
    clientOrderId: fill.clientOrderId, symbol: fill.symbol, side: fill.side,
    quantityShares: fill.quantityShares,
    executionPriceUsdPerShare: fill.executionPriceUsdPerShare,
    feeCents: moneyCents(fill.feeUsd), brokerOccurredAt: fill.brokerOccurredAt,
    acquiredAt: fill.acquiredAt, rawBrokerEvidenceSha256: fill.rawBrokerEvidenceSha256,
    executionCause: 'PROTECTIVE_STOP' });
  return result;
}

export async function materializeLane1V2Unit({ events, fill, stop, bundleStore }) {
  const mapped = fromEquityBrokerEvents(events);
  const folded = foldEquityRoundTrip(mapped);
  folded['manifest.json'].laneContractVersion = LANE_1_SPY_V2;
  folded['manifest.json'].executionContractVersion = LANE_1_SPY_MARKET_V2_1;
  folded['decision.json'].laneContractVersion = LANE_1_SPY_V2;
  folded['decision.json'].executionContractVersion = LANE_1_SPY_MARKET_V2_1;
  folded['order-events.json'].appendLog = structuredClone(events);
  folded['order-events.json'].protectiveStop = stop ? structuredClone(stop) : null;
  const emission = await emitResolvedUnitBundleRuntime(folded);
  const stored = await bundleStore.write(emission);
  const opening = mapped.fills[0];
  const closing = mapped.fills[1] ?? null;
  const positionSide = opening.side === 'BUY' ? 'LONG' : 'SHORT';
  return {
    label: 'LIVE LANE · SPY TEST · 15m', fixture: false, state: emission.manifest.status,
    symbol: 'SPY', quantity: 1, positionSide: closing ? 'FLAT' : positionSide,
    openingSide: positionSide, economicEpisodeId: emission.manifest.economicEpisodeId,
    resolvedUnitId: emission.manifest.resolvedUnitId, openingFillId: opening.fillId,
    closingFillId: closing?.fillId ?? null, openingPriceUsdPerShare: opening.executionPriceUsdPerShare,
    closingPriceUsdPerShare: closing?.executionPriceUsdPerShare ?? null,
    openingFeeCents: opening.feeCents, closingFeeCents: closing?.feeCents ?? null,
    totalFeesCents: folded['cash.json'].summary.totalFeesCents,
    netCashMovementCents: folded['cash.json'].summary.netCashMovementCents,
    realizedPnlCents: folded['pnl.json'].summary.realizedPnlCents,
    stop: stop ? structuredClone(stop) : null, manifestHash: emission.manifestHash,
    objectPrefix: stored.objectPrefix, updatedAt: fill.acquiredAt, events,
  };
}

export function createLane1SpyV2Controller({ config, coordinator, broker, bundleStore, notifier,
  marketSession, now = () => Date.now(), uuid = () => crypto.randomUUID() }) {
  if (!coordinator || !broker || !bundleStore || !notifier || !marketSession) {
    throw new Error('LANE_1_DEPENDENCIES_REQUIRED');
  }
  async function notify(message, { required = false } = {}) {
    try { await notifier.send(message); }
    catch (error) { if (required) throw error; }
  }
  async function expire(state, instant) {
    if (!state?.armed || instant < Date.parse(state.expiresAt ?? '')) return null;
    const disarmed = await coordinator.disarm({ reason: 'TTL_EXPIRED', at: new Date(instant).toISOString() });
    if (disarmed.changed !== false) await notify({ type: 'DISARMED', reason: 'TTL_EXPIRED' });
    return noSend('ttl-expired', disarmed, { reason: 'TTL_EXPIRED' });
  }
  function custodyDisposition(state, custody, signal) {
    assertLane1SendSnapshot(custody);
    const durableSide = state.positionSide;
    // Unknown fields refuse before comparison; they must not match FLAT.
    try { assertLane1PositionAgreement(durableSide, custody); }
    catch (error) {
      if (error.message !== 'LANE_1_POSITION_STATE_DRIFT:COORDINATOR_BROKER_DISAGREEMENT') throw error;
      return noSend('reconciliation-required', state, { faultCode: 'LANE_1_POSITION_STATE_DRIFT',
        durablePositionSide: durableSide, custodyPositionSide: custody.positionSide });
    }
    if (signal === 'EXIT' && durableSide === 'FLAT') return noSend('already-flat', state);
    if (signal === durableSide) return noSend('already-in', state, { positionSide: durableSide });
    if (signal !== 'EXIT' && durableSide !== 'FLAT') {
      return noSend('must-exit-first', state, { positionSide: durableSide, requestedSide: signal });
    }
    return null;
  }
  async function recordFault(error, accepted = null) {
    const code = faultCode(error);
    const state = await coordinator.recordFault({ faultCode: code,
      detail: String(error?.message ?? error), brokerOrderId: accepted?.brokerOrderId ?? null,
      at: new Date(now()).toISOString() });
    await notify({ type: 'FAULT', faultCode: code, brokerOrderId: accepted?.brokerOrderId ?? null });
    return response(200, { state: state.stage, faultCode: code, sent: Boolean(accepted) });
  }
  return Object.freeze({
    async signal(body) {
      if (!validSignalShape(body) || !await secretMatches(body?.secret, config?.secret)) {
        return response(400, { faultCode: 'LANE_1_INVALID_SIGNAL', sent: false });
      }
      const binding = await bindLane1V21ReplayBody(
        replayBodyFromAuthenticatedLane1V21Signal(body),
      );
      const { normalized, tvBodyBindingSha256 } = binding;
      const instant = now();
      let state = await coordinator.ensure({ armed: config?.armed === true,
        armedAt: config?.armedAt, expiresAt: Number.isFinite(Date.parse(config?.armedAt ?? ''))
          ? new Date(Date.parse(config.armedAt) + Number(config.ttlMs ?? 86_400_000)).toISOString()
          : null });
      if (state.configurationFault) return response(200, { state: state.stage,
        faultCode: state.configurationFault, sent: false });
      const durableArm = state?.armed === true;
      const effectivelyArmed = config?.armed === true || durableArm;
      if (effectivelyArmed && config?.notificationsReady !== true) {
        return response(200, { state: 'FAULT', faultCode: 'LANE_1_DISCORD_NOT_READY', sent: false });
      }
      if (state.justArmed) await notify({ type: 'ARMED', expiresAt: state.expiresAt });
      const expired = await expire(state, instant); if (expired) return expired;
      if (!effectivelyArmed || !state?.armed) return noSend('disarmed', state,
        { tvBodyBindingSha256 });
      let expectedSnapshot;
      let custody;
      try {
        expectedSnapshot = await broker.sendSnapshot();
        custody = custodyDisposition(state, expectedSnapshot, normalized.signal);
      }
      catch (error) { return recordFault(error); }
      if (custody) return custody;
      let session;
      try { session = await marketSession(); } catch (error) { return recordFault(error); }
      if (session !== 'RTH') return noSend('market-closed', state);

      const positionSide = state.positionSide;
      const seal = await lane1V2ProposalSeal({ signal: normalized.signal,
        rawSignalSide: body.side, tvBodyBindingSha256, positionSide,
        now: instant, uuid, prior: state.open?.seal ?? null });
      try { assertLane1InstructionState({ instruction: seal.brokerInstruction, positionSide, quantity: 1 }); }
      catch (error) { return recordFault(error); }
      const claim = await coordinator.claim({ signal: normalized.signal, seal });
      if (!claim.claimed) return noSend('duplicate-in-flight', claim.state);
      state = claim.state;
      let accepted = null;
      try {
        if (normalized.signal !== 'EXIT') {
          accepted = await broker.placeMarket({ instruction: seal.brokerInstruction,
            clientOrderId: seal.clientOrderId, durableArm, expectedSnapshot });
          state = await coordinator.recordAccepted({ signal: normalized.signal,
            brokerOrderId: accepted.brokerOrderId, acceptedAt: accepted.acceptedAt });
          const fill = await broker.waitForFill({ side: seal.brokerInstruction,
            brokerOrderId: accepted.brokerOrderId, clientOrderId: seal.clientOrderId,
            durableArm });
          const events = appendLane1V2BrokerEvents(state, seal, accepted, fill);
          const unit = await materializeLane1V2Unit({ events, fill, stop: null, bundleStore });
          state = await coordinator.recordOpen({ signal: normalized.signal, unit, stop: null });
          await notify({ type: 'OPENED', side: normalized.signal, symbol: 'SPY', quantity: 1,
            fillId: unit.openingFillId, manifestHash: unit.manifestHash,
            priceUsdPerShare: unit.openingPriceUsdPerShare, feesCents: unit.openingFeeCents,
            netCents: unit.netCashMovementCents, executionContractVersion: LANE_1_SPY_MARKET_V2_1,
            brokerOrderId: accepted.brokerOrderId, tvBodyBindingSha256 }, { required: true });
          return response(200, { state: state.stage, disposition: 'opened', sent: true,
            positionSide: normalized.signal, brokerOrderId: accepted.brokerOrderId,
            tvBodyBindingSha256, manifestHash: unit.manifestHash });
        }

        accepted = await broker.placeMarket({ instruction: seal.brokerInstruction,
          clientOrderId: seal.clientOrderId, durableArm, expectedSnapshot });
        state = await coordinator.recordAccepted({ signal: 'EXIT',
          brokerOrderId: accepted.brokerOrderId, acceptedAt: accepted.acceptedAt });
        const fill = await broker.waitForFill({ side: seal.brokerInstruction,
          brokerOrderId: accepted.brokerOrderId, clientOrderId: seal.clientOrderId,
          durableArm });
        const events = appendLane1V2BrokerEvents(state, seal, accepted, fill);
        const unit = await materializeLane1V2Unit({ events, fill, stop: null, bundleStore });
        state = await coordinator.recordExit({ unit, cancellation: null });
        await notify({ type: 'EXITED', side: 'FLAT', fromSide: positionSide, symbol: 'SPY',
          quantity: 1, fillId: unit.closingFillId, manifestHash: unit.manifestHash,
          priceUsdPerShare: unit.closingPriceUsdPerShare, feesCents: unit.totalFeesCents,
          netCents: unit.realizedPnlCents, executionContractVersion: LANE_1_SPY_MARKET_V2_1,
          brokerOrderId: accepted.brokerOrderId, tvBodyBindingSha256 }, { required: true });
        return response(200, { state: state.stage, disposition: 'exited', sent: true,
          positionSide: 'FLAT', brokerOrderId: accepted.brokerOrderId,
          tvBodyBindingSha256, realizedPnlCents: unit.realizedPnlCents,
          manifestHash: unit.manifestHash });
      } catch (error) { return recordFault(error, accepted); }
    },
    async disarm() {
      const state = await coordinator.disarm({ reason: 'PRINCIPAL_COMMAND',
        at: new Date(now()).toISOString() });
      if (state.changed !== false) await notify({ type: 'DISARMED', reason: 'PRINCIPAL_COMMAND' });
      return response(200, { state: state.stage });
    },
    async reconcile() {
      const state = await coordinator.status();
      if (state?.positionSide === 'FLAT') return null;
      try {
        if (!['LONG', 'SHORT'].includes(state?.positionSide)) {
          throw new Error('LANE_1_POSITION_STATE_DRIFT:COORDINATOR_POSITION_UNKNOWN');
        }
        const custody = await broker.position();
        assertLane1PositionAgreement(custody?.positionSide, custody);
        if (custody.positionSide === state.positionSide) return null;
        if (custody.positionSide !== 'FLAT') throw new Error('LANE_1_POSITION_STATE_DRIFT');
        throw new Error('LANE_1_EXTERNAL_FLATTEN_IDENTITY_REQUIRED');
      } catch (error) { return recordFault(error); }
    },
    async expire() { return expire(await coordinator.status(), now()); },
  });
}
