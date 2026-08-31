import {
  appendLane1BrokerEvents, createLane1SpyController, lane1ProposalSeal,
  materializeLane1SpyUnit,
} from '../src/lane/lane-1-spy.js';
import {
  bindLane1V21ReplayBody, createLane1SpyV2Controller, lane1V2ProposalSeal,
  replayBodyFromAuthenticatedLane1V21Signal,
} from '../src/lane/lane-1-spy-v2.js';
import { sessionStatus } from '../src/truth/providers/schwab.js';
import { SchwabD1Client } from './schwab-client.js';
import { capturePreviewResponse } from './preview-response-evidence.js';
import { centsToUsd, formatCents, formatExecutionPrice } from '../src/economic/money-cents.js';

const encoder = new TextEncoder();
const ALLOWED_NOTICES = new Set([
  'ARMED', 'BOUGHT', 'SOLD', 'OPENED', 'EXITED', 'FAULT', 'DISARMED',
]);

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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

async function recordOperationalProof(env, ownerId, eventType, detail) {
  if (!env.DB?.prepare || !ownerId) return null;
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO operational_audit
    (id,owner_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?)`).bind(
    id, ownerId, eventType, JSON.stringify({
      ...detail,
      workerVersion: env.CF_VERSION_METADATA?.id ?? 'local',
    }), createdAt,
  ).run();
  return { id, createdAt };
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(String(value ?? ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function previewOrderContractEvidence(response, instruction) {
  const order = response?.orderStrategy;
  const leg = order?.orderLegs?.[0];
  // Explicit allowlist: no account, token, full response, or arbitrary objects.
  const scalar = (value) => typeof value === 'string' ? value.slice(0, 128)
    : typeof value === 'number' || typeof value === 'boolean' ? value : null;
  return {
    responseLegSource: 'orderStrategy.orderLegs',
    expected: { orderType: 'MARKET', orderStrategyType: 'SINGLE', session: 'NORMAL',
      duration: 'DAY', legCount: 1, childCount: 0, instruction, quantity: 1,
      symbol: 'SPY', assetType: 'EQUITY' },
    actual: {
      orderType: scalar(order?.orderType), orderStrategyType: scalar(order?.orderStrategyType),
      session: scalar(order?.session), duration: scalar(order?.duration),
      legCount: Array.isArray(order?.orderLegs) ? order.orderLegs.length : null,
      childCount: order?.childOrderStrategies === undefined ? 0
        : Array.isArray(order.childOrderStrategies) ? order.childOrderStrategies.length : null,
      instruction: scalar(leg?.instruction), quantity: scalar(leg?.quantity),
      symbol: scalar(leg?.finalSymbol), assetType: scalar(leg?.assetType),
    },
  };
}

async function replayBindingFromIngressDetail(detail) {
  if (detail?.replayEligible !== true || !detail.replayBody) return null;
  try {
    const binding = await bindLane1V21ReplayBody(detail.replayBody);
    if (binding.tvBodyBindingSha256 !== detail.tvBodyBindingSha256) return null;
    return binding;
  } catch { return null; }
}

export async function latestLane1ReplayIngress(env, ownerId) {
  if (!env.DB?.prepare || !ownerId) return null;
  const rows = await env.DB.prepare(`SELECT id,detail_json,created_at FROM operational_audit
    WHERE owner_id=? AND event_type='LANE_1_TV_INGRESS'
    ORDER BY created_at DESC LIMIT 50`).bind(ownerId).all();
  for (const row of rows?.results ?? []) {
    const detail = parseObject(row.detail_json);
    const binding = await replayBindingFromIngressDetail(detail);
    if (!binding) continue;
    return { ingressId: row.id, receivedAt: detail.receivedAt ?? row.created_at,
      ticker: binding.replayBody.ticker, side: binding.replayBody.side,
      qty: binding.replayBody.qty, tvBodyBindingSha256: binding.tvBodyBindingSha256,
      replayEligible: true };
  }
  return null;
}

export async function previewStoredLane1Ingress({ env, ownerId, ingressId,
  now = () => Date.now(), uuid = () => crypto.randomUUID(), dependencies = {} }) {
  const refuse = (faultCode, status = 422) => ({ status, body: {
    state: 'DISARMED', disposition: 'preview-refused', faultCode, sent: false,
  } });
  if (env.NUVO_LANE_1_SPY_ARMED !== 'OFF') {
    return refuse('LANE_1_MARKET_PREVIEW_REQUIRES_ARMED_OFF');
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu
    .test(String(ingressId ?? ''))) return refuse('LANE_1_PREVIEW_SOURCE_ID_INVALID', 400);
  const row = await env.DB.prepare(`SELECT id,detail_json,created_at FROM operational_audit
    WHERE id=? AND owner_id=? AND event_type='LANE_1_TV_INGRESS' LIMIT 1`)
    .bind(ingressId, ownerId).first();
  if (!row) return refuse('LANE_1_PREVIEW_SOURCE_NOT_FOUND', 404);
  const detail = parseObject(row.detail_json);
  const binding = await replayBindingFromIngressDetail(detail);
  if (!binding) return refuse('LANE_1_PREVIEW_SOURCE_NOT_REPLAYABLE');
  const coordinator = dependencies.coordinator ?? coordinatorV2Adapter(env, ownerId);
  const before = await coordinator.status();
  if (before?.armed === true || before?.stage !== 'DISARMED') {
    return refuse('LANE_1_PREVIEW_REQUIRES_DURABLE_DISARMED');
  }
  const instant = now();
  if (!Number.isFinite(instant)) return refuse('LANE_1_PREVIEW_TIME_INVALID');
  const seal = await lane1V2ProposalSeal({ signal: binding.normalized.signal,
    rawSignalSide: binding.replayBody.side,
    tvBodyBindingSha256: binding.tvBodyBindingSha256,
    positionSide: before.positionSide ?? 'FLAT', now: instant, uuid,
    prior: before.open?.seal ?? null });
  if (!env.EVIDENCE?.put || !env.EVIDENCE?.get) {
    return refuse('LANE_1_PREVIEW_CAPTURE_BUCKET_REQUIRED');
  }
  let rawResponseEvidence = null;
  const client = dependencies.client ?? new SchwabD1Client(env);
  const preview = await client.previewLane1V21Market(ownerId,
    { instruction: seal.brokerInstruction },
    { accountHash: env.LANE_1_SCHWAB_ACCOUNT_HASH ?? null,
      captureResponse: async (response, { requestSha256 }) => {
        const captured = await capturePreviewResponse({ bucket: env.EVIDENCE, response,
          context: { ownerId, sourceIngressId: row.id, sourceIngressCreatedAt: row.created_at,
            tvBodyBindingSha256: binding.tvBodyBindingSha256, requestSha256,
            workerVersion: env.CF_VERSION_METADATA?.id ?? 'local' } });
        rawResponseEvidence = captured.evidence;
        return captured;
      } });
  const raw = typeof preview.rawResponseBody === 'string' ? preview.rawResponseBody : null;
  const response = parseObject(raw);
  const validation = response?.orderValidationResult;
  // Record the returned shape, never the parser's normalized empty lists.
  const responseEvidence = {
    rawResponseEvidence,
    responseObjectPresent: response !== null,
    validationPresent: validation !== undefined && validation !== null,
    rejects: validation?.rejects ?? null,
    reviews: validation?.reviews ?? null,
    warns: validation?.warns ?? null,
    alerts: validation?.alerts ?? null,
    validationFieldTypes: Object.fromEntries(['rejects', 'reviews', 'warns', 'alerts']
      .map((key) => [key, validation?.[key] === undefined ? 'missing'
        : validation[key] === null ? 'null'
          : Array.isArray(validation[key]) ? 'array' : typeof validation[key]])),
    orderContract: previewOrderContractEvidence(response, seal.brokerInstruction),
  };
  if (preview.status !== 'CLEAR' || !rawResponseEvidence?.complete) {
    const faultCode = preview.faultCode ?? (rawResponseEvidence?.complete
      ? 'LANE_1_PREVIEW_NOT_CLEAR' : 'LANE_1_PREVIEW_CAPTURE_MISSING');
    // Full response is private in R2; D1 holds its reference and bounded summary.
    let receipt;
    try {
      receipt = await recordOperationalProof(env, ownerId, 'LANE_1_ORDER_PREVIEW_REFUSED', {
        test: true, sent: false, faultCode,
        sourceIngressId: row.id, sourceIngressCreatedAt: row.created_at,
        replayBody: binding.replayBody, tvBodyBindingSha256: binding.tvBodyBindingSha256,
        requestSha256: preview.requestSha256 ?? null,
        rawResponseSha256: rawResponseEvidence?.sha256 ?? (raw === null ? null : await sha256(raw)),
        ...responseEvidence,
        schwabEndpoint: '/previewOrder', brokerInstruction: seal.brokerInstruction,
        quantity: 1, previewedAt: new Date(instant).toISOString(),
      });
      if (!receipt?.id) throw new Error('RECEIPT_NOT_WRITTEN');
    } catch {
      return { ...refuse('LANE_1_PREVIEW_RECEIPT_WRITE_FAILED'), body: {
        ...refuse('LANE_1_PREVIEW_RECEIPT_WRITE_FAILED').body, previewFaultCode: faultCode,
      } };
    }
    return { ...refuse(faultCode), body: { ...refuse(faultCode).body,
      ingressId: row.id, previewProofId: receipt.id,
    } };
  }
  const after = await coordinator.status();
  if (canonical(before) !== canonical(after)) {
    return refuse('LANE_1_PREVIEW_COORDINATOR_MUTATED');
  }
  const proof = await recordOperationalProof(env, ownerId, 'LANE_1_ORDER_PREVIEW', {
    test: true, sent: false, sourceIngressId: row.id,
    sourceIngressCreatedAt: row.created_at,
    replayBody: binding.replayBody,
    tvBodyBindingSha256: binding.tvBodyBindingSha256,
    proposalHash: seal.proposalHash, clientOrderId: seal.clientOrderId,
    signal: binding.normalized.signal, brokerInstruction: seal.brokerInstruction,
    quantity: 1, requestSha256: preview.requestSha256,
    rawResponseSha256: preview.rawResponseSha256,
    ...responseEvidence,
    schwabEndpoint: '/previewOrder', accountMask: preview.accountMask ?? null,
    coordinatorBefore: { armed: before.armed === true, stage: before.stage,
      positionSide: before.positionSide ?? 'FLAT', updatedAt: before.updatedAt ?? null },
    coordinatorAfter: { armed: after.armed === true, stage: after.stage,
      positionSide: after.positionSide ?? 'FLAT', updatedAt: after.updatedAt ?? null },
    previewedAt: new Date(instant).toISOString(),
  });
  return { status: 200, body: { state: 'DISARMED', disposition: 'previewed',
    sent: false, test: true, ingressId: row.id, previewProofId: proof?.id ?? null,
    tvBodyBindingSha256: binding.tvBodyBindingSha256,
    requestSha256: preview.requestSha256, rawResponseSha256: preview.rawResponseSha256,
    brokerInstruction: seal.brokerInstruction, quantity: 1,
    schwabEndpoint: '/previewOrder', armStillDisarmed: true } };
}

export async function handleLane1PreviewRequest({ request, env, ownerId }) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ faultCode: 'METHOD_NOT_ALLOWED' }), { status: 405,
      headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  let body;
  try { body = await readBoundedJson(request, 1_024); }
  catch (error) {
    return new Response(JSON.stringify({ faultCode: error.message, sent: false }), { status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(['ingressId'])) {
    return new Response(JSON.stringify({ faultCode: 'LANE_1_PREVIEW_REQUEST_INVALID', sent: false }), {
      status: 400, headers: { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store' },
    });
  }
  let result;
  try { result = await previewStoredLane1Ingress({ env, ownerId, ingressId: body.ingressId }); }
  catch (error) { result = { status: 422, body: { state: 'DISARMED',
    disposition: 'preview-refused',
    faultCode: String(error?.message ?? error).split(':')[0], sent: false } }; }
  return new Response(JSON.stringify(result.body), { status: result.status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

function easternDate(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function createLane1DiscordNotifier({
  webhookUrl, server, channel, fetcher = fetch,
}) {
  if (server !== 'NUVO VSIM' || channel !== 'test') {
    throw new Error('LANE_1_DISCORD_DESTINATION_REFUSED');
  }
  if (typeof webhookUrl !== 'string' || !/^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\//u.test(webhookUrl)) {
    throw new Error('LANE_1_DISCORD_WEBHOOK_NOT_CONFIGURED');
  }
  return Object.freeze({
    async send(message) {
      if (!ALLOWED_NOTICES.has(message?.type)) throw new Error('LANE_1_DISCORD_MESSAGE_REFUSED');
      const economicNotice = ['BOUGHT', 'SOLD', 'OPENED', 'EXITED'].includes(message.type);
      if (economicNotice && (!(Number(message.priceUsdPerShare) > 0)
        || !Number.isSafeInteger(message.quantity) || message.quantity !== 1
        || !Number.isSafeInteger(message.feesCents)
        || !Number.isSafeInteger(message.netCents))) {
        throw new Error('LANE_1_DISCORD_ECONOMICS_REQUIRED');
      }
      if (['OPENED', 'EXITED'].includes(message.type)
        && !['LONG', 'SHORT', 'FLAT'].includes(message.side)) {
        throw new Error('LANE_1_DISCORD_SIDE_REQUIRED');
      }
      if (['OPENED', 'EXITED'].includes(message.type)
        && (!message.brokerOrderId || !/^[a-f0-9]{64}$/u.test(message.tvBodyBindingSha256 ?? ''))) {
        throw new Error('LANE_1_DISCORD_TV_PARENT_REQUIRED');
      }
      const fields = [
        'LANE_1_SPY', message.type,
        message.reason ?? message.faultCode ?? null,
        message.fillId ? `fill=${message.fillId}` : null,
        economicNotice ? `price=${formatExecutionPrice(message.priceUsdPerShare)}` : null,
        economicNotice ? `qty=${message.quantity}` : null,
        economicNotice ? `fees=${formatCents(message.feesCents, { absolute: true })}` : null,
        economicNotice ? `net=${formatCents(message.netCents)}` : null,
        message.side ? `side=${message.side}` : null,
        message.fromSide ? `from=${message.fromSide}` : null,
        message.brokerOrderId ? `order=${message.brokerOrderId}` : null,
        message.tvBodyBindingSha256 ? `tv=${message.tvBodyBindingSha256.slice(0, 12)}` : null,
        message.stop ? `stop=fill${Number(message.stop.stopPriceOffset) >= 0 ? '+' : '-'}$${Math.abs(Number(message.stop.stopPriceOffset)).toFixed(2)}` : null,
        message.stop?.status ? `stopStatus=${message.stop.status}` : null,
        message.stop?.orderId ? `stopOrder=${message.stop.orderId}` : null,
      ].filter(Boolean);
      const body = JSON.stringify({ content: fields.join(' · '),
        allowed_mentions: { parse: [] } });
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const response = await fetcher(webhookUrl, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body,
            signal: AbortSignal.timeout(8_000),
          });
          if (response.ok) return;
          lastError = new Error(`LANE_1_DISCORD_${response.status}`);
        } catch (error) { lastError = error; }
      }
      throw lastError ?? new Error('LANE_1_DISCORD_DELIVERY_FAILED');
    },
  });
}

async function readBoundedJson(request, maximumBytes = 4_096) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error('LANE_1_BODY_TOO_LARGE');
  if (!request.body) throw new Error('LANE_1_BODY_REQUIRED');
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error('LANE_1_BODY_TOO_LARGE');
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(joined)); }
  catch { throw new Error('LANE_1_BODY_MALFORMED_JSON'); }
}

function coordinatorAdapter(env, ownerId) {
  if (!env.ACCOUNT_COORDINATOR) throw new Error('ACCOUNT_COORDINATOR_NOT_CONFIGURED');
  const stub = env.ACCOUNT_COORDINATOR.getByName(ownerId);
  return {
    ensure: (value) => stub.laneEnsure(value),
    claimSignal: (value) => stub.laneClaimSignal(value),
    recordBrokerAccepted: (value) => stub.laneRecordBrokerAccepted(value),
    recordUnit: (value) => stub.laneRecordUnit(value),
    recordFault: (value) => stub.laneRecordFault(value),
    recordRecoveredBuy: (value) => stub.laneRecordRecoveredBuy(value),
    claimPrincipalFlatten: (value) => stub.laneClaimPrincipalFlatten(value),
    recordPrincipalFlattenAccepted: (value) => stub.laneRecordPrincipalFlattenAccepted(value),
    disarm: (value) => stub.laneDisarm(value),
    status: () => stub.laneStatus(),
  };
}

function coordinatorV2Adapter(env, ownerId) {
  if (!env.ACCOUNT_COORDINATOR) throw new Error('ACCOUNT_COORDINATOR_NOT_CONFIGURED');
  const stub = env.ACCOUNT_COORDINATOR.getByName(ownerId);
  return {
    ensure: (value) => stub.laneV2Ensure(value),
    claim: (value) => stub.laneV2Claim(value),
    recordAccepted: (value) => stub.laneV2RecordAccepted(value),
    recordOpen: (value) => stub.laneV2RecordOpen(value),
    recordExit: (value) => stub.laneV2RecordExit(value),
    recordFault: (value) => stub.laneV2RecordFault(value),
    recordMarketValidation: (value) => stub.laneV2RecordMarketValidation(value),
    principalArm: (value) => stub.laneV2PrincipalArm(value),
    disarm: (value) => stub.laneV2Disarm(value),
    status: () => stub.laneV2Status(),
  };
}

function brokerAdapter(env, ownerId) {
  const client = new SchwabD1Client(env);
  const accountByOrder = new Map();
  return {
    async placeEquityOrder(order) {
      const accepted = await client.placeLane1EquityOrder(ownerId, order, {
        accountHash: env.LANE_1_SCHWAB_ACCOUNT_HASH ?? null,
      });
      accountByOrder.set(accepted.brokerOrderId, accepted.accountHash);
      return accepted;
    },
    async waitForFill(context) {
      return client.waitForLane1EquityFill(ownerId, {
        ...context,
        accountHash: accountByOrder.get(context.brokerOrderId)
          ?? env.LANE_1_SCHWAB_ACCOUNT_HASH ?? null,
      });
    },
  };
}

function brokerV2Adapter(env, ownerId) {
  const client = new SchwabD1Client(env);
  const coordinator = coordinatorV2Adapter(env, ownerId);
  const accountByOrder = new Map();
  const accountHash = (brokerOrderId = null) => brokerOrderId
    ? accountByOrder.get(brokerOrderId) ?? env.LANE_1_SCHWAB_ACCOUNT_HASH ?? null
    : env.LANE_1_SCHWAB_ACCOUNT_HASH ?? null;
  const durableArm = async () => (await coordinator.status())?.armed === true;
  return {
    position: () => client.lane1V2NetSpyPosition(ownerId, { accountHash: accountHash() }),
    async placeMarket({ instruction }) {
      const accepted = await client.placeLane1V21Market(ownerId, { instruction },
        { accountHash: accountHash(), durableArm: await durableArm() });
      accountByOrder.set(accepted.brokerOrderId, accepted.accountHash); return accepted;
    },
    waitForFill: async (context) => client.waitForLane1EquityFill(ownerId,
      { ...context, accountHash: accountHash(context.brokerOrderId),
        durableArm: await durableArm() }),
  };
}

function bundleStore(env, ownerId) {
  if (!env.EVIDENCE) throw new Error('LANE_1_EVIDENCE_BUCKET_REQUIRED');
  return {
    async write(emission) {
      const ownerHash = await sha256(ownerId);
      const prefix = `owners/${ownerHash}/lane-1-spy/${emission.manifest.economicEpisodeId}/${emission.manifestHash}`;
      const paths = Object.keys(emission.bytes).filter((path) => path !== 'manifest.json');
      paths.push('manifest.json');
      for (const path of paths) {
        const key = `${prefix}/${path}`;
        const existing = await env.EVIDENCE.get(key);
        if (existing) {
          const prior = await existing.text();
          if (await sha256(prior) !== emission.files[path].sha256) {
            throw new Error(`LANE_1_IMMUTABLE_OBJECT_CONFLICT:${path}`);
          }
          continue;
        }
        await env.EVIDENCE.put(key, emission.bytes[path], {
          httpMetadata: { contentType: 'application/json; charset=utf-8' },
          customMetadata: {
            lane: 'LANE_1_SPY', sha256: emission.files[path].sha256,
            resolvedUnitId: emission.manifest.resolvedUnitId,
          },
        });
      }
      return { objectPrefix: prefix };
    },
  };
}

function notifier(env, ownerId) {
  return {
    async send(message) {
      try {
        await createLane1DiscordNotifier({
          webhookUrl: env.LANE_1_DISCORD_WEBHOOK_URL,
          server: env.NUVO_LANE_1_DISCORD_SERVER,
          channel: env.NUVO_LANE_1_DISCORD_CHANNEL,
        }).send(message);
        await recordOperationalProof(env, ownerId, 'LANE_1_DISCORD_DELIVERED', {
          noticeType: message.type,
          deliveredAt: new Date().toISOString(),
        }).catch(() => {});
      } catch (error) {
        await recordOperationalProof(env, ownerId, 'LANE_1_DISCORD_FAILED', {
          noticeType: message?.type ?? null,
          failedAt: new Date().toISOString(),
          error: String(error?.message ?? error),
        }).catch(() => {});
        throw error;
      }
    },
  };
}

export function createLane1Runtime(env, ownerId, { now = () => Date.now() } = {}) {
  const client = new SchwabD1Client(env);
  return createLane1SpyV2Controller({
    config: {
      armed: env.NUVO_LANE_1_SPY_ARMED === 'ON',
      armedAt: env.NUVO_LANE_1_SPY_ARMED_AT,
      ttlMs: 86_400_000,
      ownerId,
      secret: env.LANE_1_TV_WEBHOOK_SECRET,
      notificationsReady: env.NUVO_LANE_1_DISCORD_SERVER === 'NUVO VSIM'
        && env.NUVO_LANE_1_DISCORD_CHANNEL === 'test'
        && typeof env.LANE_1_DISCORD_WEBHOOK_URL === 'string'
        && /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\//u
          .test(env.LANE_1_DISCORD_WEBHOOK_URL),
    },
    coordinator: coordinatorV2Adapter(env, ownerId),
    broker: brokerV2Adapter(env, ownerId),
    bundleStore: bundleStore(env, ownerId),
    notifier: notifier(env, ownerId),
    marketSession: async () => {
      const instant = now();
      const hours = await client.marketHours(ownerId, {
        markets: ['equity'], date: easternDate(instant),
      });
      return sessionStatus(hours, instant) === 'OPEN' ? 'RTH' : 'CLOSED';
    },
    now,
  });
}

export async function validateLane1V21Market({ env, ownerId }) {
  if (env.NUVO_LANE_1_SPY_ARMED !== 'OFF') {
    return { status: 422, body: { state: 'FAULT', faultCode: 'LANE_1_MARKET_PREVIEW_REQUIRES_ARMED_OFF' } };
  }
  try {
    const validation = await new SchwabD1Client(env).previewLane1V21Markets(ownerId, {
      accountHash: env.LANE_1_SCHWAB_ACCOUNT_HASH ?? null,
    });
    const durableValidation = structuredClone(validation);
    durableValidation.previews = durableValidation.previews.map(({ rawResponseBody: _raw, ...row }) => row);
    await coordinatorV2Adapter(env, ownerId).recordMarketValidation(durableValidation);
    return { status: 200, body: { state: 'VALIDATED', contractVersion: validation.contractVersion,
      longEnabled: validation.longEnabled, shortEnabled: validation.shortEnabled,
      accountMask: validation.accountMask,
      previews: validation.previews, validatedAt: validation.validatedAt } };
  } catch (error) {
    return { status: 422, body: { state: 'FAULT', faultCode: String(error?.message ?? error).split(':')[0] } };
  }
}

export async function armLane1FromDashboard({ env, ownerId, now = () => Date.now() }) {
  const armedAtMs = now();
  const expiresAtMs = armedAtMs + 86_400_000;
  if (!Number.isFinite(armedAtMs)) {
    return { status: 422, body: { armed: false,
      faultCode: 'LANE_1_PRINCIPAL_ARM_TIME_INVALID' } };
  }
  try {
    const state = await coordinatorV2Adapter(env, ownerId).principalArm({
      reason: 'PRINCIPAL_DASHBOARD_ARM',
      armedAt: new Date(armedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
    return { status: 200, body: { armed: state.armed === true,
      state: state.stage, reason: 'PRINCIPAL_DASHBOARD_ARM',
      expiresAt: state.expiresAt } };
  } catch (error) {
    return { status: 422, body: { armed: false,
      faultCode: String(error?.message ?? error).split(':')[0] } };
  }
}

export async function handleLane1TvWebhook({ request, env, ownerId }) {
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }), { status: 405 });
  let body;
  try { body = await readBoundedJson(request); }
  catch (error) {
    return new Response(JSON.stringify({ faultCode: error.message }), {
      status: 400, headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const authenticated = await secretMatches(body?.secret, env.LANE_1_TV_WEBHOOK_SECRET);
  if (authenticated) {
    const replayBody = replayBodyFromAuthenticatedLane1V21Signal(body);
    const binding = replayBody ? await bindLane1V21ReplayBody(replayBody) : null;
    await recordOperationalProof(env, ownerId, 'LANE_1_TV_INGRESS', {
      receivedAt: new Date().toISOString(),
      side: String(body?.side ?? '').trim().toUpperCase() || null,
      replayEligible: binding !== null,
      replayBody: binding?.replayBody ?? null,
      tvBodyBindingSha256: binding?.tvBodyBindingSha256 ?? null,
    }).catch(() => {});
  }
  if (String(body?.kind ?? '').trim().toUpperCase() === 'TAPE') {
    if (!authenticated) {
      return new Response(JSON.stringify({ faultCode: 'LANE_1_SECRET_INVALID', sent: false }), {
        status: 401, headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    const spy = Number(body?.spy);
    const vix = Number(body?.vix);
    const asOfMs = Date.parse(String(body?.asOf ?? ''));
    const ageMs = Date.now() - asOfMs;
    const valid = String(body?.source ?? '').trim().toUpperCase() === 'TRADINGVIEW'
      && String(body?.ticker ?? '').trim().toUpperCase() === 'SPY'
      && Number.isFinite(spy) && spy > 0 && Number.isFinite(vix) && vix > 0
      && Number.isFinite(asOfMs) && ageMs >= -5_000 && ageMs <= 300_000;
    if (!valid) {
      return new Response(JSON.stringify({ faultCode: 'LANE_1_TV_TAPE_INVALID', sent: false }), {
        status: 400, headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    await recordOperationalProof(env, ownerId, 'LANE_1_TV_TAPE', {
      receivedAt: new Date().toISOString(), source: 'TRADINGVIEW', spy, vix,
      asOf: new Date(asOfMs).toISOString(),
    }).catch(() => {});
    return new Response(JSON.stringify({ state: 'OBSERVED', disposition: 'tape', sent: false }), {
      status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  let result;
  try { result = await createLane1Runtime(env, ownerId).signal(body); }
  catch (error) { result = { status: 200, body: { state: 'FAULT',
    faultCode: error.message, sent: false } }; }
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function disarmLane1FromDashboard({ env, ownerId, now = () => Date.now() }) {
  const atMs = now();
  if (!Number.isFinite(atMs)) {
    return { status: 422, body: {
      faultCode: 'LANE_1_PRINCIPAL_DISARM_TIME_INVALID' } };
  }
  try {
    const state = await coordinatorV2Adapter(env, ownerId).disarm({
      reason: 'PRINCIPAL_DASHBOARD_DISARM', at: new Date(atMs).toISOString(),
    });
    return { status: 200, body: { armed: false,
      state: state.stage ?? 'DISARMED', reason: 'PRINCIPAL_DASHBOARD_DISARM' } };
  } catch (error) {
    return { status: 422, body: {
      faultCode: String(error?.message ?? error).split(':')[0] } };
  }
}

const PRINCIPAL_FLATTEN_KEYS = Object.freeze([
  'buyExecutionActivityId', 'buyOrderId', 'buyPrice', 'buyTransactionActivityId',
  'buyOccurredAt', 'confirm', 'quantity', 'symbol',
].sort());

function validPrincipalFlatten(body) {
  return body && typeof body === 'object' && !Array.isArray(body)
    && JSON.stringify(Object.keys(body).sort()) === JSON.stringify(PRINCIPAL_FLATTEN_KEYS)
    && body.confirm === 'FLATTEN_1_SPY' && body.symbol === 'SPY' && body.quantity === 1
    && String(body.buyOrderId) === '1007749775388'
    && String(body.buyExecutionActivityId) === '129347484620'
    && String(body.buyTransactionActivityId) === '129347484622'
    && Number(body.buyPrice) === 771.785
    && body.buyOccurredAt === '2026-08-28T14:21:39.000Z';
}

export async function flattenLane1ByPrincipal({ body, env, ownerId,
  now = () => Date.now(), uuid = () => crypto.randomUUID(), dependencies = {} }) {
  if (!validPrincipalFlatten(body)) {
    return { status: 400, body: { state: 'FAULT', faultCode: 'PRINCIPAL_FLATTEN_TOKEN_INVALID' } };
  }
  if (env.NUVO_LANE_1_SPY_ARMED !== 'OFF') {
    return { status: 409, body: { state: 'FAULT', faultCode: 'LANE_1_FLATTEN_REQUIRES_ARMED_OFF' } };
  }
  const coordinator = dependencies.coordinator ?? coordinatorAdapter(env, ownerId);
  const client = dependencies.client ?? new SchwabD1Client(env);
  const store = dependencies.bundleStore ?? bundleStore(env, ownerId);
  const notices = dependencies.notifier ?? notifier(env, ownerId);
  let state = await coordinator.status();
  try {
    if (state.stage === 'FAULT') {
      const buySeal = state.buy?.seal;
      if (!buySeal?.clientOrderId || String(state.fault?.brokerOrderId ?? '') !== body.buyOrderId) {
        throw new Error('LANE_1_RECOVERY_CONTEXT_MISSING');
      }
      const buyFill = await client.lane1FillFromStoredBrokerEvents(ownerId, {
        brokerOrderId: body.buyOrderId,
        executionActivityId: body.buyExecutionActivityId,
        transactionActivityId: body.buyTransactionActivityId,
        clientOrderId: buySeal.clientOrderId,
        side: 'BUY', expectedPrice: body.buyPrice, expectedOccurredAt: body.buyOccurredAt,
      });
      const buyAccepted = {
        brokerOrderId: body.buyOrderId,
        acceptedAt: state.buy?.acceptedAt ?? body.buyOccurredAt,
      };
      const buyEvents = appendLane1BrokerEvents(state, buySeal, buyAccepted, buyFill);
      const buyUnit = await materializeLane1SpyUnit({ events: buyEvents, fill: buyFill,
        bundleStore: store });
      state = await coordinator.recordRecoveredBuy({
        unit: buyUnit,
        buy: { brokerOrderId: body.buyOrderId, acceptedAt: buyAccepted.acceptedAt,
          executionActivityId: body.buyExecutionActivityId,
          transactionActivityId: body.buyTransactionActivityId },
      });
      await notices.send({ type: 'BOUGHT', symbol: 'SPY', quantity: 1,
        fillId: buyUnit.buyFillId, manifestHash: buyUnit.manifestHash,
        priceUsdPerShare: buyUnit.buyPriceUsdPerShare,
        feesCents: buyUnit.buyFeeCents, netCents: buyUnit.netCashMovementCents });
    }
    if (state.stage !== 'FLATTEN_READY' || state.armed) {
      throw new Error('LANE_1_FLATTEN_STATE_REFUSED');
    }

    const instant = now();
    const marketOpen = dependencies.marketSession
      ? await dependencies.marketSession()
      : sessionStatus(await client.marketHours(ownerId, {
        markets: ['equity'], date: easternDate(instant),
      }), instant) === 'OPEN';
    if (!marketOpen) throw new Error('LANE_1_RTH_REQUIRED');

    const seal = await lane1ProposalSeal({ side: 'SELL', now: instant, uuid,
      prior: state.buy?.seal ?? null });
    const claim = await coordinator.claimPrincipalFlatten({ seal });
    if (!claim.claimed) throw new Error('LANE_1_FLATTEN_ALREADY_CLAIMED');
    state = claim.state;
    const accepted = await client.placeLane1PrincipalFlattenOrder(ownerId, {
      symbol: 'SPY', side: 'SELL', quantity: 1,
    }, { accountHash: env.LANE_1_SCHWAB_ACCOUNT_HASH ?? null,
      principalToken: body.confirm });
    state = await coordinator.recordPrincipalFlattenAccepted({
      brokerOrderId: accepted.brokerOrderId, acceptedAt: accepted.acceptedAt,
    });
    const sellFill = await client.waitForLane1PrincipalFlattenFill(ownerId, {
      brokerOrderId: accepted.brokerOrderId, clientOrderId: seal.clientOrderId,
      accountHash: accepted.accountHash,
    });
    const events = appendLane1BrokerEvents(state, seal, accepted, sellFill);
    const unit = await materializeLane1SpyUnit({ events, fill: sellFill, bundleStore: store });
    state = await coordinator.recordUnit({ side: 'SELL', unit });
    await notices.send({ type: 'SOLD', symbol: 'SPY', quantity: 1,
      fillId: unit.sellFillId, manifestHash: unit.manifestHash,
      priceUsdPerShare: unit.sellPriceUsdPerShare,
      feesCents: unit.totalFeesCents, netCents: unit.realizedPnlCents });
    await notices.send({ type: 'DISARMED', reason: 'ROUND_TRIP_COMPLETE', state: 'DISARMED' });
    return { status: 200, body: {
      state: state.stage, sellActivityId: unit.sellFillId,
      realizedPnlCents: unit.realizedPnlCents,
      realizedPnlUsd: centsToUsd(unit.realizedPnlCents), manifestHash: unit.manifestHash,
      resolvedUnitId: unit.resolvedUnitId,
    } };
  } catch (error) {
    const code = String(error?.message ?? error).split(':')[0];
    const acceptedOrderId = state?.sell?.brokerOrderId ?? null;
    const faultState = await coordinator.recordFault({
      faultCode: code, detail: String(error?.message ?? error),
      brokerOrderId: acceptedOrderId, at: new Date(now()).toISOString(),
    });
    try { await notices.send({ type: 'FAULT', faultCode: code,
      brokerOrderId: acceptedOrderId, state: faultState.stage }); } catch { /* diary is authoritative */ }
    return { status: 422, body: { state: faultState.stage, faultCode: code,
      brokerOrderId: acceptedOrderId } };
  }
}

export async function handlePrincipalFlatten({ request, env, ownerId, dependencies = {} }) {
  void request; void env; void ownerId; void dependencies;
  return new Response(JSON.stringify({ state: 'DISABLED', faultCode: 'LANE_1_FLATTEN_ROUTE_RETIRED' }), {
    status: 410, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
  /* c8 ignore start -- preserved only for rollback evidence; the route returns above. */
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ faultCode: 'METHOD_NOT_ALLOWED' }), {
      status: 405, headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  if (!await secretMatches(request.headers.get('x-nuvo-principal-flatten-token'),
    env.LANE_1_PRINCIPAL_FLATTEN_TOKEN)) {
    return new Response(JSON.stringify({ faultCode: 'PRINCIPAL_FLATTEN_UNAUTHORIZED' }), {
      status: 401, headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  let body;
  try { body = await readBoundedJson(request); }
  catch (error) {
    return new Response(JSON.stringify({ faultCode: error.message }), {
      status: 400, headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const result = await flattenLane1ByPrincipal({ body, env, ownerId, dependencies });
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
  /* c8 ignore stop */
}

export async function lane1Status(env, ownerId) {
  return coordinatorV2Adapter(env, ownerId).status();
}

export async function expireLane1(env, ownerId) {
  try {
    const runtime = createLane1Runtime(env, ownerId);
    const reconciled = await runtime.reconcile();
    return reconciled ?? await runtime.expire();
  }
  catch (error) {
    if (env.NUVO_LANE_1_SPY_ARMED === 'ON') throw error;
    return null;
  }
}
