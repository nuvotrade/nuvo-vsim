import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  coveredCallLifecycleAnswer, deterministicBlockedAnswer, normalizeAiText, plainTelegramText,
  deterministicNewExposureAnswer, requiresLifecycleAnalytics, requiresMarketData,
  requiresNewExposureAnalysis, secureSecretMatches,
  TELEGRAM_GUARDIAN_INSTRUCTIONS,
} from '../cloudflare/telegram-assistant.js';
import { analyzeCoveredCallLifecycle } from '../src/lifecycle/covered_call_analysis.js';

function coveredCallHistory(n = 51) {
  const bars = [];
  let close = 100;
  for (let index = 0; index < n; index += 1) {
    const change = Math.sin(index * 0.71) * 0.012 + Math.cos(index * 0.19) * 0.006;
    const open = close * (1 + change * 0.2);
    close *= 1 + change;
    bars.push({
      o: open,
      h: Math.max(open, close) * 1.01,
      l: Math.min(open, close) * 0.99,
      c: close,
    });
  }
  return bars;
}

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

  test('existing short-call lifecycle questions require deterministic analytics', () => {
    assert.equal(requiresLifecycleAnalytics('Should I close my covered calls early?'), true);
    assert.equal(requiresLifecycleAnalytics('Should I buy back the short calls or let them expire?'), true);
    assert.equal(requiresLifecycleAnalytics('What is my cash balance?'), false);
  });

  test('new-position questions are intercepted for deterministic engine answers', () => {
    assert.equal(requiresNewExposureAnalysis('Should I sell a cash secured put?'), true);
    assert.equal(requiresNewExposureAnalysis('Can I buy shares of SPY?'), true);
    assert.equal(requiresNewExposureAnalysis('What is my account balance?'), false);
    const unsupported = deterministicNewExposureAnswer({
      question: 'Should I open a bull put spread?', truth: {}, market: {}, cycle: {},
    });
    assert.match(unsupported, /^UNSUPPORTED/u);
    assert.match(unsupported, /spreads are outside/u);
  });

  test('existing covered-call close questions receive math-first lifecycle analysis without entry restrictions', () => {
    const analysis = analyzeCoveredCallLifecycle({
      optionPosition: {
        symbol: 'TEST260828C00105000', underlying: 'TEST', right: 'call',
        strike: 105, expiration: '2026-08-28', qty: -2, multiplier: 100, average_price: 2.4,
      },
      sharePosition: { symbol: 'TEST', qty: 300 },
      optionQuote: {
        bid: 0.9, ask: 1, mid: 0.95, iv: 0.42, delta: 0.31, theta: -0.18,
        asof: '2026-08-26T16:00:00.000Z', source: 'SCHWAB',
      },
      underlyingQuote: { last: 100 },
      historyBars: coveredCallHistory(),
      now: Date.parse('2026-08-26T16:00:00.000Z'),
      samples: 4_000,
      seed: 'telegram-covered-call-test',
    });
    const answer = coveredCallLifecycleAnswer({ covered_calls: [analysis] });
    assert.match(answer, /^(?:HOLD|CLOSE EARLY|NEAR TIE) —/u);
    assert.match(answer, /Market-implied probability of expiring OTM: \d+\.\d%/u);
    assert.match(answer, /Model probability holding beats closing now: \d+\.\d%/u);
    assert.match(answer, /Model-minus-market assignment gap: -?\d+\.\d%/u);
    assert.match(answer, /Expected upside surrendered if held: \$[\d,]+/u);
    assert.match(answer, /Expected hold-minus-close value: -?\$[\d,]+/u);
    assert.match(answer, /Reasoning/u);
    assert.match(answer, /No order was placed/u);
    assert.doesNotMatch(answer, /pre-approved|frozen order|required before execution|MANAGE-ONLY/iu);
  });

  test('Workers AI response shapes normalize without exposing internal objects', () => {
    assert.equal(normalizeAiText({ response: ' HOLD ' }), 'HOLD');
    assert.equal(normalizeAiText({ choices: [{ message: { content: 'NO' } }] }), 'NO');
    assert.equal(normalizeAiText({}), '');
  });

  test('renders assistant replies as clean Telegram plain text', () => {
    const rendered = plainTelegramText('## **MANAGE-ONLY**\n\n- Value: `$123`\n---');
    assert.equal(rendered, 'MANAGE-ONLY\n\n- Value: $123');
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
    assert.match(TELEGRAM_GUARDIAN_INSTRUCTIONS, /Authority level 2 means PROPOSE · HUMAN EXECUTION/u);
    assert.match(TELEGRAM_GUARDIAN_INSTRUCTIONS, /Bull-put spreads, bear-put spreads/u);
    assert.match(TELEGRAM_GUARDIAN_INSTRUCTIONS, /never label it LIVE/u);
    assert.match(TELEGRAM_GUARDIAN_INSTRUCTIONS, /This is a lifecycle comparison, not a new-position request/u);
    assert.match(TELEGRAM_GUARDIAN_INSTRUCTIONS, /do not replace the quantitative answer with MANAGE-ONLY/u);
  });
});
