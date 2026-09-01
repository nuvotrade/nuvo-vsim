import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MassiveProvider } from '../src/truth/providers/massive.js';
import { SchwabMarketProvider, sessionStatus } from '../src/truth/providers/schwab.js';
import { SchwabReadOnlyBroker } from '../src/execution/broker/schwab_readonly.js';
import { mapCustodyRisk } from '../cloudflare/custody-risk.js';
import { ReplayProvider } from '../src/evidence/replay.js';
import {
  cycleIdFor, dashboardHtml, designAsset, fullDashboard, liveDashboardScript,
  rewriteDesignHtml, runShadowCycle, serveDashboard,
} from '../cloudflare/worker.js';
import {
  BUNDLED_DESIGN_APP, BUNDLED_DESIGN_HTML, BUNDLED_DESIGN_SHA256, BUNDLED_DESIGN_STYLES,
} from '../cloudflare/design-assets.js';
import { availableContractDtes } from '../src/pipeline/cycle.js';
import {
  aggregatePositions, historicalLedgerWindow, normalizePosition, normalizeTransactions,
  reconcilePositionDayProfitLoss, SchwabD1Client,
} from '../cloudflare/schwab-client.js';
import { D1R2EvidencePersistence } from '../cloudflare/evidence-persistence.js';

const NOW = Date.UTC(2026, 7, 23, 18, 0, 0);

