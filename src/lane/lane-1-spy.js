import { fromEquityBrokerEvents } from '../economic/from-broker-events.js';
import { foldEquityRoundTrip } from '../economic/fold-resolved-unit.js';
import { emitResolvedUnitBundleRuntime } from '../economic/emit-resolved-unit-bundle-runtime.js';
import { moneyCents } from '../economic/money-cents.js';

const encoder = new TextEncoder();
const EXACT_SIGNAL_KEYS = Object.freeze(['qty', 'secret', 'side', 'ticker']);

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
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function response(status, body) { return { status, body }; }

function validSignalShape(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(EXACT_SIGNAL_KEYS)) return false;
  return body.ticker === 'SPY' && ['BUY', 'SELL'].includes(body.side) && body.qty === 1
    && typeof body.secret === 'string';
}

export async function lane1ProposalSeal({ side, now, uuid, prior = null }) {
  const sealedAt = new Date(now).toISOString();
  const decisionId = `DEC-LANE1-SPY-${uuid()}`;
  const proposalId = `PROP-LANE1-SPY-${uuid()}`;
  const seed = {
    recordType: 'SEALED_EQUITY_PROPOSAL', lane: 'LANE_1_SPY', authorityLevel: 2,
    principalException: 'LANE_1_SPY', decisionId, proposalId,
    parentProposalHash: prior?.proposalHash ?? null,
    symbol: 'SPY', assetType: 'EQUITY', side, quantityShares: 1,
    orderType: 'MARKET', session: 'NORMAL', duration: 'DAY', sealedAt,
  };
  const clientOrderId = `LANE1-SPY-${(await sha256(canonical(seed))).slice(0, 24)}`;
  const proposal = { ...seed, clientOrderId };
  return { ...proposal, proposalHash: await sha256(canonical(proposal)) };
}

function faultCode(error) {
  const text = String(error?.message ?? error);
  if (text.includes('MISSING_FILL_ID')) return 'MISSING_FILL_ID';
  if (text.includes('MISSING_FEE')) return 'MISSING_FEE';
  const match = /(?:BROKER_EVENT_ADAPTER:)?([A-Z][A-Z0-9_]+)(?::|$)/u.exec(text);
  return match?.[1] ?? 'LANE_1_SYSTEM_FAULT';
}

function openedEvent(state, seal) {
  const existing = state.latestUnit?.events?.[0];
  if (existing) return existing;
  return {
    eventType: 'UNIT_OPENED', appendSequence: 1,
    economicEpisodeId: `EP-LANE1-SPY-${seal.decisionId.slice(-36)}`,
    resolvedUnitId: `RU-LANE1-SPY-${seal.proposalId.slice(-36)}`,
    symbol: 'SPY', quantityShares: 1, openedAt: seal.sealedAt,
  };
}

export function appendLane1BrokerEvents(state, seal, accepted, fill) {
  const prior = state.latestUnit?.events ? structuredClone(state.latestUnit.events) : [];
  const events = prior.length ? prior : [openedEvent(state, seal)];
  const next = () => events.length + 1;
  events.push({
    eventType: 'PROPOSAL_SEALED', appendSequence: next(), side: seal.side,
    clientOrderId: seal.clientOrderId, proposalHash: seal.proposalHash,
    proposal: structuredClone(seal),
  });
  events.push({
    eventType: 'ORDER_ACCEPTED', appendSequence: next(), side: seal.side,
    clientOrderId: seal.clientOrderId, brokerOrderId: accepted.brokerOrderId,
    acceptedAt: accepted.acceptedAt,
  });
  events.push({
    eventType: 'EQUITY_FILL', appendSequence: next(), fillId: fill.fillId,
    brokerOrderId: fill.brokerOrderId, clientOrderId: fill.clientOrderId,
    symbol: fill.symbol, side: fill.side, quantityShares: fill.quantityShares,
    executionPriceUsdPerShare: fill.executionPriceUsdPerShare,
    feeCents: moneyCents(fill.feeUsd),
    brokerOccurredAt: fill.brokerOccurredAt, acquiredAt: fill.acquiredAt,
    rawBrokerEvidenceSha256: fill.rawBrokerEvidenceSha256,
  });
  return events;
}

export async function materializeLane1SpyUnit({ events, fill, bundleStore }) {
  const mapped = fromEquityBrokerEvents(events);
  const folded = foldEquityRoundTrip(mapped);
  const emission = await emitResolvedUnitBundleRuntime(folded);
  const stored = await bundleStore.write(emission);
  const buy = mapped.fills.find((entry) => entry.side === 'BUY') ?? null;
  const sell = mapped.fills.find((entry) => entry.side === 'SELL') ?? null;
  return {
    label: 'LIVE LANE · probe', fixture: false, state: emission.manifest.status,
    symbol: 'SPY', quantity: 1,
    economicEpisodeId: emission.manifest.economicEpisodeId,
    resolvedUnitId: emission.manifest.resolvedUnitId,
    buyFillId: buy?.fillId ?? null,
    sellFillId: sell?.fillId ?? null,
    buyPriceUsdPerShare: buy?.executionPriceUsdPerShare ?? null,
    sellPriceUsdPerShare: sell?.executionPriceUsdPerShare ?? null,
    buyFeeCents: buy?.feeCents ?? null,
    sellFeeCents: sell?.feeCents ?? null,
    totalFeesCents: folded['cash.json'].summary.totalFeesCents,
    netCashMovementCents: folded['cash.json'].summary.netCashMovementCents,
    realizedPnlCents: folded['pnl.json'].summary.realizedPnlCents,
    manifestHash: emission.manifestHash, objectPrefix: stored.objectPrefix,
    updatedAt: fill.acquiredAt, events,
  };
}

