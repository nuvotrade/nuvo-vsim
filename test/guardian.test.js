import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateGuardian, guardianDiscordPayload, guardianReport, GUARDIAN_STATES,
  normalizedBrokerEventKey, projectedExposure, shouldNotifyGuardian, uncoveredShortCalls, wholeDollar,
} from '../cloudflare/guardian.js';
import { DEFAULT_LIMITS } from '../src/constitution/limits.js';

const NOW = Date.UTC(2026, 7, 26, 15, 0);
const base = { asOf: NOW, nav: 100_000, cash: 20_000, marginDebit: 0, openOrders: [], positions: [] };

describe('NUVO Guardian enforcement', () => {
  test('uses the same 20% single-name cap as the frozen Constitution', () => {
    assert.equal(DEFAULT_LIMITS.maxSingleUnderlyingPct, 0.20);
    const below = evaluateGuardian({ snapshot: { ...base, positions: [
      { symbol: 'ABC', underlying: 'ABC', type: 'EQUITY', quantity: 100, marketValue: 20_000 },
    ] }, reconStatus: 'CAPTURED', campaignCount: 1, now: NOW });
    assert.ok(!below.violations.some((row) => row.code === 'RISK/SINGLE_NAME_ABOVE_20'));
    const above = evaluateGuardian({ snapshot: { ...base, positions: [
      { symbol: 'ABC', underlying: 'ABC', type: 'EQUITY', quantity: 101, marketValue: 20_001 },
    ] }, reconStatus: 'CAPTURED', campaignCount: 1, now: NOW });
    assert.ok(above.violations.some((row) => row.code === 'RISK/SINGLE_NAME_ABOVE_20'));
  });

  test('halts on any positive margin debit', () => {
    const result = evaluateGuardian({ snapshot: { ...base, marginDebit: 1 }, reconStatus: 'CAPTURED', now: NOW });
    assert.equal(result.state, GUARDIAN_STATES.HALTED);
    assert.ok(result.violations.some((row) => row.code === 'RISK/MARGIN_DEBIT'));
  });

  test('counts short-put assignment notional in projected single-name exposure', () => {
    const positions = [{ symbol: 'SPY', underlying: 'SPY', type: 'EQUITY', quantity: 10, marketValue: 5000 },
      { symbol: 'SPYPUT', underlying: 'SPY', type: 'OPTION', right: 'put', quantity: -1, multiplier: 100, strike: 500, marketValue: -1000 }];
    assert.equal(projectedExposure({ positions })[0].projected, 55_000);
    const result = evaluateGuardian({ snapshot: { ...base, positions }, reconStatus: 'CAPTURED', campaignCount: 1, now: NOW });
    assert.equal(result.state, GUARDIAN_STATES.MANAGE_ONLY);
  });

  test('covered calls do not reduce exposure and uncovered calls halt', () => {
    const covered = { ...base, positions: [{ symbol: 'ABC', underlying: 'ABC', type: 'EQUITY', quantity: 100, marketValue: 10_000 },
      { symbol: 'ABCC', underlying: 'ABC', type: 'OPTION', right: 'call', quantity: -1, multiplier: 100, marketValue: -100 }] };
    assert.deepEqual(uncoveredShortCalls(covered), []);
    assert.equal(projectedExposure(covered)[0].projected, 10_000);
    const naked = { ...covered, positions: covered.positions.slice(1) };
    assert.equal(evaluateGuardian({ snapshot: naked, reconStatus: 'CAPTURED', campaignCount: 1, now: NOW }).state, GUARDIAN_STATES.HALTED);
  });

  test('blocks incomplete or stale live broker truth', () => {
    assert.equal(evaluateGuardian({ snapshot: null }).state, GUARDIAN_STATES.BLOCKED);
    assert.equal(evaluateGuardian({ snapshot: { ...base, asOf: NOW - 301_000 }, reconStatus: 'CAPTURED', marketSession: 'RTH', now: NOW }).state, GUARDIAN_STATES.BLOCKED);
  });

  test('halts when an open broker order has no frozen campaign authority', () => {
    const result = evaluateGuardian({ snapshot: { ...base, openOrders: [{ brokerOrderId: '1' }] },
      reconStatus: 'CAPTURED', campaignCount: 0, now: NOW });
    assert.equal(result.state, GUARDIAN_STATES.HALTED);
    assert.ok(result.violations.some((row) => row.code === 'AUTH/BROKER_BYPASS'));
  });

  test('Schwab transaction identity survives normalization corrections without duplicating the ledger', () => {
    const original = { type: 'TRADE', transactionId: 'TX-1', symbol: 'CURRENCY_USD', amount: -12_345 };
    const corrected = { ...original, symbol: 'SPCX', quantity: 100, price: 123.45 };
    assert.equal(normalizedBrokerEventKey(original), normalizedBrokerEventKey(corrected));
  });

  test('separate legs inside one Schwab transaction remain independently auditable', () => {
    const common = { type: 'TRADE', transactionId: 'TX-1' };
    assert.notEqual(
      normalizedBrokerEventKey({ ...common, transactionLegId: null }),
      normalizedBrokerEventKey({ ...common, transactionLegId: 'ITEM:1' }),
    );
  });

  test('distinct execution legs remain distinct broker events', () => {
    const common = { type: 'EXECUTION', brokerOrderId: 'ORDER-1', activityId: 'ACT-1', occurredAt: NOW };
    assert.notEqual(
      normalizedBrokerEventKey({ ...common, symbol: 'SPY', quantity: 1, price: 500 }),
      normalizedBrokerEventKey({ ...common, symbol: 'SPY', quantity: 1, price: 501 }),
    );
  });

  test('the same Schwab activity emitted through parent and child orders deduplicates', () => {
    const common = {
      type: 'EXECUTION', activityId: 'activity-1', symbol: 'SPCX260828C00141000',
      side: 'SELL_TO_OPEN', quantity: 3, price: 2.01, occurredAt: '2026-08-25T13:47:00.000Z',
    };
    assert.equal(
      normalizedBrokerEventKey({ ...common, brokerOrderId: 'parent-order' }),
      normalizedBrokerEventKey({ ...common, brokerOrderId: 'child-order' }),
    );
  });

  test('Discord currency is whole-dollar, signed, and always carries a dollar symbol', () => {
    assert.equal(wholeDollar(161_825.49), '$161,825');
    assert.equal(wholeDollar(161_825.5), '$161,826');
    assert.equal(wholeDollar(-1_002.5), '-$1,003');
    assert.equal(wholeDollar(null), 'UNKNOWN');
  });

  test('Discord control report describes every position and its current P&L', () => {
    const snapshot = { ...base, nav: 161_825.14, cash: 3_520.14, positions: [
      { symbol: 'SPCX', underlying: 'SPCX', type: 'EQUITY', quantity: 500,
        multiplier: 1, averagePrice: 120.70, marketValue: 69_415 },
      { symbol: 'SPCX260828C00141000', underlying: 'SPCX', type: 'OPTION', right: 'call',
        strike: 141, expiration: '2026-08-28', quantity: -5, multiplier: 100,
        averagePrice: 2.01, marketValue: -1_002.5 },
    ] };
    const assessment = evaluateGuardian({ snapshot, reconStatus: 'MISMATCH', campaignCount: 0, now: NOW });
    const report = guardianReport({ snapshot, assessment, reconStatus: 'MISMATCH' });
    report.marketData = 'LIVE';
    report.reconciliation = { status: 'MISMATCH' };
    const payload = guardianDiscordPayload({ id: 'review-1', report });
    assert.match(payload.content, /HALTED/u);
    assert.equal(payload.embeds[0].fields.filter((field) => /SPCX/u.test(field.name)).length, 2);
    assert.match(payload.embeds[0].fields.find((field) => field.name.includes('500 SPCX shares')).value,
      /Current P&L: \*\*\$9,065\*\*/u);
    assert.match(payload.embeds[0].fields.find((field) => field.name.includes('Short 5 SPCX')).value,
      /Current P&L: \*\*\$3\*\*/u);
    assert.match(payload.embeds[0].fields.find((field) => field.name.startsWith('Violations')).value,
      /Broker custody differs/u);
  });

  test('persistent unchanged violations do not spam Discord but manual reports always send', () => {
    const violations = [{ code: 'RECON/MISMATCH', severity: 'CRITICAL' }];
    const assessment = { state: GUARDIAN_STATES.HALTED, violations };
    const previous = { state: GUARDIAN_STATES.HALTED, report: { violations } };
    assert.equal(shouldNotifyGuardian({ previous, assessment, reviewType: 'EVENT' }), false);
    assert.equal(shouldNotifyGuardian({ previous, assessment, reviewType: 'MANUAL' }), true);
    assert.equal(shouldNotifyGuardian({ previous, assessment, reviewType: 'EVENT', newEventCount: 1 }), true);
    assert.equal(shouldNotifyGuardian({ previous, assessment: { ...assessment,
      violations: [...violations, { code: 'RISK/MARGIN_DEBIT', severity: 'CRITICAL' }] } }), true);
  });
});
