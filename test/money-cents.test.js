import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MONEY_CENTS_ROUNDING_RULE, formatCents, moneyCents, netMoneyCents,
} from '../src/economic/money-cents.js';

test('money rounds exact subcent nets once using the named half-away rule', () => {
  assert.equal(MONEY_CENTS_ROUNDING_RULE,
    'NET_EXACT_SUBCENT_THEN_HALF_AWAY_FROM_ZERO_TO_CENT');
  assert.equal(moneyCents('0.005'), 1);
  assert.equal(moneyCents('-0.005'), -1);
  assert.equal(moneyCents('0.004999'), 0);
  assert.equal(moneyCents('-0.004999'), 0);
  assert.equal(formatCents(1), '$0.01');
  assert.equal(formatCents(-1), '-$0.01');
});

test('the live SPY probe nets unrounded executions and fees to exactly $2.50', () => {
  const fixture = JSON.parse(readFileSync(new URL(
    '../artifacts/MONEY_CENTS/live-spy-probe.fixture.json', import.meta.url,
  ), 'utf8'));
  const netCents = netMoneyCents([
    { value: fixture.buy.executionPriceUsdPerShare, multiplier: -fixture.quantityShares },
    { value: fixture.buy.feeCents / 100 },
    { value: fixture.sell.executionPriceUsdPerShare, multiplier: fixture.quantityShares },
    { value: fixture.sell.feeCents / 100 },
  ]);
  assert.equal(netCents, fixture.expected.netCents);
  assert.equal(formatCents(netCents), fixture.expected.display);
  assert.notEqual(netCents, fixture.forbidden.netCents,
    'the v142 premature per-leg rounding result must fail');
});

test('integer-cent storage refuses non-integral multipliers and unsafe totals', () => {
  assert.throws(() => netMoneyCents([{ value: 1, multiplier: 0.5 }]),
    /INTEGER_MULTIPLIER_REQUIRED/u);
  assert.throws(() => moneyCents('9007199254740991'), /SAFE_INTEGER_CENTS_REQUIRED/u);
});
