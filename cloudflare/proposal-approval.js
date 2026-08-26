import { contentHash } from '../src/execution/order.js';

export const PRINCIPAL_ALLOWED_STRUCTURES = Object.freeze(['CSP', 'SHARES', 'COVERED_CALL']);
const ALLOWED = new Set(PRINCIPAL_ALLOWED_STRUCTURES);
const PROPOSAL_TTL_MS = 60_000;
const APPROVAL_TTL_MS = 60_000;

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const iso = (value = Date.now()) => new Date(value).toISOString();

function failure(code, message, detail = null) {
  return { ok: false, code, message, detail };
}

export function guardianEntryGate({ truth, market }) {
  if (!truth?.ok || truth.schwab !== 'CONNECTED') {
    return failure('TRUTH/SCHWAB_UNAVAILABLE', 'Current Schwab account truth is required.');
  }
  if (truth.recon?.baseline !== 'CAPTURED') {
    return failure('TRUTH/RECONCILIATION_REQUIRED', 'Broker custody must match the captured baseline.');
  }
  if ((finite(truth.margin_used) ?? 0) > 0 || (finite(truth.cash) ?? 0) < 0) {
    return failure('RISK/MARGIN_DEBIT', 'New exposure is prohibited while the account has a margin debit.');
  }
  if (truth.guardian?.state !== 'OPEN') {
    return failure('GUARDIAN/STATE_NOT_OPEN', `Guardian state is ${truth.guardian?.state ?? 'BLOCKED-INCOMPLETE'}; OPEN is required.`);
  }
  if (!market?.ok || market.market_data_status !== 'LIVE' || market.session !== 'RTH') {
    return failure('TRUTH/MARKET_NOT_LIVE_RTH', 'Live regular-session market data is required.');
  }
  if (!Number.isFinite(finite(market.quote_age_seconds))
    || finite(market.quote_age_seconds) > finite(market.freshness_limit_seconds)) {
    return failure('TRUTH/FACT_STALE', 'The verified underlying quote is outside its freshness limit.');
  }
  return { ok: true };
}

function candidateFor(context, candidateId) {
  return (context?.candidates ?? []).find((row) => row.candidate_id === candidateId) ?? null;
}

function collateralCheck({ candidate, template, truth, quantity, limitPrice }) {
  if (candidate.structure === 'CSP') {
    const strike = finite(candidate.short_strike);
    const required = strike === null ? null : strike * 100 * quantity;
    if (required === null) return failure('TICKET/STRIKE_MISSING', 'The frozen CSP strike is missing.');
    if ((finite(truth.withdrawable_cash) ?? Math.max(0, finite(truth.cash) ?? 0)) < required) {
      return failure('TICKET/NOT_CASH_SECURED', `The CSP requires $${Math.round(required)} of unborrowed cash.`);
    }
  }
  if (candidate.structure === 'SHARES') {
    const required = limitPrice * quantity;
    if ((finite(truth.withdrawable_cash) ?? Math.max(0, finite(truth.cash) ?? 0)) < required) {
      return failure('TICKET/INSUFFICIENT_UNBORROWED_CASH', `The share order requires up to $${Math.round(required)}.`);
    }
  }
  if (candidate.structure === 'COVERED_CALL') {
    const underlying = template.underlying;
    const shares = (truth.positions ?? []).filter((row) => row.asset_class === 'EQUITY'
      && row.symbol === underlying).reduce((sum, row) => sum + Math.max(0, finite(row.qty) ?? 0), 0);
    const alreadyCovered = (truth.positions ?? []).filter((row) => row.asset_class === 'OPTION'
      && row.underlying === underlying && row.right === 'call' && (finite(row.qty) ?? 0) < 0)
      .reduce((sum, row) => sum + Math.abs(finite(row.qty) ?? 0) * (finite(row.multiplier) ?? 100), 0);
    if (shares - alreadyCovered < quantity * 100) {
      return failure('TICKET/UNCOVERED_CALL', 'The proposed calls are not fully covered by currently unencumbered shares.');
    }
  }
  return { ok: true };
}

export async function freezeTradeProposal({ env, ownerId, context, candidateId, truth, market }) {
  const gate = guardianEntryGate({ truth, market });
  if (!gate.ok) return gate;
  const candidate = candidateFor(context, candidateId);
  if (!candidate) return failure('PROPOSAL/CANDIDATE_NOT_FOUND', 'Candidate is not in the sealed cycle.');
  if (!ALLOWED.has(candidate.structure)) {
    return failure('PROPOSAL/STRUCTURE_NOT_PERMITTED', `${candidate.structure} is outside the Principal mandate.`);
  }
  if (candidate.verdict !== 'ELIGIBLE' || !['PASS', 'REDUCED'].includes(candidate.governor)) {
    return failure('PROPOSAL/CANDIDATE_NOT_ELIGIBLE', 'Only a sealed Governor-approved candidate can become a proposal.');
  }
  const template = context.proposal_template;
  if (!template || template.candidate_id !== candidateId) {
    return failure('PROPOSAL/ORDER_TEMPLATE_MISSING', 'The sealed candidate has no matching deterministic order template.');
  }
  const createdAt = Date.now();
  const proposalContent = {
    owner_id: ownerId,
    cycle_id: context.cycle_id,
    candidate_id: candidateId,
    context_hash: context.context_hash,
    account_snapshot_hash: context.account_snapshot_hash,
    guardian_review_id: truth.guardian.review_id,
    candidate,
    order_template: template,
  };
  const proposalHash = contentHash(proposalContent);
  const proposalId = `PROP-${proposalHash.slice(0, 24)}`;
  const expiresAt = iso(createdAt + PROPOSAL_TTL_MS);
  await env.DB.prepare(`INSERT INTO trade_proposals
    (owner_id,proposal_id,cycle_id,candidate_id,status,proposal_hash,context_hash,
     account_snapshot_hash,guardian_review_id,candidate_json,order_template_json,created_at,expires_at)
    VALUES (?,?,?,?, 'FROZEN', ?,?,?,?,?,?,?,?,?)
    ON CONFLICT(owner_id,proposal_id) DO NOTHING`).bind(
    ownerId, proposalId, context.cycle_id, candidateId, proposalHash, context.context_hash,
    context.account_snapshot_hash, truth.guardian.review_id, JSON.stringify(candidate),
    JSON.stringify(template), iso(createdAt), expiresAt,
  ).run();
  return {
    ok: true,
    proposal_id: proposalId,
    status: 'FROZEN',
    candidate,
    order_template: template,
    expires_at: expiresAt,
    next_action: 'SUBMIT_EXACT_ORDER_TICKET_FOR_GUARDIAN_REVIEW',
    broker_mutation: false,
  };
}

