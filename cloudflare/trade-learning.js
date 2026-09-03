import { contentHash } from '../src/execution/order.js';

export const TRADE_LEARNING_PROMPT_VERSION = 'TRADE_LEARNING_V1';
export const TRADE_LEARNING_SCHEMA = 'nuvo.trade-learning/v1';
const WHEEL_OPTION_STRATEGIES = new Set(['SHORT_PUT', 'SHORT_CALL']);

const finite = (value) => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) ? Number(value) : null;

export function isWheelLearningTrade(trade = {}) {
  return WHEEL_OPTION_STRATEGIES.has(String(trade.strategy ?? '').toUpperCase())
    || Boolean(trade.wheel_cycle_id);
}

/** Only these canonical lifecycle fields are sent to the model. Account IDs,
 * broker transaction IDs, order IDs, and raw packets never leave the ledger. */
export function tradeLearningInput(trade = {}) {
  return {
    symbol: String(trade.underlying || trade.symbol || 'UNKNOWN'),
    strategy: String(trade.strategy || 'UNKNOWN'),
    asset_class: String(trade.asset_class || 'UNKNOWN'),
    option_right: trade.right ?? null,
    strike: finite(trade.strike),
    expiration: trade.expiration ?? null,
    direction: String(trade.direction || 'UNKNOWN'),
    quantity: finite(trade.quantity),
    opened_at: trade.opened_at ?? null,
    closed_at: trade.closed_at ?? null,
    opening_price: finite(trade.opening_price),
    closing_price: finite(trade.closing_price),
    fees: finite(trade.fees),
    realized_pnl: finite(trade.realized_pnl),
  };
}

export function tradeFingerprint(trade) {
  return contentHash(tradeLearningInput(trade));
}

export function tradeLearningPrompt(trade) {
  return `Analyze this completed trade for process learning only. Use only the supplied facts.
Do not invent market conditions, forecasts, motives, or execution details. Do not recommend a live trade.
Return strict JSON with exactly these keys:
{"summary":"string","what_worked":["string"],"what_failed":["string"],"process_lesson":"string","risk_lesson":"string","future_rule":"string","confidence":0.0}
If a conclusion cannot be supported, say "INSUFFICIENT_EVIDENCE" in that field. Confidence must be from 0 to 1.

Completed canonical lifecycle:
${JSON.stringify(tradeLearningInput(trade))}`;
}

function aiText(result) {
  if (typeof result === 'string') return result;
  if (typeof result?.response === 'string') return result.response;
  if (typeof result?.result?.response === 'string') return result.result.response;
  if (typeof result?.choices?.[0]?.message?.content === 'string') {
    return result.choices[0].message.content;
  }
  return '';
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`TRADE_LEARNING_INVALID_${field}`);
  return value.trim();
}

function stringList(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`TRADE_LEARNING_INVALID_${field}`);
  }
  return value.map((item) => item.trim()).slice(0, 8);
}

export function parseTradeLearningResult(result) {
  const raw = aiText(result).trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
  if (!raw) throw new Error('TRADE_LEARNING_EMPTY_RESPONSE');
  const parsed = JSON.parse(raw);
  const confidence = finite(parsed?.confidence);
  if (confidence === null || confidence < 0 || confidence > 1) {
    throw new Error('TRADE_LEARNING_INVALID_CONFIDENCE');
  }
  return {
    summary: requiredString(parsed.summary, 'SUMMARY'),
    what_worked: stringList(parsed.what_worked, 'WHAT_WORKED'),
    what_failed: stringList(parsed.what_failed, 'WHAT_FAILED'),
    process_lesson: requiredString(parsed.process_lesson, 'PROCESS_LESSON'),
    risk_lesson: requiredString(parsed.risk_lesson, 'RISK_LESSON'),
    future_rule: requiredString(parsed.future_rule, 'FUTURE_RULE'),
    confidence,
  };
}

