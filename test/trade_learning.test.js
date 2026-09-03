import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  isWheelLearningTrade, parseTradeLearningResult, tradeFingerprint,
  tradeLearningInput, tradeLearningPrompt,
} from '../cloudflare/trade-learning.js';

const completedTrade = {
  trade_id: 'broker-open-id:broker-close-id:SPY:0',
  account_id: 'sensitive-account-id',
  symbol: 'SPY_20260918P550', underlying: 'SPY', strategy: 'SHORT_PUT',
  asset_class: 'OPTION', right: 'put', strike: 550, expiration: '2026-09-18',
  direction: 'SHORT', quantity: 1, opened_at: '2026-09-01T15:00:00.000Z',
  closed_at: '2026-09-03T15:00:00.000Z', opening_price: 2.1, closing_price: 0.9,
  fees: 1.32, realized_pnl: 118.68,
};

test('post-trade learning sends only bounded lifecycle facts and excludes broker identifiers', () => {
  const input = tradeLearningInput(completedTrade);
  assert.equal(input.symbol, 'SPY');
  assert.equal(input.realized_pnl, 118.68);
  assert.equal('trade_id' in input, false);
  assert.equal('account_id' in input, false);
  const prompt = tradeLearningPrompt(completedTrade);
  assert.doesNotMatch(prompt, /broker-open-id|broker-close-id|sensitive-account-id/u);
  assert.match(prompt, /Use only the supplied facts/u);
});

test('learning scope is wheel-only and does not absorb standalone bot trades', () => {
  assert.equal(isWheelLearningTrade(completedTrade), true);
  assert.equal(isWheelLearningTrade({ ...completedTrade, strategy: 'SHARES' }), false);
  assert.equal(isWheelLearningTrade({ ...completedTrade, strategy: 'SHARES', wheel_cycle_id: 'W-1' }), true);
});

test('trade learning fingerprint is deterministic and changes with canonical economics', () => {
  assert.equal(tradeFingerprint(completedTrade), tradeFingerprint({ ...completedTrade }));
  assert.notEqual(tradeFingerprint(completedTrade), tradeFingerprint({
    ...completedTrade, realized_pnl: 100,
  }));
});

test('trade learning accepts strict JSON and rejects unsupported confidence', () => {
  const analysis = parseTradeLearningResult({ response: JSON.stringify({
    summary: 'The lifecycle closed profitably.', what_worked: ['Credit exceeded closing cost.'],
    what_failed: ['INSUFFICIENT_EVIDENCE'], process_lesson: 'Track entry and exit evidence.',
    risk_lesson: 'Do not infer risk from realized profit alone.',
    future_rule: 'Require a sealed entry decision.', confidence: 0.75,
  }) });
  assert.equal(analysis.confidence, 0.75);
  assert.throws(() => parseTradeLearningResult({ response: JSON.stringify({
    ...analysis, confidence: 2,
  }) }), /TRADE_LEARNING_INVALID_CONFIDENCE/u);
});

test('trade learning migration seals one analysis per trade hash and prompt version', async () => {
  const sql = await readFile(new URL('../cloudflare/migrations/0018_trade_learning_analysis.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS trade_learning_analysis/u);
  assert.match(sql, /UNIQUE \(owner_id, trade_id, trade_hash, prompt_version\)/u);
  assert.doesNotMatch(sql, /ON DELETE CASCADE/u);
});
