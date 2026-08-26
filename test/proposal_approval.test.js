import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  freezeTradeProposal, guardianEntryGate, PRINCIPAL_ALLOWED_STRUCTURES, reviewTradeTicket,
} from '../cloudflare/proposal-approval.js';

class ProposalDb {
  constructor() { this.proposals = new Map(); this.reviews = new Map(); }
  prepare(sql) {
    const db = this;
    return {
      args: [],
      bind(...args) { this.args = args; return this; },
      async first() {
        if (/FROM trade_proposals/u.test(sql)) return db.proposals.get(this.args[1]) ?? null;
        return null;
      },
      async run() {
        if (/INSERT INTO trade_proposals/u.test(sql)) {
          const a = this.args;
          db.proposals.set(a[1], {
            owner_id: a[0], proposal_id: a[1], cycle_id: a[2], candidate_id: a[3],
            status: 'FROZEN', proposal_hash: a[4], context_hash: a[5],
            account_snapshot_hash: a[6], guardian_review_id: a[7], candidate_json: a[8],
            order_template_json: a[9], created_at: a[10], expires_at: a[11],
          });
        } else if (/INSERT INTO trade_ticket_reviews/u.test(sql)) {
          db.reviews.set(this.args[1], this.args);
        }
        return { meta: { changes: 1 } };
      },
    };
  }
}

const market = {
  ok: true, market_data_status: 'LIVE', session: 'RTH', quote_age_seconds: 2,
  freshness_limit_seconds: 60, asof: '2026-08-26T17:00:00.000Z',
};
const truth = {
  ok: true, schwab: 'CONNECTED', cash: 100_000, withdrawable_cash: 100_000,
  margin_used: 0, positions: [], recon: { baseline: 'CAPTURED', reconciliation_id: 'REC-1' },
  guardian: { state: 'OPEN', review_id: 'GR-1' },
};
const candidate = {
  candidate_id: 'CANDIDATE-1', symbol: 'SPY', structure: 'CSP', short_strike: 500,
  strikes: '500', expiry: '2026-09-25', verdict: 'ELIGIBLE', governor: 'PASS',
  probability_of_profit_model: 0.72, ev: 80, cvar: 900, nev: 40, raroc: 0.18,
};
const template = {
  candidate_id: candidate.candidate_id, underlying: 'SPY', strategy: 'CSP',
  legs: [{ action: 'SELL', right: 'put', strike: 500, expiration: '2026-09-25', quantity: 1 }],
  recommended_limit_price: 2.1, order_type: 'NET_LIMIT', time_in_force: 'DAY', maximum_quantity: 1,
};
const context = {
  cycle_id: 'CY-1', context_hash: 'ctx', account_snapshot_hash: 'snap',
  candidates: [candidate], proposal_template: template,
};

describe('deterministic Principal proposal workflow', () => {
  test('the live mandate contains no spreads', () => {
    assert.deepEqual(PRINCIPAL_ALLOWED_STRUCTURES, ['CSP', 'SHARES', 'COVERED_CALL']);
  });

  test('margin or a non-OPEN Guardian state blocks new exposure', () => {
    assert.equal(guardianEntryGate({ truth: { ...truth, margin_used: 1 }, market }).code, 'RISK/MARGIN_DEBIT');
    assert.equal(guardianEntryGate({ truth: { ...truth, guardian: { state: 'HALTED' } }, market }).code,
      'GUARDIAN/STATE_NOT_OPEN');
  });

  test('a sealed candidate freezes idempotently and an exact favorable ticket is approved', async () => {
    const DB = new ProposalDb();
    const env = { DB };
    const proposal = await freezeTradeProposal({
      env, ownerId: 'OWNER', context, candidateId: candidate.candidate_id, truth, market,
    });
    assert.equal(proposal.ok, true);
    assert.match(proposal.proposal_id, /^PROP-/u);
    const review = await reviewTradeTicket({
      env, ownerId: 'OWNER', proposalId: proposal.proposal_id,
      ticket: { quantity: 1, limit_price: 2.15, time_in_force: 'DAY' }, truth, market,
    });
    assert.equal(review.decision, 'APPROVED');
    assert.match(review.approval_id, /^APR-/u);
    assert.equal(review.broker_mutation, false);
  });

  test('a worse credit or insufficient unborrowed cash returns REVISE, never approval', async () => {
    const DB = new ProposalDb();
    const env = { DB };
    const proposal = await freezeTradeProposal({
      env, ownerId: 'OWNER', context, candidateId: candidate.candidate_id, truth, market,
    });
    const worse = await reviewTradeTicket({
      env, ownerId: 'OWNER', proposalId: proposal.proposal_id,
      ticket: { quantity: 1, limit_price: 2, time_in_force: 'DAY' }, truth, market,
    });
    assert.equal(worse.decision, 'REVISE');
    assert.ok(worse.reason_codes.includes('TICKET/CREDIT_BELOW_MODEL'));
    const poor = { ...truth, cash: 10_000, withdrawable_cash: 10_000 };
    const unsecured = await reviewTradeTicket({
      env, ownerId: 'OWNER', proposalId: proposal.proposal_id,
      ticket: { quantity: 1, limit_price: 2.15, time_in_force: 'DAY' }, truth: poor, market,
    });
    assert.equal(unsecured.decision, 'REVISE');
    assert.ok(unsecured.reason_codes.includes('TICKET/NOT_CASH_SECURED'));
  });
});