describe('protected live dashboard', () => {
  test('bundles the byte-verified reviewed design and preserves the fail-safe console', async () => {
    const sources = {
      BUNDLED_DESIGN_HTML: readFileSync(new URL('../cloudflare/design/index.html', import.meta.url)),
      BUNDLED_DESIGN_STYLES: readFileSync(new URL('../cloudflare/design/styles.css', import.meta.url)),
      BUNDLED_DESIGN_APP: readFileSync(new URL('../cloudflare/design/app.js', import.meta.url)),
    };
    assert.deepEqual(BUNDLED_DESIGN_SHA256, {
      BUNDLED_DESIGN_HTML: '1630efa01047645b723ecc69452b919953bfc6230b2c44c83cc132b563d34fb6',
      BUNDLED_DESIGN_STYLES: '0f42575c47f7883a223a578220e37623b0806db2a6a49d94c22b48e8c164bb48',
      BUNDLED_DESIGN_APP: 'a851dac026ae4c444ff7f37225f926ff7c6fb7056a5354cee879480bc2e72970',
    });
    for (const [name, bytes] of Object.entries(sources)) {
      assert.equal(createHash('sha256').update(bytes).digest('hex'), BUNDLED_DESIGN_SHA256[name]);
    }
    assert.equal(BUNDLED_DESIGN_HTML, sources.BUNDLED_DESIGN_HTML.toString('utf8'));
    assert.equal(BUNDLED_DESIGN_STYLES, sources.BUNDLED_DESIGN_STYLES.toString('utf8'));
    assert.equal(BUNDLED_DESIGN_APP, sources.BUNDLED_DESIGN_APP.toString('utf8'));

    const dashboard = await fullDashboard();
    const html = await dashboard.text();
    assert.match(html, /NUVO VSIM v5 — Live Shadow/u);
    for (const view of ['overview', 'underwrite', 'performance', 'decisions', 'bot', 'system']) {
      assert.match(html, new RegExp(`data-view="${view}"`, 'u'));
    }
    assert.equal(await (await designAsset('styles.css')).text(), BUNDLED_DESIGN_STYLES);
    assert.match(await (await designAsset('app.js')).text(), /live shadow/u);
    assert.throws(() => fullDashboard(''), /DESIGN_UNAVAILABLE/u);

    const errors = [];
    const fallback = await serveDashboard(() => { throw new Error('TEST_RENDER_FAILURE'); },
      (...args) => errors.push(args));
    const fallbackHtml = await fallback.text();
    assert.equal(errors.length, 1);
    assert.match(fallbackHtml, /NUVO VSIM v5 — Shadow/u);
    assert.match(fallbackHtml, /Operator controls/u);
    assert.match(dashboardHtml(), /This is the protected v5 proposal system/u);
  });

  test('rewrites the polished design to same-origin protected assets and live bindings', () => {
    const html = rewriteDesignHtml('<title>NUVO VSIM v5 — Shadow Preview</title><link rel="stylesheet" href="styles.css"></head><body><button class="nav-button" data-view="opportunities">Opportunities</button><button class="nav-button" data-view="evidence">Evidence</button><section class="view" id="evidence"></section><script src="app.js"></script></body>');
    assert.match(html, /NUVO VSIM v5 — Live Shadow/u);
    assert.match(html, /href="\/design\/styles\.css"/u);
    assert.match(html, /src="\/design\/app\.js"/u);
    assert.match(html, /src="\/design\/live\.js"/u);
    assert.match(html, /visibility:hidden/u);
    const rewriteSource = rewriteDesignHtml.toString();
    assert.match(rewriteSource, /Realized premium/u);
    assert.match(rewriteSource, /Realized premium · MTD/u);
    assert.match(rewriteSource, /mtd-realized-premium/u);
    assert.doesNotMatch(rewriteSource, /<span>Buying power<\/span>/u);
    assert.doesNotMatch(rewriteSource, /<h3>Current portfolio<\/h3>/u);
    assert.match(rewriteSource, /<h3>Expiration ladder<\/h3>/u);
    assert.match(rewriteSource, /data-vsim="expiration-ladder"/u);
    assert.match(rewriteSource, /data-vsim="custody-scope"/u);
    assert.match(rewriteSource, /Deployment and cash reserve/u);
    assert.match(rewriteSource, /data-vsim="deployed-gauge"/u);
    assert.match(rewriteSource, /data-vsim="reserve-gauge"/u);
    assert.match(rewriteSource, /data-vsim="concentration-cap"/u);
    assert.match(rewriteSource, /Distance to strike/u);
    assert.match(rewriteSource, /performance-unrealized-note/u);
    assert.doesNotMatch(rewriteSource, /<span>Withdrawable cash<\/span>/u);
    assert.ok(rewriteSource.indexOf('<h3>Expiration ladder<\/h3>')
      < rewriteSource.indexOf('<h3>Portfolio economics<\/h3>'));
    assert.match(rewriteSource, /Covered calls/u);
    assert.match(rewriteSource, /data-view="underwrite">Underwrite/u);
    assert.match(rewriteSource, /data-view="performance">Performance/u);
    assert.match(rewriteSource, /data-view="decisions">Decisions/u);
    assert.doesNotMatch(rewriteSource, /data-view="records">Records/u);
    assert.doesNotMatch(rewriteSource, /data-view="calculators">Calculators/u);
    assert.match(rewriteSource, /Options calculators/u);
    assert.match(rewriteSource, /data-calculator="covered-call"/u);
    assert.match(rewriteSource, /data-calculator="cash-secured-put"/u);
    assert.match(rewriteSource, /Wheel-ready paths/u);
    assert.match(rewriteSource, /NEV \/ day/u);
    assert.doesNotMatch(rewriteSource, /data-vsim="csp-raroc"/u);
    assert.match(rewriteSource, /\.calculator-pane\[hidden\]\{display:none\}/u);
    assert.match(rewriteSource, /Ready for a fresh calculation/u);
    assert.match(html, /data-view="underwrite">Underwrite/u);
    assert.doesNotMatch(html, /data-view="opportunities">Opportunities/u);
    assert.doesNotMatch(html, /data-view="evidence">Evidence/u);
    assert.match(rewriteSource, /data-underwrite-mode="scan"/u);
    assert.match(rewriteSource, /data-underwrite-mode="manual"/u);
    assert.match(rewriteSource, /Closed trade drill-down/u);
    assert.match(rewriteSource, /data-jump-system-history/u);
    assert.match(rewriteSource, /7 \/ 14 \/ 21 DTE comparison/u);
    assert.match(rewriteSource, /Strike must exceed your average share price/u);
    assert.match(rewriteSource, />Directive<\/th>/u);
    assert.match(rewriteSource, /<th>NEV \/ day<\/th><th>vs hold<\/th>/u);
    assert.match(rewriteSource, /calculator-results\[hidden\]/u);
    assert.doesNotMatch(rewriteSource, /<th>Annualized ROC<\/th>/u);
    assert.match(rewriteSource, /today-pnl-card/u);
    assert.match(rewriteSource, /today-pnl-card \.metric-value\{font-variant-numeric:tabular-nums/u);
    assert.doesNotMatch(rewriteSource, /today-pnl-card \.metric-value\{[^}]*font-(?:size|weight)/u);
    assert.doesNotMatch(rewriteSource, /today-pnl-card \.metric-value\{[^}]*line-height/u);
  });

  test('ships syntactically valid live bindings for every protected shadow surface', () => {
    const source = liveDashboardScript();
    assert.doesNotThrow(() => new Function(source));
    for (const path of ['/api/status', '/api/evidence', '/api/operator/replay',
      '/api/operator/controls', '/api/operator/broker/backfill', '/api/cycle']) {
      assert.match(source, new RegExp(path.replaceAll('/', '\\/'), 'u'));
    }
    assert.match(source, /\/api\/operator\/custody\/refresh/u);
    assert.doesNotMatch(source, /\/api\/operator\/(market\/check|baseline)/u);
    assert.doesNotMatch(source, /submitOrder|replaceOrder|cancelOrder/u);
    assert.match(source, /Signed cash balance/u);
    assert.match(source, /account\.cash/u);
    assert.doesNotMatch(source, /text\(q\('\.metric-value', cards\[1\]\), money\(account\.buyingPower\)\)/u);
    assert.match(source, /mtd-realized-premium/u);
    assert.match(source, /mtd_realized_premium/u);
    assert.match(source, /minimumFractionDigits: 2, maximumFractionDigits: 2/u);
    assert.match(source, /SCHWAB_LATEST_AVAILABLE_COMPLETE/u);
    assert.match(source, /income-theta-note/u);
    assert.match(source, /net-theta-note/u);
    assert.match(source, /Schwab brokerage account/u);
    assert.match(source, /equities and options/u);
    assert.match(source, /risk_instrumentation/u);
    assert.match(source, /expiration_ladder/u);
    assert.match(source, /quoteValue\(item, item\.mark, true\)/u);
    assert.match(source, /distance_to_strike_sigma/u);
    assert.match(source, /LAST_MARKET_QUOTE/u);
    assert.match(source, /stale-badge/u);
    assert.match(source, /performance-unrealized-note/u);
    assert.match(source, /short-option capital \/ NAV/u);
    assert.match(source, /five-metrics/u);
    assert.match(source, /share_open_pnl/u);
    assert.match(source, /market && market\.ok/u);
    assert.match(source, /\/api\/covered-call\/calculate\?symbol=/u);
    assert.match(source, /SELL CC/u);
    assert.match(source, /covered_call_actionable/u);
    assert.match(source, /function renderCoveredCall\(result\)/u);
    assert.match(source, /function renderCashSecuredPuts\(cycle\)/u);
    assert.match(source, /function runCashSecuredPut\(button\)/u);
    assert.doesNotMatch(source, /Run a fresh protected cash-secured-put calculation/u,
      'the primary read-only calculator action must not require a habitual confirmation');
    assert.match(source, /function renderCalculatorSymbols\(inventory\)/u);
    assert.match(source, /function resetCoveredCallView\(\)/u);
    assert.match(source, /function applyCoveredCallAvailability\(rows\)/u);
    assert.match(source, /function resetCspView\(\)/u);
    assert.match(source, /coveredCallRequestId === requestId/u);
    assert.match(source, /cspRequestId !== requestId/u);
    assert.doesNotMatch(source, /renderCashSecuredPuts\(currentStatus\.latestCycle\)/u);
    assert.match(source, /activateView\('underwrite'\)/u);
    assert.match(source, /setUnderwriteMode\('manual'\)/u);
    assert.match(source, /data-csp-calculate/u);
    assert.match(source, /cspOpportunities/u);
    assert.match(runShadowCycle.toString(), /source === 'CSP_CALCULATOR'/u);
    const workerSource = readFileSync(new URL('../cloudflare/worker.js', import.meta.url), 'utf8');
    assert.match(workerSource, /cspShadowLog/u);
    assert.match(workerSource, /underwritingEligibleBeforeCapital/u);
    assert.match(workerSource, /capitalConstraintAppliedAfterUnderwriting/u);
    assert.match(source, /governorApproved/u);
    assert.match(source, /NO CAPITAL/u);
    assert.match(source, /NO EDGE/u);
    assert.match(source, /NO DATA/u);
    assert.ok(source.includes('/api/cash-secured-put/calculate'));
    assert.ok(!source.includes('const best = rows.find(item => item.admissible)'));
    assert.match(source, /function activateView\(id\)/u);
    assert.match(source, /incremental_nev_vs_holding/u);
    assert.doesNotMatch(source, /setValue\('withdrawable-cash'/u);
    assert.match(source, /positions\.every\(position => present\(position\.marketValue\)\)/u);
    assert.doesNotMatch(source, /Math\.abs\(Number\(position\.marketValue\)/u);
    assert.match(source, /Today's P&L/u);
    assert.match(source, /SCHWAB_SUM_RECONCILED_POSITION_DAY_PROFIT_LOSS/u);
    assert.match(source, /account\.dayProfitLoss/u);
    assert.match(source, /Schwab position day P&L/u);
    assert.match(source, /no estimated balance change shown/u);
    assert.doesNotMatch(source, /text\(q\('\.metric-label', cards\[3\]\), 'Reconciliation baseline'\)/u);
    assert.match(source, /Authority changes require the Principal/u);
    assert.match(source, /Explicit Constitution amendment/u);
    assert.doesNotMatch(source, /Awaiting 50 mature observations/u);
    assert.match(source, /Market & data readiness/u);
    assert.match(source, /May evaluate new trades\?/u);
    assert.match(source, /What is blocking it\?/u);
    assert.match(source, /Affected data \/ source/u);
    assert.match(source, /What happens next\?/u);
    assert.match(source, /User action required/u);
    assert.match(source, /Technical diagnostics/u);
    assert.match(source, /function relocateTopOpportunities\(\)/u);
    assert.match(source, /opportunitiesView\.insertBefore\(panel, detailed\)/u);
    assert.match(source, /#underwrite \[data-underwrite-pane="scan"\] \.top-opportunities-panel tbody/u);
    assert.match(source, /#underwrite \[data-underwrite-pane="scan"\] \.top-opportunities-panel \.panel-note/u);
    assert.doesNotMatch(source, /#overview \.table-panel tbody/u);
    assert.match(source, /function relocateOverviewEvidencePanels\(\)/u);
    assert.match(source, /evidenceView\.insertBefore\(panels, layout\)/u);
    assert.match(source, /#decisions \.environment-panel/u);
    assert.match(source, /#decisions \.decision-panel/u);
    assert.doesNotMatch(source, /#overview \.environment-panel/u);
    assert.doesNotMatch(source, /#overview \.decision-panel/u);
    assert.doesNotMatch(source, /Awaiting an admissible live cycle/u);
    assert.match(source, /function renderPerformanceLedger\(\)/u);
    assert.match(source, /data-performance-filter/u);
    assert.match(source, /onpointerdown/u);
    assert.match(source, /system-history/u);
  });
});

function marketFetcher({ staleChain = false } = {}) {
  return async (request) => {
    const url = new URL(request.url);
    let body;
    if (url.pathname === '/v1/bars') {
      const bars = Array.from({ length: 130 }, (_, index) => ({
        t: NOW - (129 - index) * 86_400_000,
        o: 500 + index * 0.2, h: 502 + index * 0.2,
        l: 498 + index * 0.2, c: 501 + index * 0.2, v: 5_000_000 + index,
      }));
      body = { bars, response_ts: NOW };
    } else if (url.pathname === '/v1/spot') {
      body = {
        spot: 526.8, last: 526.8, bid: 526.75, ask: 526.85,
        source: 'polygon_snapshot', freshness: 'real-time',
        as_of: new Date(NOW - 500).toISOString(),
      };
    } else if (url.pathname === '/v1/chain') {
      const dte = Number(url.searchParams.get('dte'));
      const right = url.searchParams.get('type');
      body = {
        spot: 526.8,
        contracts: [{
          contract: `O:SPY${dte}${right}`,
          type: right,
          strike: right === 'put' ? 510 : 540,
          expiration: new Date(NOW + dte * 86_400_000).toISOString().slice(0, 10),
          dte, bid: 2.1, ask: 2.2, mid: 2.15, iv: 0.24,
          delta: right === 'put' ? -0.24 : 0.25,
          gamma: 0.01, theta: -0.05, vega: 0.12, oi: 5000, volume: 600,
          quote_as_of: new Date(NOW - (staleChain ? 300_000 : 1000)).toISOString(),
        }],
      };
    } else if (url.pathname === '/v1/earnings-events') {
      body = { status: 'VERIFIED', source: 'MASSIVE_EARNINGS', events: [] };
    } else if (url.pathname === '/v1/corporate-actions') {
      body = { status: 'VERIFIED', source: 'MASSIVE_ACTIONS', splits: [] };
    } else if (url.pathname === '/v1/market-status') {
      body = { status: 'VERIFIED', market: 'open', as_of: new Date(NOW).toISOString() };
    } else if (url.pathname === '/v1/vix') {
      body = { vix: 22.4, response_ts: NOW };
    } else {
      return Response.json({ error: 'unknown' }, { status: 404 });
    }
    return Response.json(body);
  };
}

describe('Massive production provider', () => {
  test('normalizes live quotes, histories, chains, events, and session state', async () => {
    const provider = new MassiveProvider({ fetcher: marketFetcher(), now: () => NOW, dteTargets: [14, 30] });
    const [history, quote, chain, events, state] = await Promise.all([
      provider.history('SPY', { lookback: 120 }), provider.quote('SPY'),
      provider.optionChain('SPY', { expirations: [14, 30] }), provider.events('SPY'), provider.marketState(),
    ]);
    assert.equal(history.value.length, 130);
    assert.equal(quote.value.last, 526.8);
    assert.ok(quote.value.adv > 5_000_000);
    assert.equal(chain.value.contracts.length, 4);
    assert.ok(chain.value.contracts.every((contract) => Number.isFinite(contract.delta)));
    assert.deepEqual(events.value, []);
    assert.equal(state.value.status, 'OPEN');
    assert.ok(Number.isFinite(state.value.drawdown));
  });

  test('removes authority when every executable option quote is stale', async () => {
    const provider = new MassiveProvider({ fetcher: marketFetcher({ staleChain: true }), now: () => NOW });
    const chain = await provider.optionChain('SPY', { expirations: [14] });
    assert.equal(chain.error, 'MASSIVE_EXECUTABLE_CHAIN_UNAVAILABLE');
  });

  test('refuses a chain when any requested tenor/right slice is missing', async () => {
    const base = marketFetcher();
    const provider = new MassiveProvider({
      now: () => NOW,
      fetcher: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/v1/chain' && url.searchParams.get('type') === 'call') {
          return Response.json({ spot: 526.8, contracts: [] });
        }
        return base(request);
      },
    });
    assert.equal((await provider.optionChain('SPY', { expirations: [30] })).error,
      'MASSIVE_EXECUTABLE_CHAIN_UNAVAILABLE');
  });

  test('refuses a mislabeled right instead of trusting the request path', async () => {
    const base = marketFetcher();
    const provider = new MassiveProvider({
      now: () => NOW,
      fetcher: async (request) => {
        const response = await base(request);
        const url = new URL(request.url);
        if (url.pathname !== '/v1/chain' || url.searchParams.get('type') !== 'put') return response;
        const body = await response.json();
        body.contracts[0].type = 'call';
        return Response.json(body);
      },
    });
    assert.equal((await provider.optionChain('SPY', { expirations: [30] })).error,
      'MASSIVE_EXECUTABLE_CHAIN_UNAVAILABLE');
  });

  test('refuses materially future-dated option quotes', async () => {
    const base = marketFetcher();
    const provider = new MassiveProvider({
      now: () => NOW,
      fetcher: async (request) => {
        const response = await base(request);
        if (new URL(request.url).pathname !== '/v1/chain') return response;
        const body = await response.json();
        body.contracts[0].quote_as_of = new Date(NOW + 60_000).toISOString();
        return Response.json(body);
      },
    });
    assert.equal((await provider.optionChain('SPY', { expirations: [30] })).error,
      'MASSIVE_EXECUTABLE_CHAIN_UNAVAILABLE');
  });

  test('an incomplete event clearance is an error, never an empty calendar', async () => {
    const base = marketFetcher();
    const provider = new MassiveProvider({
      now: () => NOW,
      fetcher: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/v1/earnings-events') return Response.json({ status: 'INCOMPLETE' }, { status: 503 });
        return base(request);
      },
    });
    assert.match((await provider.events('SPY')).error, /INCOMPLETE|HTTP_503/u);
  });

  test('keeps mark-only custody data separate from executable quote requirements', async () => {
    const base = marketFetcher();
    const provider = new MassiveProvider({
      now: () => NOW,
      fetcher: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/v1/spot') {
          return Response.json({ last: 42, spot: 42, response_ts: NOW, source: 'polygon_last' });
        }
        if (url.pathname === '/v1/bars') {
          return Response.json({ bars: Array.from({ length: 60 }, (_, index) => ({
            t: NOW - (59 - index) * 86_400_000, o: 40, h: 43, l: 39,
            c: 40 + index * 0.03, v: 1_000_000,
          })) });
        }
        return base(request);
      },
    });
    assert.equal((await provider.markQuote('IPO')).value.last, 42);
    assert.equal((await provider.history('IPO', { minBars: 30 })).value.length, 60);
    assert.match((await provider.quote('IPO')).error, /HISTORY_SHORT|QUOTE_INCOMPLETE/u);
  });

  test('accepts a fresh underlying mark for options-only analysis but never invents a spread', async () => {
    const base = marketFetcher();
    const provider = new MassiveProvider({
      now: () => NOW,
      fetcher: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/v1/spot') {
          return Response.json({
            last: 526.8, response_ts: NOW, source: 'polygon_last', freshness: 'real-time',
          });
        }
        return base(request);
      },
    });
    const quote = await provider.quote('SPY');
    assert.equal(quote.value.last, 526.8);
    assert.equal(quote.value.bid, null);
    assert.equal(quote.value.ask, null);
    assert.equal(quote.value.underlyingMarket, 'MARK_ONLY');
  });

  test('does not coerce a missing quote timestamp into the Unix epoch', async () => {
    const base = marketFetcher();
    const provider = new MassiveProvider({
      now: () => NOW,
      fetcher: async (request) => {
        if (new URL(request.url).pathname === '/v1/spot') {
          return Response.json({ last: 526.8, bid: null, ask: null, as_of: null, response_ts: null });
        }
        return base(request);
      },
    });
    assert.equal((await provider.quote('SPY')).error, 'MASSIVE_QUOTE_INCOMPLETE');
  });

  test('does not query an issuer earnings calendar for a configured fund', async () => {
    const base = marketFetcher();
    let earningsCalls = 0;
    const provider = new MassiveProvider({
      now: () => NOW,
      fundSymbols: ['SPY'],
      fetcher: async (request) => {
        if (new URL(request.url).pathname === '/v1/earnings-events') earningsCalls += 1;
        return base(request);
      },
    });
    assert.deepEqual((await provider.events('SPY')).value, []);
    assert.equal(earningsCalls, 0);
  });

  test('never gives a delayed underlying the timestamp of a real-time option quote', async () => {
    const base = marketFetcher();
    const provider = new MassiveProvider({
      now: () => NOW,
      fetcher: async (request) => {
        if (new URL(request.url).pathname === '/v1/spot') {
          return Response.json({
            last: 500, bid: null, ask: null,
            as_of: new Date(NOW - 15 * 60_000).toISOString(),
            source: 'day_close', freshness: 'delayed',
          });
        }
        return base(request);
      },
    });
    await provider.optionChain('SPY', { expirations: [30] });
    assert.equal((await provider.quote('SPY')).error,
      'MASSIVE_UNDERLYING_NOT_REALTIME:DELAYED');
  });

  test('aligns Massive real-time options with an independently timestamped Schwab quote', async () => {
    const base = marketFetcher();
    const provider = new MassiveProvider({
      now: () => NOW,
      underlyingQuoteFetcher: async (symbol) => ({
        value: {
          symbol, last: 527.1, bid: 527.09, ask: 527.11, freshness: 'REAL_TIME',
        },
        asOf: NOW - 250,
        source: 'SCHWAB_MARKET_DATA_REALTIME',
      }),
      fetcher: async (request) => {
        if (new URL(request.url).pathname === '/v1/spot') {
          return Response.json({
            last: 500, as_of: new Date(NOW - 15 * 60_000).toISOString(),
            source: 'day_close', freshness: 'delayed',
          });
        }
        return base(request);
      },
    });
    const chain = await provider.optionChain('SPY', { expirations: [30] });
    const quote = await provider.quote('SPY');
    assert.equal(chain.value.spot, 527.1);
    assert.equal(chain.value.underlyingAsOf, NOW - 250);
    assert.equal(chain.value.underlyingSource, 'SCHWAB_MARKET_DATA_REALTIME');
    assert.equal(quote.value.last, 527.1);
    assert.equal(quote.asOf, NOW - 250);
    assert.equal(quote.source, 'SCHWAB_MARKET_DATA_REALTIME');
    assert.equal(quote.value.markTimestampBasis, 'SCHWAB_MARKET_DATA_QUOTE');
  });

  test('uses an independently timestamped Schwab VIX instead of Yahoo for regime authority', async () => {
    const provider = new MassiveProvider({
      now: () => NOW,
      fetcher: marketFetcher(),
      vixSymbol: '$VIX',
      underlyingQuoteFetcher: async (symbol) => ({
        value: { symbol, last: 15.82, freshness: 'REAL_TIME' },
        asOf: NOW - 300,
        source: 'SCHWAB_MARKET_DATA_REALTIME',
      }),
    });
    const state = await provider.marketState();
    assert.equal(state.value.vix, 15.82);
    assert.equal(state.value.vixSource, 'SCHWAB_MARKET_DATA_REALTIME');
    assert.equal(state.value.vixAsOf, NOW - 300);
  });

  test('retries a transient corporate-action failure without clearing it falsely', async () => {
    const base = marketFetcher();
    let actionCalls = 0;
    const provider = new MassiveProvider({
      now: () => NOW,
      fundSymbols: ['SPY'],
      fetcher: async (request) => {
        if (new URL(request.url).pathname === '/v1/corporate-actions' && actionCalls++ === 0) {
          return Response.json({ error: 'DIVIDENDS_PROVIDER_TIMEOUT' }, { status: 503 });
        }
        return base(request);
      },
    });
    assert.deepEqual((await provider.events('SPY')).value, []);
    assert.equal(actionCalls, 2);
  });

  test('retries a transient market-session failure without inventing a state', async () => {
    const base = marketFetcher();
    let statusCalls = 0;
    const provider = new MassiveProvider({
      now: () => NOW,
      fetcher: async (request) => {
        if (new URL(request.url).pathname === '/v1/market-status' && statusCalls++ === 0) {
          return Response.json({ error: 'SESSION_PROVIDER_TIMEOUT' }, { status: 503 });
        }
        return base(request);
      },
    });
    assert.equal((await provider.marketState()).value.status, 'OPEN');
    assert.equal(statusCalls, 2);
  });

  test('normalizes Massive extended hours to the correct verified session', async () => {
    const base = marketFetcher();
    const afterClose = Date.UTC(2026, 7, 24, 20, 15);
    const provider = new MassiveProvider({
      now: () => afterClose,
      fetcher: async (request) => {
        if (new URL(request.url).pathname === '/v1/market-status') {
          return Response.json({ market: 'extended-hours', as_of: new Date(afterClose).toISOString() });
        }
        return base(request);
      },
    });
    assert.equal((await provider.marketState()).value.status, 'POST');
  });
});

function schwabMarketClient({ stale = false, incomplete = false } = {}) {
  const option = (right, dte, strike) => ({
    putCall: right.toUpperCase(),
    symbol: `SPY  2609${String(dte).padStart(2, '0')}${right === 'put' ? 'P' : 'C'}${String(strike * 1000).padStart(8, '0')}`,
    strikePrice: strike,
    expirationDate: NOW + dte * 86_400_000,
    daysToExpiration: dte,
    bid: 2.1,
    ask: 2.2,
    volatility: 24,
    delta: incomplete ? null : right === 'put' ? -0.24 : 0.25,
    gamma: 0.01,
    theta: -0.05,
    vega: 0.12,
    openInterest: 5000,
    totalVolume: 600,
    multiplier: 100,
    quoteTimeInLong: NOW - (stale ? 300_000 : 1000),
  });
  const expirationMap = (right) => Object.fromEntries([14, 30].map((dte) => [
    `${new Date(NOW + dte * 86_400_000).toISOString().slice(0, 10)}:${dte}`,
    { [right === 'put' ? 510 : 540]: [option(right, dte, right === 'put' ? 510 : 540)] },
  ]));
  return {
    async marketQuote(ownerId, symbol) {
      return {
        value: {
          symbol,
          last: symbol === '$VIX' ? 15.8 : 527,
          bid: symbol === '$VIX' ? null : 526.99,
          ask: symbol === '$VIX' ? null : 527.01,
          freshness: 'REAL_TIME',
        },
        asOf: NOW - 250,
        source: 'SCHWAB_MARKET_DATA_REALTIME',
      };
    },
    async marketHistory() {
      return {
        empty: false,
        candles: Array.from({ length: 300 }, (_, index) => ({
          datetime: NOW - (299 - index) * 86_400_000,
          open: 470 + index * 0.1,
          high: 472 + index * 0.1,
          low: 468 + index * 0.1,
          close: 471 + index * 0.1,
          volume: 50_000_000 + index,
        })),
      };
    },
    async marketOptionChain() {
      return {
        isDelayed: false,
        isChainTruncated: false,
        underlyingPrice: 527,
        putExpDateMap: expirationMap('put'),
        callExpDateMap: expirationMap('call'),
      };
    },
    async marketHours() {
      return {
        option: {
          OPTION: {
            marketType: 'OPTION',
            isOpen: true,
            sessionHours: {
              regularMarket: [{
                start: new Date(NOW - 3_600_000).toISOString(),
                end: new Date(NOW + 3_600_000).toISOString(),
              }],
            },
          },
        },
      };
    },
  };
}

describe('Schwab-only production market provider', () => {
  test('does not treat Schwab top-level isOpen as options RTH before the regular interval', () => {
    const start = Date.UTC(2026, 7, 26, 13, 30);
    const packet = { option: { OPTION: { marketType: 'OPTION', isOpen: true, sessionHours: {
      regularMarket: [{ start: new Date(start).toISOString(), end: new Date(start + 6.5 * 3_600_000).toISOString() }],
    } } } };
    assert.equal(sessionStatus(packet, start - 15 * 60_000), 'CLOSED');
    assert.equal(sessionStatus(packet, start), 'OPEN');
  });
  test('normalizes real-time Schwab quotes, history, option chains, and market state', async () => {
    const eventProvider = { async events() { return { value: [], asOf: NOW, source: 'FUND_EVENT_CLEARANCE' }; } };
    const provider = new SchwabMarketProvider({
      client: schwabMarketClient(), ownerId: 'owner', now: () => NOW,
      dteTargets: [14, 30], eventProvider,
    });
    const [quote, history, chain, events, state] = await Promise.all([
      provider.quote('SPY'), provider.history('SPY', { lookback: 120 }),
      provider.optionChain('SPY', { expirations: [14, 30] }), provider.events('SPY'),
      provider.marketState(),
    ]);
    assert.equal(quote.value.last, 527);
    assert.equal(history.value.length, 120);
    assert.equal(chain.value.contracts.length, 4);
    assert.ok(chain.value.contracts.every((contract) => contract.iv === 0.24));
    assert.ok(chain.value.contracts.every((contract) => Number.isFinite(contract.delta)));
    assert.deepEqual(events.value, []);
    assert.equal(state.value.status, 'OPEN');
    assert.equal(state.value.vix, 15.8);
    assert.equal(state.value.vix3m, null,
      'term structure must stay unknown without an independent VIX3M quote');
    assert.equal(state.value.vixSource, 'SCHWAB_MARKET_DATA_REALTIME');
  });

  test('refuses stale Schwab option quotes instead of ranking them', async () => {
    const provider = new SchwabMarketProvider({
      client: schwabMarketClient({ stale: true }), ownerId: 'owner', now: () => NOW,
      dteTargets: [14, 30], eventProvider: { async events() { return { value: [], asOf: NOW }; } },
    });
    assert.equal((await provider.optionChain('SPY', { expirations: [14, 30] })).error,
      'SCHWAB_EXECUTABLE_CHAIN_UNAVAILABLE');
  });

  test('refuses a Schwab chain with missing underwriting Greeks', async () => {
    const provider = new SchwabMarketProvider({
      client: schwabMarketClient({ incomplete: true }), ownerId: 'owner', now: () => NOW,
      dteTargets: [14, 30], eventProvider: { async events() { return { value: [], asOf: NOW }; } },
    });
    assert.equal((await provider.optionChain('SPY', { expirations: [14, 30] })).error,
      'SCHWAB_EXECUTABLE_CHAIN_UNAVAILABLE');
  });
});

describe('evidence replay boundaries', () => {
  test('does not turn an unverified event calendar into a verified empty one', async () => {
    const missing = new ReplayProvider({ symbols: { SPY: { events: null, eventsAsOf: null } } });
    const verified = new ReplayProvider({ symbols: { SPY: { events: [], eventsAsOf: NOW } } });
    assert.match((await missing.events('SPY')).error, /no captured events/u);
    assert.deepEqual((await verified.events('SPY')).value, []);
  });

  test('preserves a captured market-state failure', async () => {
    const provider = new ReplayProvider({ indexState: {}, indexAsOf: null, indexError: 'SESSION_TIMEOUT' });
    assert.equal((await provider.marketState()).error, 'SESSION_TIMEOUT');
  });
});

describe('production evidence persistence', () => {
  test('never overwrites an existing R2 evidence object', async () => {
    let writes = 0;
    const persistence = new D1R2EvidencePersistence({
      ownerId: 'owner',
      db: {},
      bucket: {
        head: async () => ({ key: 'existing' }),
        put: async () => { writes += 1; },
      },
    });
    await assert.rejects(persistence.append({ sequence: 0, cycleId: 'CY-1' }),
      /EVIDENCE_OBJECT_ALREADY_EXISTS/u);
    assert.equal(writes, 0);
  });
});

describe('production cycle identity', () => {
  test('operator retries reuse an id while distinct requests cannot collide', () => {
    const common = { ownerId: 'owner-1234567890', source: 'OPERATOR' };
    const first = cycleIdFor({ ...common, idempotencyKey: 'request-key-00001' });
    assert.equal(first, cycleIdFor({ ...common, idempotencyKey: 'request-key-00001' }));
    assert.notEqual(first, cycleIdFor({ ...common, idempotencyKey: 'request-key-00002' }));
  });

  test('scheduled retries stay inside the deterministic fifteen-minute slot', () => {
    const common = { ownerId: 'owner-1234567890', source: 'SCHEDULED' };
    assert.equal(cycleIdFor({ ...common, now: NOW }), cycleIdFor({ ...common, now: NOW + 30_000 }));
  });
});

describe('listed expiration selection', () => {
  test('underwrites the actual listed DTEs instead of discarding nearest expirations', () => {
    const chain = { contracts: [
      { dte: 32 }, { dte: 11 }, { dte: 39 }, { dte: 32 }, { dte: null },
    ] };
    assert.deepEqual(availableContractDtes(chain), [11, 32, 39]);
  });
});

describe('Schwab production broker boundary', () => {
  test('normalizes a real-time Schwab market quote without exposing mutation', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url) => {
      assert.match(String(url), /\/marketdata\/v1\/quotes/u);
      return Response.json({
        SPY: {
          realtime: true,
          quote: {
            bidPrice: 526.99, askPrice: 527.01, lastPrice: 527,
            mark: 527, quoteTime: NOW - 100, tradeTime: NOW - 200,
            securityStatus: 'Normal',
          },
        },
      });
    });
    const client = new SchwabD1Client({
      NUVO_BROKER_MODE: 'READ_ONLY',
      NUVO_BROKER_EXECUTION_MODE: 'SHADOW_ONLY',
      SCHWAB_CLIENT_ID: 'test', SCHWAB_CLIENT_SECRET: 'test',
      SCHWAB_CALLBACK_URL: 'https://example.test/callback',
      BROKER_TOKEN_ENCRYPTION_KEY: 'test',
    });
    client._accessToken = async () => 'read-only-test-token';
    const quote = await client.marketQuote('owner', 'SPY');
    assert.equal(quote.value.last, 527);
    assert.equal(quote.value.freshness, 'REAL_TIME');
    assert.equal(quote.source, 'SCHWAB_MARKET_DATA_REALTIME');
  });

  test('refuses a delayed Schwab market quote', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({
      SPY: { realtime: false, quote: { lastPrice: 527, quoteTime: NOW - 100 } },
    }));
    const client = new SchwabD1Client({
      NUVO_BROKER_MODE: 'READ_ONLY',
      NUVO_BROKER_EXECUTION_MODE: 'SHADOW_ONLY',
      SCHWAB_CLIENT_ID: 'test', SCHWAB_CLIENT_SECRET: 'test',
      SCHWAB_CALLBACK_URL: 'https://example.test/callback',
      BROKER_TOKEN_ENCRYPTION_KEY: 'test',
    });
    client._accessToken = async () => 'read-only-test-token';
    await assert.rejects(client.marketQuote('owner', 'SPY'),
      /SCHWAB_MARKET_DATA_NOT_REALTIME/u);
  });

  test('requests a bounded real-time Schwab option chain', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.pathname, '/marketdata/v1/chains');
      assert.equal(parsed.searchParams.get('contractType'), 'ALL');
      assert.equal(parsed.searchParams.get('includeUnderlyingQuote'), 'true');
      assert.equal(parsed.searchParams.get('fromDate'), '2026-09-01');
      assert.equal(parsed.searchParams.get('toDate'), '2026-10-15');
      return Response.json({ isDelayed: false, isChainTruncated: false });
    });
    const client = new SchwabD1Client({
      NUVO_BROKER_MODE: 'READ_ONLY',
      NUVO_BROKER_EXECUTION_MODE: 'SHADOW_ONLY',
      SCHWAB_CLIENT_ID: 'test', SCHWAB_CLIENT_SECRET: 'test',
      SCHWAB_CALLBACK_URL: 'https://example.test/callback',
      BROKER_TOKEN_ENCRYPTION_KEY: 'test',
    });
    client._accessToken = async () => 'read-only-test-token';
    await client.marketOptionChain('owner', 'SPY', {
      fromDate: '2026-09-01', toDate: '2026-10-15',
    });
  });

  test('refuses a delayed Schwab option-chain packet', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({
      isDelayed: true, isChainTruncated: false,
    }));
    const client = new SchwabD1Client({
      NUVO_BROKER_MODE: 'READ_ONLY',
      NUVO_BROKER_EXECUTION_MODE: 'SHADOW_ONLY',
      SCHWAB_CLIENT_ID: 'test', SCHWAB_CLIENT_SECRET: 'test',
      SCHWAB_CALLBACK_URL: 'https://example.test/callback',
      BROKER_TOKEN_ENCRYPTION_KEY: 'test',
    });
    client._accessToken = async () => 'read-only-test-token';
    await assert.rejects(client.marketOptionChain('owner', 'SPY', {
      fromDate: '2026-09-01', toDate: '2026-10-15',
    }), /SCHWAB_OPTION_CHAIN_NOT_REALTIME/u);
  });

  test('requests an exact held strike instead of truncating custody to the discovery window', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.searchParams.get('strike'), '7700');
      assert.equal(parsed.searchParams.has('strikeCount'), false);
      return Response.json({ isDelayed: false, isChainTruncated: false });
    });
    const client = new SchwabD1Client({
      NUVO_BROKER_MODE: 'READ_ONLY',
      NUVO_BROKER_EXECUTION_MODE: 'SHADOW_ONLY',
      SCHWAB_CLIENT_ID: 'test', SCHWAB_CLIENT_SECRET: 'test',
      SCHWAB_CALLBACK_URL: 'https://example.test/callback',
      BROKER_TOKEN_ENCRYPTION_KEY: 'test',
    });
    client._accessToken = async () => 'read-only-test-token';
    await client.marketOptionChain('owner', '$SPX', {
      fromDate: '2026-08-25', toDate: '2026-08-26', strike: 7700,
    });
  });

  test('normalizes exact Schwab option Greeks for custody fallback', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url) => {
      assert.match(decodeURIComponent(String(url)), /SPXW {2}260825C07700000/u);
      return Response.json({
        'SPXW  260825C07700000': {
          symbol: 'SPXW  260825C07700000',
          realtime: true,
          quote: {
            bidPrice: 0.3, askPrice: 0.4, mark: 0.35, volatility: 18,
            underlyingPrice: 7705,
            delta: 0.02, gamma: 0.001, theta: -0.04, vega: 0.03,
            openInterest: 500, totalVolume: 10, quoteTime: NOW - 500,
          },
        },
      });
    });
    const client = new SchwabD1Client({
      NUVO_BROKER_MODE: 'READ_ONLY',
      NUVO_BROKER_EXECUTION_MODE: 'SHADOW_ONLY',
      SCHWAB_CLIENT_ID: 'test', SCHWAB_CLIENT_SECRET: 'test',
      SCHWAB_CALLBACK_URL: 'https://example.test/callback',
      BROKER_TOKEN_ENCRYPTION_KEY: 'test',
    });
    client._accessToken = async () => 'read-only-test-token';
    const quote = await client.marketOptionQuote('owner', 'SPXW260825C07700000');
    assert.equal(quote.value.iv, 0.18);
    assert.equal(quote.value.delta, 0.02);
    assert.equal(quote.value.underlyingPrice, 7705);
    assert.equal(quote.source, 'SCHWAB_MARKET_DATA_OPTION_QUOTE_REALTIME');
  });

  test('exposes custody but has no mutation capability', async () => {
    let calls = 0;
    const snapshot = {
      cash: 50_000, buyingPower: 40_000, nav: 100_000, asOf: NOW,
      positions: [], openOrders: [],
    };
    const broker = new SchwabReadOnlyBroker({
      ownerId: 'owner', client: { async snapshot() { calls += 1; return snapshot; } }, now: () => NOW,
    });
    assert.equal((await broker.accountState()).value.nav, 100_000);
    assert.deepEqual((await broker.positions()).value, []);
    assert.deepEqual((await broker.openOrders()).value, []);
    assert.equal(calls, 1, 'one custody snapshot must back all reconciliation facts');
    assert.equal((await broker.submit({})).error, 'SCHWAB_MUTATION_DISABLED_SHADOW_ONLY');
    assert.equal((await broker.cancel('x')).error, 'SCHWAB_MUTATION_DISABLED_SHADOW_ONLY');
  });

  test('a custody failure is surfaced as unknown, not zero', async () => {
    const broker = new SchwabReadOnlyBroker({
      ownerId: 'owner', client: { async snapshot() { throw new Error('SCHWAB_SESSION_EXPIRED'); } },
    });
    assert.equal((await broker.accountState()).error, 'SCHWAB_SESSION_EXPIRED');
    assert.equal((await broker.positions()).error, 'SCHWAB_SESSION_EXPIRED');
  });
});

