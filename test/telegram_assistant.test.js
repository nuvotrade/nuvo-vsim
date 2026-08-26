import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  deterministicBlockedAnswer, normalizeAiText, requiresMarketData, secureSecretMatches,
  TELEGRAM_GUARDIAN_INSTRUCTIONS,
} from '../cloudflare/telegram-assistant.js';

describe('Telegram Guardian assistant', () => {
  test('webhook secret comparison accepts only the exact secret', async () => {
    assert.equal(await secureSecretMatches('correct-secret', 'correct-secret'), true);
    assert.equal(await secureSecretMatches('correct-secret', 'wrong-secret'), false);
    assert.equal(await secureSecretMatches('', 'correct-secret'), false);
  });

  test('position-management questions require current market data', () => {
    assert.equal(requiresMarketData('Should I roll my covered calls?'), true);
    assert.equal(requiresMarketData('What is my current account balance?'), false);
    assert.equal(requiresMarketData('Should I sell a cash secured put?'), true);
  });

  test('Workers AI response shapes normalize without exposing internal objects', () => {
    assert.equal(normalizeAiText({ response: ' HOLD ' }), 'HOLD');
    assert.equal(normalizeAiText({ choices: [{ message: { content: 'NO' } }] }), 'NO');
    assert.equal(normalizeAiText({}), '');
  });

  test('fail-closed fallback includes exact custody and reconciliation state', () => {
    const answer = deterministicBlockedAnswer({
      truth: {
        schwab: 'CONNECTED', nav: 160436.39, cash: 3520.14, margin_used: 0,
        recon: { baseline: 'MISMATCH' }, asof: '2026-08-26T15:00:00.000Z',
      },
      market: { asof: '2026-08-26T15:00:01.000Z' },
      guardian: { state: 'HALTED', report: { violations: [{ code: 'RECON/MISMATCH' }] } },
    });
    assert.match(answer, /BLOCKED — HALTED/u);
    assert.match(answer, /NAV: \$160,436/u);
    assert.match(answer, /Reconciliation: MISMATCH/u);
    assert.match(answer, /RECON\/MISMATCH/u);
  });

  test('mandate forbids chat order mutation and invented numbers', () => {
    assert.match(TELEGRAM_GUARDIAN_INSTRUCTIONS, /never submit, replace, cancel/u);
    assert.match(TELEGRAM_GUARDIAN_INSTRUCTIONS, /Never invent a price/u);
    assert.match(TELEGRAM_GUARDIAN_INSTRUCTIONS, /A roll is a new trade/u);
  });
});