export async function loadTradeLearning(env, ownerId, trades = []) {
  const wheelTrades = trades.filter(isWheelLearningTrade);
  const pendingResult = (status, detail = null) => ({
    schema: TRADE_LEARNING_SCHEMA,
    prompt_version: TRADE_LEARNING_PROMPT_VERSION,
    activation: String(env.NUVO_TRADE_LEARNING_ENABLED ?? 'OFF').toUpperCase(),
    status,
    analyzed: 0,
    eligible: wheelTrades.length,
    pending: wheelTrades.length,
    by_trade: {},
    ...(detail ? { detail } : {}),
  });
  try {
    const rows = await env.DB.prepare(`SELECT trade_id,trade_hash,model,prompt_version,
      analysis_json,analysis_hash,created_at FROM trade_learning_analysis
      WHERE owner_id=? ORDER BY created_at ASC`).bind(ownerId).all();
    const expected = new Map(wheelTrades.map((trade) => [trade.trade_id, tradeFingerprint(trade)]));
    const byTrade = {};
    for (const row of rows.results ?? []) {
      if (expected.get(row.trade_id) !== row.trade_hash) continue;
      byTrade[row.trade_id] = {
        status: 'COMPLETE', model: row.model, prompt_version: row.prompt_version,
        analysis: JSON.parse(row.analysis_json), analysis_hash: row.analysis_hash,
        created_at: row.created_at,
      };
    }
    const analyzed = Object.keys(byTrade).length;
    return {
      schema: TRADE_LEARNING_SCHEMA,
      prompt_version: TRADE_LEARNING_PROMPT_VERSION,
      activation: String(env.NUVO_TRADE_LEARNING_ENABLED ?? 'OFF').toUpperCase(),
      status: analyzed === wheelTrades.length ? 'COMPLETE' : 'PENDING',
      eligible: wheelTrades.length,
      analyzed,
      pending: Math.max(0, wheelTrades.length - analyzed),
      by_trade: byTrade,
    };
  } catch (error) {
    return pendingResult('SCHEMA_UNAVAILABLE', String(error?.message ?? error).slice(0, 160));
  }
}

export async function analyzeCompletedTrade(env, ownerId, trade, { now = new Date() } = {}) {
  if (String(env.NUVO_TRADE_LEARNING_ENABLED ?? 'OFF').toUpperCase() !== 'ON') {
    return { status: 'DISABLED', trade_id: trade.trade_id };
  }
  if (!env.AI) throw new Error('TRADE_LEARNING_AI_BINDING_UNAVAILABLE');
  if (!trade?.trade_id || !trade?.closed_at) throw new Error('TRADE_LEARNING_REQUIRES_COMPLETED_TRADE');
  if (!isWheelLearningTrade(trade)) throw new Error('TRADE_LEARNING_NON_WHEEL_TRADE_REFUSED');
  const tradeHash = tradeFingerprint(trade);
  const existing = await env.DB.prepare(`SELECT analysis_id,analysis_hash FROM trade_learning_analysis
    WHERE owner_id=? AND trade_id=? AND trade_hash=? AND prompt_version=?`).bind(
    ownerId, trade.trade_id, tradeHash, TRADE_LEARNING_PROMPT_VERSION,
  ).first();
  if (existing) return { status: 'ALREADY_COMPLETE', trade_id: trade.trade_id,
    analysis_id: existing.analysis_id, analysis_hash: existing.analysis_hash };
  const model = env.NUVO_TRADE_LEARNING_MODEL ?? env.NUVO_AI_MODEL ?? '@cf/openai/gpt-oss-120b';
  const result = await env.AI.run(model, {
    messages: [
      { role: 'system', content: 'You are the NUVO post-trade learning analyst. Produce strict JSON and use no unstated facts.' },
      { role: 'user', content: tradeLearningPrompt(trade) },
    ],
    max_tokens: 900,
    temperature: 0,
  });
  const analysis = parseTradeLearningResult(result);
  const sealed = {
    schema: TRADE_LEARNING_SCHEMA,
    prompt_version: TRADE_LEARNING_PROMPT_VERSION,
    trade_hash: tradeHash,
    model,
    analysis,
  };
  const analysisHash = contentHash(sealed);
  const analysisId = `TLA-${analysisHash.slice(0, 24)}`;
  const createdAt = now.toISOString();
  await env.DB.prepare(`INSERT OR IGNORE INTO trade_learning_analysis
    (owner_id,analysis_id,trade_id,trade_hash,model,prompt_version,analysis_json,analysis_hash,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(
    ownerId, analysisId, trade.trade_id, tradeHash, model, TRADE_LEARNING_PROMPT_VERSION,
    JSON.stringify(analysis), analysisHash, createdAt,
  ).run();
  return { status: 'COMPLETE', trade_id: trade.trade_id, analysis_id: analysisId,
    analysis_hash: analysisHash, created_at: createdAt };
}

export async function analyzeCompletedTradeBatch(env, ownerId, trades = [], { limit = 2 } = {}) {
  if (String(env.NUVO_TRADE_LEARNING_ENABLED ?? 'OFF').toUpperCase() !== 'ON') {
    return { status: 'DISABLED', analyzed: 0 };
  }
  const learning = await loadTradeLearning(env, ownerId, trades);
  const missing = trades.filter(isWheelLearningTrade)
    .filter((trade) => !learning.by_trade[trade.trade_id]).slice(0, limit);
  const results = [];
  for (const trade of missing) results.push(await analyzeCompletedTrade(env, ownerId, trade));
  return { status: 'COMPLETE', analyzed: results.length, results };
}