export async function reviewTradeTicket({ env, ownerId, proposalId, ticket, truth, market }) {
  const gate = guardianEntryGate({ truth, market });
  if (!gate.ok) return gate;
  const row = await env.DB.prepare(`SELECT * FROM trade_proposals
    WHERE owner_id=? AND proposal_id=?`).bind(ownerId, proposalId).first();
  if (!row) return failure('TICKET/PROPOSAL_NOT_FOUND', 'Frozen proposal was not found.');
  if (row.status !== 'FROZEN' || Date.parse(row.expires_at) < Date.now()) {
    return failure('TICKET/PROPOSAL_EXPIRED', 'The proposal expired; rerun the deterministic cycle.');
  }
  const candidate = JSON.parse(row.candidate_json);
  const template = JSON.parse(row.order_template_json);
  if (!ALLOWED.has(candidate.structure)) {
    return failure('TICKET/STRUCTURE_NOT_PERMITTED', `${candidate.structure} is outside the Principal mandate.`);
  }
  const quantity = finite(ticket?.quantity);
  const limitPrice = finite(ticket?.limit_price);
  const maximum = finite(template.maximum_quantity);
  const reasons = [];
  if (!Number.isInteger(quantity) || quantity < 1 || !Number.isInteger(maximum) || quantity > maximum) {
    reasons.push('TICKET/QUANTITY_EXCEEDS_FROZEN_SIZE');
  }
  if (limitPrice === null || limitPrice <= 0) reasons.push('TICKET/LIMIT_PRICE_REQUIRED');
  if ((ticket?.time_in_force ?? 'DAY') !== 'DAY') reasons.push('TICKET/DAY_ONLY');
  const recommended = finite(template.recommended_limit_price);
  if (recommended === null) reasons.push('TICKET/RECOMMENDED_LIMIT_MISSING');
  const creditOrder = candidate.structure === 'CSP' || candidate.structure === 'COVERED_CALL';
  if (limitPrice !== null && recommended !== null
    && (creditOrder ? limitPrice < recommended : limitPrice > recommended)) {
    reasons.push(creditOrder ? 'TICKET/CREDIT_BELOW_MODEL' : 'TICKET/DEBIT_ABOVE_MODEL');
  }
  if (!reasons.length) {
    const collateral = collateralCheck({ candidate, template, truth, quantity, limitPrice });
    if (!collateral.ok) reasons.push(collateral.code);
  }
  const decision = reasons.length ? 'REVISE' : 'APPROVED';
  const submitted = {
    proposal_id: proposalId,
    quantity,
    limit_price: limitPrice,
    time_in_force: ticket?.time_in_force ?? 'DAY',
  };
  const reviewedAt = Date.now();
  const reviewContent = {
    proposal_id: proposalId,
    submitted,
    account_snapshot_hash: truth.recon?.reconciliation_id,
    market_asof: market.asof,
    decision,
    reasons,
  };
  const reviewHash = contentHash(reviewContent);
  const reviewId = `TKT-${reviewHash.slice(0, 24)}`;
  const approvalId = decision === 'APPROVED' ? `APR-${reviewHash.slice(0, 24)}` : null;
  const expiresAt = iso(reviewedAt + APPROVAL_TTL_MS);
  await env.DB.prepare(`INSERT INTO trade_ticket_reviews
    (owner_id,review_id,proposal_id,decision,approval_id,ticket_hash,ticket_json,
     exact_order_json,reason_codes_json,account_snapshot_hash,market_asof,created_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,review_id) DO NOTHING`).bind(
    ownerId, reviewId, proposalId, decision, approvalId, reviewHash, JSON.stringify(submitted),
    JSON.stringify({ ...template, quantity, limit_price: limitPrice }), JSON.stringify(reasons),
    truth.recon?.reconciliation_id ?? null, market.asof, iso(reviewedAt), expiresAt,
  ).run();
  return {
    ok: decision === 'APPROVED',
    review_id: reviewId,
    decision,
    approval_id: approvalId,
    reason_codes: reasons,
    approved_ticket: decision === 'APPROVED' ? { ...template, quantity, limit_price: limitPrice } : null,
    recommended_ticket: { ...template, quantity: Math.min(quantity ?? maximum, maximum), limit_price: recommended },
    expires_at: expiresAt,
    broker_mutation: false,
  };
}
