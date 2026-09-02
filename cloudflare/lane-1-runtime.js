import {
  appendLane1BrokerEvents, createLane1SpyController, lane1ProposalSeal,
  materializeLane1SpyUnit,
} from '../src/lane/lane-1-spy.js';
import {
  appendLane1V2BrokerEvents, bindLane1V21ReplayBody, createLane1SpyV2Controller,
  lane1V2ProposalSeal, materializeLane1V2Unit, replayBodyFromAuthenticatedLane1V21Signal,
} from '../src/lane/lane-1-spy-v2.js';
import { sessionStatus } from '../src/truth/providers/schwab.js';
import { LANE_1_PREVIEW_ASSET_TYPES, SchwabD1Client } from './schwab-client.js';
import { capturePreviewResponse } from './preview-response-evidence.js';
import { centsToUsd, formatCents, formatExecutionPrice } from '../src/economic/money-cents.js';
import { assertLane1FillEvidence, lane1FillIdentity,
  sameLane1FillIdentity } from '../src/lane/lane-1-fill-contract.js';

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

function previewOrderContractEvidence(response, instruction, originalResponse) {
  const order = response?.orderStrategy;
  const leg = order?.orderLegs?.[0];
  // Explicit allowlist: no account, token, full response, or arbitrary objects.
  const scalar = (value) => typeof value === 'string' ? value.slice(0, 128)
    : typeof value === 'number' || typeof value === 'boolean' ? value : null;
  const fieldType = (value) => value === undefined ? 'missing' : value === null ? 'null'
    : Array.isArray(value) ? 'array' : typeof value;
  const originalOrder = originalResponse?.orderStrategy;
  const originalLeg = originalOrder?.orderLegs?.[0];
  return {
    responseLegSource: 'orderStrategy.orderLegs',
    mappedPaths: { quantity: 'orderStrategy.quantity',
      symbol: 'orderStrategy.orderLegs[0].instrument.symbol',
      assetType: 'orderStrategy.orderLegs[0].assetType',
      instrumentAssetType: 'orderStrategy.orderLegs[0].instrument.assetType' },
    fieldTypes: { quantity: fieldType(originalOrder?.quantity),
      symbol: fieldType(originalLeg?.instrument?.symbol),
      assetType: fieldType(originalLeg?.assetType),
      instrumentAssetType: fieldType(originalLeg?.instrument?.assetType) },
    assetPolicy: { allowed: LANE_1_PREVIEW_ASSET_TYPES, bothPathsMustAgree: true },
    expected: { orderType: 'MARKET', orderStrategyType: 'SINGLE', session: 'NORMAL',
      duration: 'DAY', legCount: 1, childCount: 0, instruction, quantity: 1,
      symbol: 'SPY' },
    actual: {
      orderType: scalar(order?.orderType), orderStrategyType: scalar(order?.orderStrategyType),
      session: scalar(order?.session), duration: scalar(order?.duration),
      legCount: Array.isArray(order?.orderLegs) ? order.orderLegs.length : null,
      childCount: order?.childOrderStrategies === undefined ? 0
        : Array.isArray(order.childOrderStrategies) ? order.childOrderStrategies.length : null,
      instruction: scalar(leg?.instruction), quantity: scalar(order?.quantity),
      symbol: scalar(leg?.instrument?.symbol), assetType: scalar(leg?.assetType),
      instrumentAssetType: scalar(leg?.instrument?.assetType),
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
    positionSide: before.positionSide ?? null, now: instant, uuid,
    prior: before.open?.seal ?? null });
  if (!env.EVIDENCE?.put || !env.EVIDENCE?.get) {
    return refuse('LANE_1_PREVIEW_CAPTURE_BUCKET_REQUIRED');
  }
  let rawResponseEvidence = null;
  let inspection = null;
  const client = dependencies.client ?? new SchwabD1Client(env);
  const preview = await client.previewLane1V21Market(ownerId,
    { instruction: seal.brokerInstruction },
    { accountHash: env.LANE_1_SCHWAB_ACCOUNT_HASH ?? null,
      captureResponse: async (response, { requestSha256 }) => {
        const captured = await capturePreviewResponse({ bucket: env.EVIDENCE, response,
          publicKey: dependencies.previewEvidencePublicKey,
          context: { ownerId, sourceIngressId: row.id, sourceIngressCreatedAt: row.created_at,
            tvBodyBindingSha256: binding.tvBodyBindingSha256, requestSha256,
            workerVersion: env.CF_VERSION_METADATA?.id ?? 'local' } });
        rawResponseEvidence = captured.evidence;
        inspection = captured.inspection;
        return captured;
      } });
  const raw = typeof preview.rawResponseBody === 'string' ? preview.rawResponseBody : null;
  const originalResponse = parseObject(raw);
  const response = inspection?.body ?? null;
  const validation = response?.orderValidationResult;
  const originalValidation = originalResponse?.orderValidationResult;
  // Record the returned shape, never the parser's normalized empty lists.
  const responseEvidence = {
    rawResponseEvidence,
    redactionVersion: inspection?.redactionVersion ?? null,
    removedPaths: inspection?.removedPaths ?? [],
    responseObjectPresent: originalResponse !== null,
    validationPresent: originalValidation !== undefined && originalValidation !== null,
    rejects: validation?.rejects ?? null,
    reviews: validation?.reviews ?? null,
    warns: validation?.warns ?? null,
    alerts: validation?.alerts ?? null,
    validationFieldTypes: Object.fromEntries(['rejects', 'reviews', 'warns', 'alerts']
      .map((key) => [key, originalValidation?.[key] === undefined ? 'missing'
        : originalValidation[key] === null ? 'null'
          : Array.isArray(originalValidation[key]) ? 'array' : typeof originalValidation[key]])),
    orderContract: previewOrderContractEvidence(response, seal.brokerInstruction, originalResponse),
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
      positionSide: before.positionSide ?? null, updatedAt: before.updatedAt ?? null },
    coordinatorAfter: { armed: after.armed === true, stage: after.stage,
      positionSide: after.positionSide ?? null, updatedAt: after.updatedAt ?? null },
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
        message.evidenceOrigin ? `origin=${message.evidenceOrigin}` : null,
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

export async function readBoundedJson(request, maximumBytes = 4_096) {
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
    recordPendingFill: (value) => stub.laneV2RecordPendingFill(value),
    recordOpen: (value) => stub.laneV2RecordOpen(value),
    recordExit: (value) => stub.laneV2RecordExit(value),
    recordFault: (value) => stub.laneV2RecordFault(value),
    recordMarketValidation: (value) => stub.laneV2RecordMarketValidation(value),
    principalArm: (value) => stub.laneV2PrincipalArm(value),
    principalArmExisting: (value) => stub.laneV2PrincipalArmExisting(value),
    recoverOpen: (value) => stub.laneV2RecoverOpen(value),
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
    sendSnapshot: () => client.lane1V21SendSnapshot(ownerId, { accountHash: accountHash() }),
    async placeMarket({ instruction, clientOrderId, expectedSnapshot }) {
      const accepted = await client.placeLane1V21Market(ownerId, { instruction, clientOrderId },
        { accountHash: accountHash(), durableArm: await durableArm(), expectedSnapshot,
          readCoordinator: () => coordinator.status() });
      accountByOrder.set(accepted.brokerOrderId, accepted.accountHash); return accepted;
    },
    waitForFill: async (context) => client.waitForLane1EquityFill(ownerId,
      { ...context, accountHash: accountHash(context.brokerOrderId),
        durableArm: await durableArm(), attempts: 1, pollMs: 0 }),
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

function fillReceiptStore(env, ownerId) {
  return {
    async write(receipt) {
      const proof = await recordOperationalProof(env, ownerId, 'LANE_1_FILL_RECEIPT', {
        qualifiedStage0Fill: receipt.evidenceOrigin === 'SCHWAB_WIRE_CAPTURE', ...receipt,
      });
      if (!proof?.id) throw new Error('LANE_1_FILL_RECEIPT_WRITE_FAILED');
      return proof;
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
    receiptStore: fillReceiptStore(env, ownerId),
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

export async function resumeLane1PendingFill({ env, ownerId, coordinator,
  now = () => Date.now(), dependencies = {} }) {
  const state = await coordinator.status();
  const pending = state?.pendingFill;
  if (!pending || !['FILL_PENDING_EXECUTION', 'FILL_PENDING_FEE'].includes(state.stage)) {
    return { status: 'NO_PENDING_FILL', terminal: true };
  }
  const instant = now();
  if (!Number.isFinite(instant) || instant >= Date.parse(pending.deadlineAt)) {
    const fault = await coordinator.recordFault({ faultCode: 'FILL_ECONOMICS_TIMEOUT',
      detail: 'FILL_ECONOMICS_TIMEOUT:120_SECONDS', brokerOrderId: pending.brokerOrderId,
      at: new Date(Number.isFinite(instant) ? instant : Date.now()).toISOString() });
    try { await (dependencies.notifier ?? notifier(env, ownerId)).send({ type: 'FAULT',
      faultCode: 'FILL_ECONOMICS_TIMEOUT', brokerOrderId: pending.brokerOrderId }); } catch { /* DO history is authoritative. */ }
    return { status: fault.stage, terminal: true, faultCode: 'FILL_ECONOMICS_TIMEOUT' };
  }
  const client = dependencies.client ?? new SchwabD1Client(env);
  let fill;
  try {
    fill = await client.waitForLane1V2RecordedFill(ownerId, {
      brokerOrderId: pending.brokerOrderId, clientOrderId: pending.clientOrderId,
      side: pending.side, accountHash: pending.accountHash, attempts: 1, pollMs: 0,
    });
  } catch (error) {
    if (!['FILL_PENDING_EXECUTION', 'FILL_PENDING_FEE'].includes(error?.message)) throw error;
    const next = await coordinator.recordPendingFill({ ...pending, ...error.pendingFill,
      ownerId, signal: pending.signal, seal: pending.seal, accepted: pending.accepted,
      startedAt: pending.startedAt, deadlineAt: pending.deadlineAt,
      pendingReason: error.message === 'FILL_PENDING_FEE' ? 'MISSING_FEE' : pending.pendingReason,
      attempt: Number(pending.attempt ?? 0) + 1 });
    return { status: next.stage, terminal: false, deadlineAt: pending.deadlineAt };
  }
  const evidenceOrigin = fill.evidenceOrigin ?? 'SCHWAB_WIRE_CAPTURE';
  fill.captureEvidence = { acceptance: pending.accepted?.orderAcceptanceEvidence,
    ...fill.captureEvidence };
  assertLane1FillEvidence(fill.captureEvidence, evidenceOrigin);
  const identity = lane1FillIdentity({ fill,
    tvBodyBindingSha256: pending.tvBodyBindingSha256 });
  const events = appendLane1V2BrokerEvents(state, pending.seal, pending.accepted, fill);
  const unit = await materializeLane1V2Unit({ events, fill, stop: null,
    bundleStore: dependencies.bundleStore ?? bundleStore(env, ownerId) });
  const receipt = await (dependencies.receiptStore ?? fillReceiptStore(env, ownerId)).write({
    type: pending.signal === 'EXIT' ? 'EXIT_FILLED' : 'OPEN_FILLED',
    signal: pending.signal, identity, evidenceOrigin,
    captureEvidence: fill.captureEvidence, manifestHash: unit.manifestHash,
    resolvedUnitId: unit.resolvedUnitId,
    realizedPnlCents: pending.signal === 'EXIT' ? unit.realizedPnlCents : null,
    recordedAt: fill.acquiredAt,
  });
  const next = pending.signal === 'EXIT'
    ? await coordinator.recordExit({ unit, cancellation: null, identity, evidenceOrigin,
      captureEvidence: fill.captureEvidence, receiptId: receipt.id })
    : await coordinator.recordOpen({ signal: pending.signal, unit, identity, evidenceOrigin,
      captureEvidence: fill.captureEvidence, receiptId: receipt.id });
  const notice = pending.signal === 'EXIT'
    ? { type: 'EXITED', side: 'FLAT', fromSide: state.positionSide, symbol: 'SPY', quantity: 1,
      fillId: unit.closingFillId, manifestHash: unit.manifestHash,
      priceUsdPerShare: unit.closingPriceUsdPerShare, feesCents: unit.totalFeesCents,
      netCents: unit.realizedPnlCents, brokerOrderId: pending.brokerOrderId,
      tvBodyBindingSha256: pending.tvBodyBindingSha256, evidenceOrigin }
    : { type: 'OPENED', side: pending.signal, symbol: 'SPY', quantity: 1,
      fillId: unit.openingFillId, manifestHash: unit.manifestHash,
      priceUsdPerShare: unit.openingPriceUsdPerShare, feesCents: unit.openingFeeCents,
      netCents: unit.netCashMovementCents, brokerOrderId: pending.brokerOrderId,
      tvBodyBindingSha256: pending.tvBodyBindingSha256, evidenceOrigin };
  await (dependencies.notifier ?? notifier(env, ownerId)).send(notice);
  return { status: next.stage, terminal: true, receiptId: receipt.id,
    manifestHash: unit.manifestHash };
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

export async function armLane1FromDashboard({ env, ownerId, principalConfirmation,
  now = () => Date.now(), dependencies = {} }) {
  const armedAtMs = now();
  const expiresAtMs = armedAtMs + 86_400_000;
  if (!Number.isFinite(armedAtMs)) {
    return { status: 422, body: { armed: false,
      faultCode: 'LANE_1_PRINCIPAL_ARM_TIME_INVALID' } };
  }
  const coordinator = dependencies.coordinator ?? coordinatorV2Adapter(env, ownerId);
  let liveState;
  try { liveState = await coordinator.status(); }
  catch (error) {
    return { status: 503, body: { armed: false,
      faultCode: String(error?.message ?? error).split(':')[0] } };
  }
  if (principalConfirmation !== 'ARM_LANE_1_CURRENT_STATE') {
    return { status: 400, body: { armed: false,
      faultCode: 'LANE_1_ARM_CONFIRMATION_REQUIRED' } };
  }
  if (liveState?.pendingFill || ['FILL_PENDING_EXECUTION', 'FILL_PENDING_FEE']
    .includes(liveState?.stage)) {
    return { status: 409, body: { armed: false, state: liveState?.stage,
      faultCode: 'LANE_1_ARM_FILL_PENDING' } };
  }
  if (liveState?.fault || liveState?.stage === 'FAULT') {
    return { status: 409, body: { armed: false, state: liveState?.stage,
      faultCode: 'LANE_1_ARM_FAULT_PRESENT' } };
  }
  if (['OPEN_SHORT', 'OPEN_LONG'].includes(liveState?.stage)) {
    const side = liveState.stage === 'OPEN_SHORT' ? 'SHORT' : 'LONG';
    if (liveState.positionSide !== side) {
      return { status: 409, body: { armed: false, state: liveState.stage,
        faultCode: 'LANE_1_ARM_STATE_POSITION_MISMATCH' } };
    }
    return armExistingLane1FromDashboard({ env, ownerId,
      principalConfirmation: `ARM_EXISTING_${side}_1_SPY`, now,
      dependencies: { ...dependencies, coordinator } });
  }
  if (!['FLAT', 'DISARMED'].includes(liveState?.stage)
    || liveState?.positionSide !== 'FLAT') {
    return { status: 409, body: { armed: false, state: liveState?.stage ?? 'UNKNOWN',
      faultCode: 'LANE_1_ARM_STAGE_REFUSED' } };
  }
  try {
    const state = await coordinator.principalArm({
      reason: 'PRINCIPAL_DASHBOARD_ARM',
      armedAt: new Date(armedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
    return { status: 200, body: { armed: state.armed === true,
      state: state.stage, reason: 'PRINCIPAL_DASHBOARD_ARM',
      positionSide: state.positionSide, instructionAllowed: ['BUY', 'SELL_SHORT'],
      expiresAt: state.expiresAt } };
  } catch (error) {
    return { status: 422, body: { armed: false,
      faultCode: String(error?.message ?? error).split(':')[0] } };
  }
}

export async function reconcileLane1OpenFromBrokerLedger({ env, ownerId,
  principalConfirmation, dependencies = {} }) {
  if (principalConfirmation !== 'RECONCILE_BROKER_LEDGER_OPEN') {
    return { status: 400, body: { state: 'REFUSED',
      faultCode: 'LANE_1_RECOVERY_CONFIRMATION_REQUIRED' } };
  }
  const coordinator = dependencies.coordinator ?? coordinatorV2Adapter(env, ownerId);
  const client = dependencies.client ?? new SchwabD1Client(env);
  let brokerSnapshot;
  try {
    // Broker first. Coordinator state must never suppress this read.
    brokerSnapshot = await client.lane1V21SendSnapshot(ownerId, {
      accountHash: env.LANE_1_SCHWAB_ACCOUNT_HASH ?? null,
    });
  } catch (error) {
    return { status: 503, body: { state: 'UNKNOWN',
      faultCode: 'BROKER_UNREACHABLE', detail: String(error?.message ?? error) } };
  }
  const state = await coordinator.status();
  if (state.pendingFill) {
    return { status: 409, body: { state: state.stage,
      faultCode: 'LANE_1_RECONCILIATION_FILL_PENDING',
      coordinatorPositionSide: state.positionSide ?? 'UNKNOWN',
      brokerPositionSide: brokerSnapshot.positionSide,
      coordinatorUpdatedAt: state.updatedAt ?? null,
      brokerAcquiredAt: brokerSnapshot.acquiredAt } };
  }
  if (brokerSnapshot.positionSide === state.positionSide
    && state.entryIdentity?.evidenceOrigin !== 'BROKER_LEDGER_RECONSTRUCTION') {
    return { status: 200, body: { state: state.stage, disposition: 'already-reconciled',
      positionSide: state.positionSide, acquiredAt: brokerSnapshot.acquiredAt } };
  }
  if (state.armed || !['FLAT', 'SHORT'].includes(state.positionSide)
    || brokerSnapshot.positionSide !== 'SHORT'
    || !state.open?.seal?.clientOrderId || !state.open?.brokerOrderId) {
    return { status: 409, body: { state: 'POSITION_DRIFT',
      faultCode: 'LANE_1_RECOVERY_CONTEXT_MISSING',
      coordinatorPositionSide: state.positionSide ?? 'UNKNOWN',
      brokerPositionSide: brokerSnapshot.positionSide,
      coordinatorUpdatedAt: state.updatedAt ?? null,
      brokerAcquiredAt: brokerSnapshot.acquiredAt } };
  }
  try {
    const seal = state.open.seal;
    if (state.entryIdentity?.evidenceOrigin === 'BROKER_LEDGER_RECONSTRUCTION') {
      const candidate = await client.lane1V2RecoverableStoredFill(ownerId, {
        brokerOrderId: state.open.brokerOrderId, clientOrderId: seal.clientOrderId,
        side: 'SELL_SHORT', accountHash: brokerSnapshot.accountHash, capture: false,
      });
      const candidateIdentity = lane1FillIdentity({ fill: candidate,
        tvBodyBindingSha256: seal.tvBodyBindingSha256 });
      if (sameLane1FillIdentity(state.entryIdentity.identity, candidateIdentity)) {
        if (state.stage === 'FAULT') {
          const restored = await coordinator.recoverOpen({ signal: 'SHORT',
            unit: state.latestUnit, identity: state.entryIdentity.identity,
            evidenceOrigin: state.entryIdentity.evidenceOrigin,
            captureEvidence: state.entryIdentity.captureEvidence,
            receiptId: state.entryIdentity.receiptId, brokerSnapshot,
            principalConfirmation });
          if (restored.stage !== 'OPEN_SHORT' || restored.positionSide !== 'SHORT'
            || restored.fault) {
            return { status: 409, body: { state: restored.stage,
              faultCode: 'LANE_1_RECOVERY_FAULT_NOT_CLEARED',
              coordinatorPositionSide: restored.positionSide ?? 'UNKNOWN',
              brokerPositionSide: brokerSnapshot.positionSide,
              coordinatorUpdatedAt: restored.updatedAt ?? null,
              brokerAcquiredAt: brokerSnapshot.acquiredAt } };
          }
          return { status: 200, body: { state: restored.stage,
            disposition: 'BROKER_LEDGER_RECONSTRUCTION · INSTRUCTION_REFUSAL_FAULT_CLEARED',
            positionSide: restored.positionSide,
            receiptId: state.entryIdentity.receiptId,
            qualifiedStage0Fill: false } };
        }
        return { status: 200, body: { state: state.stage,
          disposition: 'BROKER_LEDGER_RECONSTRUCTION · IDEMPOTENT_NO_OP',
          positionSide: state.positionSide,
          receiptId: state.entryIdentity.receiptId,
          qualifiedStage0Fill: false } };
      }
    }
    const fill = await client.lane1V2RecoverableStoredFill(ownerId, {
      brokerOrderId: state.open.brokerOrderId, clientOrderId: seal.clientOrderId,
      side: 'SELL_SHORT', accountHash: brokerSnapshot.accountHash,
    });
    const evidenceOrigin = 'BROKER_LEDGER_RECONSTRUCTION';
    assertLane1FillEvidence(fill.captureEvidence, evidenceOrigin);
    const identity = lane1FillIdentity({ fill,
      tvBodyBindingSha256: seal.tvBodyBindingSha256 });
    const accepted = { brokerOrderId: state.open.brokerOrderId,
      acceptedAt: state.open.acceptedAt ?? fill.brokerOccurredAt };
    const events = appendLane1V2BrokerEvents(state, seal, accepted, fill);
    const unit = await materializeLane1V2Unit({ events, fill, stop: null,
      bundleStore: dependencies.bundleStore ?? bundleStore(env, ownerId) });
    const receipt = await (dependencies.receiptStore ?? fillReceiptStore(env, ownerId)).write({
      type: 'OPEN_FILLED', signal: 'SHORT', identity, evidenceOrigin,
      captureEvidence: fill.captureEvidence, manifestHash: unit.manifestHash,
      resolvedUnitId: unit.resolvedUnitId, qualifiedStage0Fill: false,
      recordedAt: fill.acquiredAt,
    });
    const recovered = await coordinator.recoverOpen({ signal: 'SHORT', unit, identity,
      evidenceOrigin, captureEvidence: fill.captureEvidence, receiptId: receipt.id,
      brokerSnapshot, principalConfirmation });
    await (dependencies.notifier ?? notifier(env, ownerId)).send({ type: 'OPENED', side: 'SHORT', symbol: 'SPY', quantity: 1,
      fillId: unit.openingFillId, manifestHash: unit.manifestHash,
      priceUsdPerShare: unit.openingPriceUsdPerShare, feesCents: unit.openingFeeCents,
      netCents: unit.netCashMovementCents, brokerOrderId: identity.brokerOrderId,
      tvBodyBindingSha256: identity.tvBodyBindingSha256, evidenceOrigin });
    return { status: 200, body: { state: recovered.stage,
      disposition: 'BROKER_LEDGER_RECONSTRUCTION', positionSide: recovered.positionSide,
      receiptId: receipt.id, manifestHash: unit.manifestHash,
      qualifiedStage0Fill: false } };
  } catch (error) {
    return { status: 422, body: { state: 'POSITION_DRIFT',
      faultCode: String(error?.message ?? error).split(':')[0],
      coordinatorPositionSide: state.positionSide,
      brokerPositionSide: brokerSnapshot.positionSide } };
  }
}

export async function armExistingLane1FromDashboard({ env, ownerId,
  principalConfirmation, now = () => Date.now(), dependencies = {} }) {
  const client = dependencies.client ?? new SchwabD1Client(env);
  let brokerSnapshot;
  try {
    brokerSnapshot = await client.lane1V21SendSnapshot(ownerId, {
      accountHash: env.LANE_1_SCHWAB_ACCOUNT_HASH ?? null,
    });
  } catch (error) {
    return { status: 503, body: { armed: false, state: 'UNKNOWN',
      faultCode: 'BROKER_UNREACHABLE', detail: String(error?.message ?? error) } };
  }
  const armedAtMs = now();
  try {
    const state = await (dependencies.coordinator ?? coordinatorV2Adapter(env, ownerId)).principalArmExisting({
      reason: 'PRINCIPAL_DASHBOARD_ARM_EXISTING', principalConfirmation,
      armedAt: new Date(armedAtMs).toISOString(),
      expiresAt: new Date(armedAtMs + 86_400_000).toISOString(), brokerSnapshot,
    });
    const instructionAllowed = state.positionSide === 'SHORT' ? 'BUY_TO_COVER'
      : state.positionSide === 'LONG' ? 'SELL' : null;
    if (!instructionAllowed) throw new Error('LANE_1_ARM_EXISTING_POSITION_REFUSED');
    return { status: 200, body: { armed: state.armed === true, state: state.stage,
      positionSide: state.positionSide, instructionAllowed,
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
  let ingressProof = null;
  let ingressDiagnostic = null;
  if (authenticated) {
    const replayBody = replayBodyFromAuthenticatedLane1V21Signal(body);
    const binding = replayBody ? await bindLane1V21ReplayBody(replayBody) : null;
    // Redacted representation, NOT wire bytes. Preserve allowed scalar values
    // exactly; do not persist arbitrary nested input or the authentication secret.
    const rawMessage = {};
    const removedPaths = [];
    for (const key of Object.keys(body)) {
      const path = `/${key.replace(/~/gu, '~0').replace(/\//gu, '~1')}`;
      if (!['ticker', 'side', 'qty'].includes(key)) { removedPaths.push(path); continue; }
      const value = body[key];
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) rawMessage[key] = value;
      else removedPaths.push(path);
    }
    const isTape = String(body?.kind ?? '').trim().toUpperCase() === 'TAPE';
    ingressDiagnostic = {
      // Diagnostic text is not normalized into an apparently accepted token.
      // Shape acceptance is not ARM permission, dispatch, or a broker fill.
      side: typeof body?.side === 'string' ? body.side : null,
      sideType: body?.side === null ? 'null' : Array.isArray(body?.side) ? 'array' : typeof body?.side,
      rawMessage, rawMessageFormat: 'REDACTED_SIGNAL_FIELDS_V1', removedPaths,
      acceptedInstruction: binding?.replayBody.side ?? null,
      signalContract: 'LANE_1_FOUR_ACTION_V1',
      ingressKind: isTape ? 'TAPE' : 'ORDER_SIGNAL',
      signalShapeAccepted: isTape ? null : binding !== null,
      signalFaultCode: isTape || binding !== null ? null : 'LANE_1_INVALID_SIGNAL',
      replayEligible: binding !== null,
      replayBody: binding?.replayBody ?? null,
      tvBodyBindingSha256: binding?.tvBodyBindingSha256 ?? null,
    };
    ingressProof = await recordOperationalProof(env, ownerId, 'LANE_1_TV_INGRESS', {
      receivedAt: new Date().toISOString(), ...ingressDiagnostic,
    }).catch(() => null);
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
  if (authenticated && result.status === 400 && ingressDiagnostic) {
    await recordOperationalProof(env, ownerId, 'LANE_1_TV_SIGNAL_REFUSED', {
      ...ingressDiagnostic, sourceIngressId: ingressProof?.id ?? null,
      httpStatus: result.status, faultCode: result.body.faultCode, sent: false,
    }).catch(() => null);
  }
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
    const coordinator = coordinatorV2Adapter(env, ownerId);
    await coordinator.disarm({
      reason: 'PRINCIPAL_DASHBOARD_DISARM', at: new Date(atMs).toISOString(),
    });
    const state = await coordinator.status();
    if (state?.armed !== false || state?.stage !== 'DISARMED') {
      return { status: 503, body: {
        faultCode: 'LANE_1_PRINCIPAL_DISARM_UNCONFIRMED' } };
    }
    return { status: 200, body: { armed: false,
      state: state.stage, reason: 'PRINCIPAL_DASHBOARD_DISARM',
      updatedAt: state.updatedAt ?? null } };
  } catch (error) {
    return { status: 422, body: {
      faultCode: String(error?.message ?? error).split(':')[0] } };
  }
}

export async function lane1ControlStateFromDashboard({ env, ownerId }) {
  try {
    const state = await coordinatorV2Adapter(env, ownerId).status();
    if (typeof state?.armed !== 'boolean' || typeof state?.stage !== 'string'
      || typeof state?.positionSide !== 'string') {
      return { status: 503, body: { faultCode: 'LANE_1_CONTROL_STATE_UNAVAILABLE' } };
    }
    return { status: 200, body: {
      armed: state.armed, state: state.stage, positionSide: state.positionSide ?? 'UNKNOWN',
      pendingFill: Boolean(state.pendingFill), faultCode: state.fault?.faultCode ?? null,
      updatedAt: state.updatedAt ?? null,
    } };
  } catch (error) {
    return { status: 503, body: {
      faultCode: String(error?.message ?? error).split(':')[0],
    } };
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