export function createLane1SpyController({
  config, coordinator, broker, bundleStore, notifier,
  marketSession, now = () => Date.now(), uuid = () => crypto.randomUUID(),
}) {
  if (!coordinator || !broker || !bundleStore || !notifier || !marketSession) {
    throw new Error('LANE_1_DEPENDENCIES_REQUIRED');
  }

  async function notify(message) {
    try { await notifier.send(message); } catch { /* The durable diary remains authoritative. */ }
  }

  async function expireIfRequired(state, instant) {
    if (!state?.armed) return null;
    const expiresAt = Date.parse(state.expiresAt ?? '');
    if (!Number.isFinite(expiresAt) || instant < expiresAt) return null;
    const disarmed = await coordinator.disarm({ reason: 'TTL_EXPIRED', at: new Date(instant).toISOString() });
    if (disarmed.changed !== false) {
      await notify({ type: 'DISARMED', reason: 'TTL_EXPIRED', state: disarmed.stage });
    }
    return response(202, { state: 'DISARMED', reason: 'TTL_EXPIRED' });
  }

  return Object.freeze({
    async signal(body) {
      if (!validSignalShape(body) || !await secretMatches(body?.secret, config?.secret)) {
        return response(400, { faultCode: 'LANE_1_INVALID_SIGNAL' });
      }
      if (config?.armed === true && config?.notificationsReady !== true) {
        return response(503, { faultCode: 'LANE_1_DISCORD_NOT_READY' });
      }
      const instant = now();
      let state = await coordinator.ensure({
        armed: config?.armed === true, armedAt: config?.armedAt,
        expiresAt: Number.isFinite(Date.parse(config?.armedAt ?? ''))
          ? new Date(Date.parse(config.armedAt) + Number(config.ttlMs ?? 86_400_000)).toISOString()
          : null,
      });
      if (state?.justArmed) await notify({ type: 'ARMED', expiresAt: state.expiresAt });
      const expired = await expireIfRequired(state, instant);
      if (expired) return expired;
      if (config?.armed !== true || !state?.armed) {
        return response(202, { state: 'DISARMED', ignored: true });
      }
      const expected = body.side === 'BUY' ? 'ARMED_BUY' : 'AWAITING_SELL';
      if (state.stage !== expected) {
        return response(409, { faultCode: 'LANE_1_SEQUENCE_REFUSED', state: state.stage });
      }
      if (await marketSession() !== 'RTH') {
        return response(409, { faultCode: 'LANE_1_RTH_REQUIRED', state: state.stage });
      }

      const seal = await lane1ProposalSeal({ side: body.side, now: instant, uuid,
        prior: state.buy?.seal ?? null });
      const claim = await coordinator.claimSignal({ side: body.side, seal });
      if (!claim.claimed) return response(202, { state: claim.state?.stage ?? 'DISARMED', ignored: true });
      state = claim.state;

      let accepted;
      try {
        accepted = await broker.placeEquityOrder({
          symbol: 'SPY', side: body.side, quantity: 1, assetType: 'EQUITY',
          orderType: 'MARKET', session: 'NORMAL', duration: 'DAY',
          clientOrderId: seal.clientOrderId,
        });
        state = await coordinator.recordBrokerAccepted({ side: body.side,
          brokerOrderId: accepted.brokerOrderId, acceptedAt: accepted.acceptedAt });
        const fill = await broker.waitForFill({ side: body.side,
          brokerOrderId: accepted.brokerOrderId, clientOrderId: seal.clientOrderId });
        const events = appendLane1BrokerEvents(state, seal, accepted, fill);
        const unit = await materializeLane1SpyUnit({ events, fill, bundleStore });
        state = await coordinator.recordUnit({ side: body.side, unit });
        if (body.side === 'BUY') {
          await notify({ type: 'BOUGHT', symbol: 'SPY', quantity: 1,
            fillId: unit.buyFillId, manifestHash: unit.manifestHash,
            priceUsdPerShare: unit.buyPriceUsdPerShare,
            feesCents: unit.buyFeeCents, netCents: unit.netCashMovementCents });
        } else {
          await notify({ type: 'SOLD', symbol: 'SPY', quantity: 1,
            fillId: unit.sellFillId, manifestHash: unit.manifestHash,
            priceUsdPerShare: unit.sellPriceUsdPerShare,
            feesCents: unit.totalFeesCents, netCents: unit.realizedPnlCents });
          await notify({ type: 'DISARMED', reason: 'ROUND_TRIP_COMPLETE', state: 'DISARMED' });
        }
        return response(200, { state: state.stage, manifestHash: unit.manifestHash,
          resolvedUnitId: unit.resolvedUnitId });
      } catch (error) {
        const code = faultCode(error);
        const faultState = await coordinator.recordFault({
          faultCode: code, detail: String(error?.message ?? error),
          brokerOrderId: accepted?.brokerOrderId ?? null, at: new Date(now()).toISOString(),
        });
        await notify({ type: 'FAULT', faultCode: code,
          brokerOrderId: accepted?.brokerOrderId ?? null, state: faultState.stage });
        return response(422, { state: faultState.stage, faultCode: code });
      }
    },

    async disarm(body) {
      if (!body || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(['secret'])
        || !await secretMatches(body.secret, config?.secret)) {
        return response(400, { faultCode: 'LANE_1_INVALID_DISARM' });
      }
      const state = await coordinator.disarm({ reason: 'PRINCIPAL_COMMAND',
        at: new Date(now()).toISOString() });
      if (state.changed !== false) {
        await notify({ type: 'DISARMED', reason: 'PRINCIPAL_COMMAND', state: state.stage });
      }
      return response(200, { state: state.stage });
    },

    async expire() {
      const state = await coordinator.status();
      return expireIfRequired(state, now());
    },
  });
}
