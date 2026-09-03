import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { liveDashboardScript } from '../cloudflare/worker.js';

const workerSource = readFileSync(new URL('../cloudflare/worker.js', import.meta.url), 'utf8');

test('the active cycle executes Portfolio Review directly and never invokes the legacy Governor engine', () => {
  const active = workerSource.slice(workerSource.indexOf('export async function runShadowCycle'),
    workerSource.indexOf('async function apiStatus'));
  assert.match(active, /runPortfolioReviewCycle/u);
  assert.doesNotMatch(active, /new NuvoEngine/u);
  assert.doesNotMatch(active, /mapCustodyRisk/u);
  assert.doesNotMatch(active, /governanceAttempts/u);
  assert.doesNotMatch(active, /NUVO_ALLOWED_STRUCTURES/u);
  assert.doesNotMatch(active, /maxDeployedPct/u);
  assert.match(workerSource, /admissible: true/u);
  assert.match(workerSource, /referencePolicy: row\.policy/u);
});

test('Portfolio Review has one obvious action, functional filters, and explicit read-only meaning', () => {
  const source = liveDashboardScript();
  assert.match(source, /Run fresh portfolio review/u);
  assert.match(source, /dataset\.reviewFilter/u);
  assert.match(source, /portfolioReviewFilter/u);
  assert.match(source, /Reference flags/u);
  assert.match(source, /Never suppresses a row/u);
  assert.match(source, /A weak symbol cannot erase its peers/u);
  assert.match(source, /It does not approve, size, or transmit a trade/u);
  assert.doesNotMatch(source, /Run live shadow scan/u);
});

test('U2 initial Overview cannot crash on the removed legacy opportunity table', () => {
  const source = liveDashboardScript();
  const renderRows = source.slice(source.indexOf('function renderRows'),
    source.indexOf('function fillTable'));
  const renderOverview = source.slice(source.indexOf('function renderOverview'),
    source.indexOf('function renderOpportunities'));
  assert.match(renderRows, /if \(!tbody\) return;/u,
    'an absent optional table must not block live custody rendering');
  assert.doesNotMatch(renderOverview, /top-opportunities-panel/u,
    'Overview must not target the U2-removed legacy opportunity table');
  assert.match(renderOverview, /positions\.length \+ ' open'/u,
    'the same initial render still builds the live-position panel');
  assert.match(source, /function removeLegacyOverviewOpportunities\(\)/u);
  assert.match(source, /heading\?\.textContent\.trim\(\) === 'Top opportunities'/u);
  assert.match(source, /relocateTopOpportunities\(\);\s+removeLegacyOverviewOpportunities\(\);/u,
    'the hard-coded Overview sample must be removed before live data is shown');
});

test('U2 economics name the removed legacy objects and remain non-mutating', () => {
  const source = readFileSync(new URL('../cloudflare/portfolio-review.js', import.meta.url), 'utf8');
  assert.match(source, /kitchen_sink_penalties: 'REMOVED'/u);
  assert.match(source, /collateral_hurdle_8_5_percent: 'REMOVED'/u);
  assert.match(source, /max_of_models: 'REMOVED'/u);
  assert.match(source, /weighted_mixture: 'REMOVED'/u);
  assert.match(source, /gamma_policy: 'NOT_APPLIED_GAMMA_PCT_NAV_DIMENSIONALLY_INVALID'/u);
  assert.match(source, /mutation_eligible: false/u);
  assert.match(source, /READ_ONLY_PORTFOLIO_REVIEW_NO_ORDER_ROUTE/u);
});