describe('Schwab multi-account normalization', () => {
  test('preserves every transfer item while keeping the original primary transaction identity', () => {
    const observedAt = '2026-08-26T15:00:00.000Z';
    const rows = normalizeTransactions({
      activityId: 'TX-42', type: 'TRADE', netAmount: -12_345, time: observedAt,
      transferItems: [
        { instrument: { assetType: 'CURRENCY' }, amount: -12_345 },
        { instrument: { assetType: 'EQUITY', symbol: 'SPCX' }, amount: 100, price: 123.45 },
      ],
    }, '1234', observedAt);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].symbol, 'SPCX');
    assert.equal(rows[0].transactionLegId, null);
    assert.equal(rows[1].symbol, 'CURRENCY');
    assert.equal(rows[1].transactionLegId, 'ITEM:1');
  });

  test('walks historical ledger windows deterministically to the configured floor', () => {
    assert.deepEqual(historicalLedgerWindow(
      '2026-03-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 30,
    ), {
      start: '2026-01-30T00:00:00.000Z', end: '2026-03-01T00:00:00.000Z', complete: false,
    });
    assert.deepEqual(historicalLedgerWindow(
      '2026-01-20T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 30,
    ), {
      start: '2026-01-01T00:00:00.000Z', end: '2026-01-20T00:00:00.000Z', complete: true,
    });
    assert.equal(historicalLedgerWindow(
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 30,
    ), null);
  });

  test('does not turn a missing Schwab quantity into a zero holding', () => {
    const position = normalizePosition({
      instrument: { symbol: 'SPY', assetType: 'EQUITY' },
      longQuantity: null,
      shortQuantity: 0,
      marketValue: 100,
    });
    assert.equal(position.quantity, null);
  });

  test('preserves Schwab current-day P&L and its reconciliation inputs', () => {
    const raw = {
      instrument: { symbol: 'SPY', assetType: 'EQUITY' },
      longQuantity: 100,
      shortQuantity: 0,
      marketValue: 52_700,
      currentDayProfitLoss: -318.42,
      currentDayProfitLossPercentage: -0.6,
      previousClose: 530.1842,
      futureSchwabField: { preserved: true },
    };
    const before = structuredClone(raw);
    const position = normalizePosition(raw);
    assert.equal(position.dayProfitLoss, -318.42);
    assert.equal(position.rawDayProfitLoss, -318.42);
    assert.deepEqual(raw, before, 'normalization must not alter the raw Schwab position row');
  });

  test('reconciles the exact carried CBRS day-cost identity when the session ledger has no trade', () => {
    const position = reconcilePositionDayProfitLoss(normalizePosition({
      instrument: { symbol: 'CBRS', assetType: 'EQUITY', netChange: 3.5003 },
      longQuantity: 500,
      shortQuantity: 0,
      previousSessionLongQuantity: 500,
      currentDayProfitLoss: -16_319.85,
      currentDayCost: 18_070,
      marketValue: 93_835,
      averagePrice: 202.94946,
    }), [], '2026-08-27T03:10:52.744Z');
    assert.equal(position.rawDayProfitLoss, -16_319.85);
    assert.equal(position.dayProfitLossReference, 1_750.15);
    assert.equal(position.dayProfitLoss, 1_750.15);
    assert.equal(position.dayProfitLossAdjustment, 18_070);
    assert.equal(position.dayProfitLossSource, 'SCHWAB_RECONCILED_CARRIED_CURRENT_DAY_COST');
    assert.equal(position.dayProfitLossContributionMode, 'SUBSTITUTED');
    assert.equal(position.dayProfitLossTriggerReason,
      'CURRENT_DAY_COST_IDENTITY_WITHOUT_SAME_SESSION_TRADE');
  });

  test('keeps same-session option fill-to-mark P&L instead of adding currentDayCost', () => {
    const position = reconcilePositionDayProfitLoss(normalizePosition({
      instrument: { symbol: 'CBRS  260828C00210000', assetType: 'OPTION', netChange: -0.54 },
      longQuantity: 0,
      shortQuantity: 5,
      previousSessionShortQuantity: 0,
      currentDayProfitLoss: 67.5,
      currentDayCost: -280,
      marketValue: -212.5,
      averagePrice: 0.56,
    }), [{
      type: 'TRADE', symbol: 'CBRS260828C00210000', occurredAt: '2026-08-26T19:16:38.000Z',
    }], '2026-08-27T03:10:52.744Z');
    assert.equal(position.dayProfitLoss, 67.5);
    assert.equal(position.dayProfitLossSource, 'SCHWAB_POSITION_CURRENT_DAY_PROFIT_LOSS');
    assert.equal(position.dayProfitLossContributionMode, 'RAW');
    assert.equal(position.dayProfitLossTriggerReason, 'RAW_FIELD_ACCEPTED');
  });

  test('does not replace raw P&L for a same-session round trip ending at the prior quantity', () => {
    const normalized = normalizePosition({
      instrument: { symbol: 'SPY', assetType: 'EQUITY', netChange: 1 },
      longQuantity: 100,
      shortQuantity: 0,
      previousSessionLongQuantity: 100,
      currentDayProfitLoss: 50,
      currentDayCost: 50,
    });
    const position = reconcilePositionDayProfitLoss(normalized, [{
      type: 'TRADE', symbol: 'SPY', occurredAt: '2026-08-26T15:00:00.000Z',
    }], '2026-08-27T03:10:52.744Z');
    assert.equal(normalized.dayProfitLossReference, 100);
    assert.equal(position.dayProfitLoss, 50);
  });

  test('seals complete raw Schwab position rows inside the observation hash chain', () => {
    const source = readFileSync(new URL('../cloudflare/schwab-client.js', import.meta.url), 'utf8');
    assert.match(source, /rawPositions = Array\.isArray\(account\.positions\) \? account\.positions : \[\]/u);
    assert.match(source, /rawPositionPackets/u);
    assert.match(source, /account, positions: snapshot\.positions, rawPositionPackets, openOrders/u);
    assert.match(source, /positions_json,raw_positions_json,orders_json/u);
    assert.match(source, /carried currentDayCost reconciled with instrument\.netChange/u);
  });

  test('aggregates the same custody instrument before reconciliation and risk', () => {
    const positions = aggregatePositions([
      { symbol: 'SPY', underlying: 'SPY', type: 'EQUITY', right: null, strike: null,
        expiration: null, quantity: 40, marketValue: 20_000, averagePrice: 480,
        dayProfitLoss: 125 },
      { symbol: 'SPY', underlying: 'SPY', type: 'EQUITY', right: null, strike: null,
        expiration: null, quantity: 60, marketValue: 30_000, averagePrice: 500,
        dayProfitLoss: -25 },
    ]);
    assert.equal(positions.length, 1);
    assert.equal(positions[0].quantity, 100);
    assert.equal(positions[0].marketValue, 50_000);
    assert.equal(positions[0].averagePrice, 492);
    assert.equal(positions[0].dayProfitLoss, 100);
  });

  test('does not fabricate an aggregate market value when one account lacks it', () => {
    const [position] = aggregatePositions([
      { symbol: 'SPY', underlying: 'SPY', type: 'EQUITY', quantity: 1, marketValue: 500 },
      { symbol: 'SPY', underlying: 'SPY', type: 'EQUITY', quantity: 1, marketValue: null },
    ]);
    assert.equal(position.marketValue, null);
  });

  test('does not fabricate aggregate day P&L when one account lacks the broker field', () => {
    const [position] = aggregatePositions([
      { symbol: 'SPY', underlying: 'SPY', type: 'EQUITY', quantity: 1,
        marketValue: 500, dayProfitLoss: 12.5 },
      { symbol: 'SPY', underlying: 'SPY', type: 'EQUITY', quantity: 1,
        marketValue: 500, dayProfitLoss: null },
    ]);
    assert.equal(position.dayProfitLoss, null);
  });

  test('marks a failed live custody read degraded instead of leaving connected green', async () => {
    let statement = '';
    let values = [];
    const client = new SchwabD1Client({
      DB: {
        prepare(sql) {
          statement = sql;
          return {
            bind(...bound) {
              values = bound;
              return { async run() { return { success: true }; } };
            },
          };
        },
      },
    });
    client._snapshot = async () => { throw new Error('SCHWAB_READ_503'); };
    await assert.rejects(client.snapshot('owner'), /SCHWAB_READ_503/u);
    assert.match(statement, /status='DEGRADED'/u);
    assert.equal(values[0], 'SCHWAB_READ_503');
  });
});

