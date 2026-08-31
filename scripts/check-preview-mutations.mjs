// Offline negative-control test: mutate module source in memory in a child
// process. Never edits production files, sends live requests, or deploys.
import { registerHooks } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const quantityGuard = "|| typeof echoed.quantity !== 'number' || echoed.quantity !== 1";
const symbolGuard = "|| typeof instrument?.symbol !== 'string' || instrument.symbol !== 'SPY'";
const legGuard = '!Array.isArray(echoed.orderLegs) || echoed.orderLegs.length !== 1';
const cases = [
  { name: 'quantity guard removed', test: 'live-body negative mutation refuses: missing order quantity',
    edits: [[quantityGuard, '']] },
  { name: 'string quantity coerced', test: 'live-derived response mapping fails closed on quantity "1"',
    edits: [[quantityGuard, '|| Number(echoed.quantity) !== 1']] },
  { name: 'legacy leg quantity fallback',
    test: 'live-body negative mutation refuses: legacy leg quantity cannot replace missing order quantity',
    edits: [[quantityGuard, '|| (echoed.quantity ?? leg?.quantity) !== 1']] },
  { name: 'symbol guard removed', test: 'omitted lists cannot bypass echoed contract: missing symbol; mismatch is retained',
    edits: [[symbolGuard, '']] },
  { name: 'legacy finalSymbol fallback',
    test: 'live-body negative mutation refuses: legacy finalSymbol cannot replace missing instrument symbol',
    edits: [[symbolGuard, "|| (instrument?.symbol ?? leg?.finalSymbol) !== 'SPY'"]] },
  { name: 'single-leg guard removed', test: 'two live-derived legs with order-level quantity exactly one refuse',
    edits: [[legGuard, '!Array.isArray(echoed.orderLegs)']] },
  { name: 'reject guard removed', test: 'nonempty rejects added to the live warns-only body refuses',
    edits: [['|| (validation.rejects?.length ?? 0) > 0', '']] },
  { name: 'review guard removed', test: 'nonempty reviews added to the live warns-only body refuses',
    edits: [['|| (validation.reviews?.length ?? 0) > 0', '']] },
  { name: 'asset allowlists removed', test: 'live-body negative mutation refuses: unknown assets agree',
    edits: [['|| !LANE_1_PREVIEW_ASSET_TYPES.includes(leg?.assetType)', ''],
      ['|| !LANE_1_PREVIEW_ASSET_TYPES.includes(instrument?.assetType)', '']] },
  { name: 'asset agreement removed', test: 'live-body negative mutation refuses: allowed assets disagree leg EQUITY',
    edits: [['|| leg.assetType !== instrument.assetType', '']] },
  { name: 'old wrong mapping restored',
    test: 'production-byte mapping: unchanged redacted live BUY SPY one-share body with warns only clears',
    edits: [[quantityGuard, '|| leg?.quantity !== 1'],
      [symbolGuard, "|| leg?.finalSymbol !== 'SPY'"]] },
  { name: 'old receipt quantity projection restored', target: '/cloudflare/lane-1-runtime.js',
    test: 'production-byte mapping: unchanged redacted live BUY SPY one-share body with warns only clears',
    edits: [['quantity: scalar(order?.quantity)', 'quantity: scalar(leg?.quantity)']] },
  { name: 'OPTION refusal guard removed',
    test: 'omitted lists cannot bypass echoed contract: option asset; mismatch is retained',
    edits: [['|| !LANE_1_PREVIEW_ASSET_TYPES.includes(leg?.assetType)', ''],
      ['|| !LANE_1_PREVIEW_ASSET_TYPES.includes(instrument?.assetType)', '']] },
];

const active = process.env.NUVO_PREVIEW_TEST_MUTANT;
if (active) {
  const mutant = cases.find((item) => item.name === active);
  assert(mutant, 'unknown mutant');
  registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.endsWith(mutant.target ?? '/cloudflare/schwab-client.js')) return loaded;
    let source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString();
    for (const [from, to] of mutant.edits) {
      assert.equal(source.split(from).length, 2, 'mutation must match exactly one source anchor');
      source = source.replace(from, to);
    }
    return { ...loaded, source };
  } });
} else {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const results = [];
  for (const mutant of cases) {
    const args = ['--test', '--test-reporter=tap', `--test-name-pattern=^${escaped(mutant.test)}$`,
      'test/lane-1-ingress-preview.test.js'];
    const healthy = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
    assert.equal(healthy.status, 0, `healthy test must pass: ${mutant.test}\n${healthy.stdout}${healthy.stderr}`);
    assert.match(healthy.stdout, /# pass 1\b/u, 'exactly one selected positive control');
    const broken = spawnSync(process.execPath, ['--import', import.meta.url, ...args], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, NUVO_PREVIEW_TEST_MUTANT: mutant.name },
    });
    assert.equal(broken.status, 1, `guard mutation must fail the test: ${mutant.name}`);
    assert.match(broken.stdout, /ERR_ASSERTION/u, 'must fail an assertion, not import/setup');
    assert.match(broken.stdout, /# fail 1\b/u, 'exactly one selected negative control');
    assert(broken.stdout.includes(mutant.test), 'intended test executed');
    assert(!broken.stdout.includes('mutation must match exactly one source anchor'), 'source anchor failure is not a kill');
    results.push({ mutant: mutant.name, test: mutant.test, healthy: 'PASS', mutated: 'FAIL_EXPECTED', killed: true });
  }
  console.log(JSON.stringify({ scope: 'offline in-memory module mutations; no source writes',
    killed: results.length, total: cases.length, results }, null, 2));
}