describe('custody risk mapping', () => {
  const expiration = new Date(NOW + 30 * 86_400_000).toISOString().slice(0, 10);
  const provider = {
    async quote(symbol) {
      return { value: { symbol, last: 100, sector: 'UNKNOWN', beta: null }, asOf: NOW };
    },
    async history() {
      return { value: Array.from({ length: 130 }, (_, index) => ({ c: 80 + index * 0.2 })), asOf: NOW };
    },
    async optionChain(symbol) {
      return { value: { contracts: [
        { underlying: symbol, right: 'put', strike: 90, expiration, mid: 1.2,
          iv: 0.25, delta: -0.2, gamma: 0.01, vega: 0.1, theta: -0.03 },
        { underlying: symbol, right: 'call', strike: 110, expiration, mid: 1.1,
          iv: 0.23, delta: 0.2, gamma: 0.01, vega: 0.1, theta: -0.03 },
      ] }, asOf: NOW };
    },
  };

  test('maps existing shares and short puts into conservative Governor positions', async () => {
    const mapped = await mapCustodyRisk({ provider, now: NOW, positions: [
      { symbol: 'SPY', underlying: 'SPY', type: 'EQUITY', quantity: 100, multiplier: 1 },
      { symbol: 'SPY-P90', underlying: 'SPY', type: 'OPTION', right: 'put', strike: 90,
        expiration, quantity: -1, multiplier: 100, marketValue: -120 },
    ] });
    assert.equal(mapped.ok, true);
    assert.equal(mapped.positions.length, 2);
    assert.equal(mapped.positions[0].economicCapital, 10_000);
    assert.equal(mapped.positions[1].economicCapital, 9_000);
    assert.equal(mapped.positions[1].quantity, -1);
    assert.ok(mapped.returnsBySymbol.SPY.length >= 120);
    assert.equal(mapped.sectors.SPY, 'CUSTODY_UNCLASSIFIED');
  });

  test('refuses an uncovered short call instead of assigning finite safe-looking risk', async () => {
    const mapped = await mapCustodyRisk({ provider, now: NOW, positions: [
      { symbol: 'SPY-C110', underlying: 'SPY', type: 'OPTION', right: 'call', strike: 110,
        expiration, quantity: -1, multiplier: 100, marketValue: -110 },
    ] });
    assert.equal(mapped.ok, false);
    assert.match(mapped.reasons.join(','), /UNCOVERED_CALL_UNDEFINED_RISK/u);
  });

  test('floors short-history equity volatility instead of trusting a thin IPO sample', async () => {
    const thinProvider = {
      ...provider,
      async history() {
        return { value: Array.from({ length: 45 }, (_, index) => ({ c: 99 + index * 0.02 })), asOf: NOW };
      },
    };
    const mapped = await mapCustodyRisk({ provider: thinProvider, now: NOW, positions: [
      { symbol: 'IPO', underlying: 'IPO', type: 'EQUITY', quantity: 10, multiplier: 1 },
    ] });
    assert.equal(mapped.ok, true);
    assert.equal(mapped.positions[0].iv, 0.80);
  });

  test('refuses a custody position with a missing quantity instead of treating it as zero', async () => {
    const mapped = await mapCustodyRisk({ provider, now: NOW, positions: [
      { symbol: 'SPY', underlying: 'SPY', type: 'EQUITY', quantity: null },
    ] });
    assert.equal(mapped.ok, false);
    assert.match(mapped.reasons[0], /CUSTODY_POSITION_INCOMPLETE/u);
  });

  test('uses the exact option quote when the expiration-day chain is unavailable', async () => {
    const exactProvider = {
      ...provider,
      async optionChain() { return { error: 'CHAIN_EMPTY_AT_EXPIRY' }; },
      async optionQuote(symbol) {
        return { value: { symbol, mid: 1.1, iv: 0.23, delta: 0.2,
          gamma: 0.01, vega: 0.1, theta: -0.03 } };
      },
    };
    const mapped = await mapCustodyRisk({ provider: exactProvider, now: NOW, positions: [
      { symbol: 'SPY-C110', underlying: 'SPY', type: 'OPTION', right: 'call', strike: 110,
        expiration, quantity: 1, multiplier: 100, marketValue: 110 },
    ] });
    assert.equal(mapped.ok, true);
    assert.equal(mapped.positions[0].iv, 0.23);
  });

  test('maps the SPXW option root to Schwab market symbol $SPX', async () => {
    const requested = [];
    const indexProvider = {
      ...provider,
      async quote(symbol) {
        requested.push(['quote', symbol]);
        return provider.quote(symbol);
      },
      async history(symbol) {
        requested.push(['history', symbol]);
        return provider.history(symbol);
      },
      async optionChain(symbol, options) {
        requested.push(['chain', symbol, options?.strikes?.[0]]);
        return provider.optionChain(symbol);
      },
    };
    const mapped = await mapCustodyRisk({ provider: indexProvider, now: NOW, positions: [
      { symbol: 'SPXW-C110', underlying: 'SPXW', type: 'OPTION', right: 'call', strike: 110,
        expiration, quantity: 1, multiplier: 100, marketValue: 110 },
    ] });
    assert.equal(mapped.ok, true);
    assert.equal(mapped.positions[0].underlying, '$SPX');
    assert.ok(requested.every(([, symbol]) => symbol === '$SPX'));
    assert.deepEqual(requested.find(([type]) => type === 'chain'), ['chain', '$SPX', 110]);
  });
});
