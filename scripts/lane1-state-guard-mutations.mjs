// In-memory Node loader mutations. Never rewrites application or test files.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const guard = 'src/lane/lane-1-position-guards.js';
const client = 'cloudflare/schwab-client.js';
const guardTest = 'test/lane-1-position-guards.test.js';
const dispatchTest = 'test/lane-1-dispatch-recheck.test.js';
const mutations = [
  ['missing positions default FLAT', guard, "if (!Array.isArray(positions)) drift('BROKER_POSITION_UNKNOWN:positions');",
    "if (!Array.isArray(positions)) return { positionSide: 'FLAT' };", guardTest, 'missing positions never means FLAT'],
  ['coerce quantity strings', guard, "typeof row[field] !== 'number' || !Number.isFinite(row[field])",
    '!Number.isFinite(Number(row[field]))', guardTest, 'missing and nonnumeric long/short quantities refuse without coercion'],
  ['net away gross exposure', guard, 'longQuantity + shortQuantity > 1',
    'Math.abs(longQuantity - shortQuantity) > 1', guardTest, 'gross and fractional exposure cannot net to an allowed position'],
  ['ignore coordinator/broker disagreement', guard, "if (durableSide !== position.positionSide) drift('COORDINATOR_BROKER_DISAGREEMENT');",
    '', guardTest, 'known coordinator/broker disagreement refuses'],
  ['skip quantity contract', guard, "if (quantity !== 1) throw new Error('LANE_1_QUANTITY_MUST_BE_ONE');",
    '', guardTest, 'instruction quantity is numeric one only'],
  ['allow SELL while flat', guard, "SELL: Object.freeze({ from: 'LONG'", "SELL: Object.freeze({ from: 'FLAT'", guardTest, 'FLAT + SELL =>'],
  ['allow BUY while long', guard, "BUY: Object.freeze({ from: 'FLAT'", "BUY: Object.freeze({ from: 'LONG'", guardTest, 'LONG + BUY =>'],
  ['allow SELL_SHORT while short', guard, "SELL_SHORT: Object.freeze({ from: 'FLAT'", "SELL_SHORT: Object.freeze({ from: 'SHORT'", guardTest, 'SHORT + SELL_SHORT =>'],
  ['allow COVER while flat', guard, "BUY_TO_COVER: Object.freeze({ from: 'SHORT'", "BUY_TO_COVER: Object.freeze({ from: 'FLAT'", guardTest, 'FLAT + BUY_TO_COVER =>'],
  ['skip working-order refusal', guard, "if (!TERMINAL.includes(order.status)) throw new Error('LANE_1_WORKING_ORDER_PRESENT');",
    '', guardTest, 'working and pending SPY orders block'],
  ['skip nested orders', guard, 'for (const child of children ?? []) visit(child, depth + 1);',
    '', guardTest, 'SPY in a second leg or child of a terminal parent cannot be skipped'],
  ['ignore capped results', guard, "if (orders.length >= 3000) throw new Error('LANE_1_ORDER_READ_LIMIT_REACHED');",
    '', guardTest, 'capped order result is not proof of no working orders'],
  ['ignore final account change', guard, "if (expected.accountHash !== current.accountHash) drift('ACCOUNT_CHANGED');",
    '', guardTest, 'final account or position change refuses'],
  ['ignore order-history change', guard, "throw new Error('LANE_1_PRE_DISPATCH_ORDER_STATE_CHANGED');",
    '', guardTest, 'changed terminal order history or query window refuses even while flat'],
  ['allow stale final snapshot', guard, 'age > 5000', 'age > Infinity', guardTest, 'slow future or invalid final reads refuse'],
  ['ignore final DISARM', guard, "if (state?.armed !== true) throw new Error('LANE_1_DISARMED');",
    '', guardTest, 'final DISARM wins over an earlier armed snapshot'],
  ['ignore expired ARM', guard, "throw new Error('LANE_1_ARM_WINDOW_EXPIRED');",
    '', guardTest, 'expired or missing final ARM window refuses'],
  ['ignore changed claim', guard, "throw new Error('LANE_1_DISPATCH_CLAIM_CHANGED');",
    '', guardTest, 'changed claim stage identity instruction or accepted order refuses'],
  ['skip final comparison at transport boundary', client, 'assertLane1SnapshotUnchanged(expected, current);',
    '', dispatchTest, 'position changes after initial read => exact refusal and zero POST'],
  ['reuse initial snapshot instead of rereading broker', client,
    'const current = await this._lane1V21SendSnapshot(account, expected.ordersFrom);',
    'const current = expected;', dispatchTest, 'working order appears after initial read => exact refusal and zero POST'],
  ['skip final coordinator check at transport boundary', client,
    'assertLane1DispatchCoordinator(state, { instruction, clientOrderId, positionSide: expected.positionSide });',
    '', dispatchTest, 'Principal disarms during broker reads => exact refusal and zero POST'],
  ['broker failure becomes empty data', client,
    "if (!response.ok) throw new Error(`SCHWAB_READ_${response.status}:${path.split('?')[0]}`);",
    'if (!response.ok) return [];', dispatchTest, 'orders endpoint fails => exact refusal and zero POST'],
  ['skip partial response checks', client, '{ completeOrderList: true }',
    '{ completeOrderList: false }', dispatchTest, 'partial HTTP 206 list => exact refusal and zero POST'],
  ['runtime drops baseline snapshot', 'cloudflare/lane-1-runtime.js',
    'durableArm: await durableArm(), expectedSnapshot,', 'durableArm: await durableArm(),',
    dispatchTest, 'production runtime wiring carries snapshot and claim identity through to the final recheck'],
  ['reconciliation skips unknown coordinator', 'src/lane/lane-1-spy-v2.js',
    "if (state?.positionSide === 'FLAT') return null;", "if (!['LONG', 'SHORT'].includes(state?.positionSide)) return null;",
    'test/lane-1-spy-v2.test.js', 'reconciliation reports unknown coordinator state instead of skipping it'],
  ['reconciliation skips broker shape check', 'src/lane/lane-1-spy-v2.js',
    'assertLane1PositionAgreement(custody?.positionSide, custody);', '',
    'test/lane-1-spy-v2.test.js', 'reconciliation reports unknown broker state instead of calling it an external flatten'],
];

const results = [];
for (const [name, file, from, to, testFile, testName] of mutations) {
  const url = new URL(file, root).href;
  const source = readFileSync(new URL(file, root), 'utf8');
  if (source.split(from).length !== 2) throw new Error(`MUTATION_ANCHOR_NOT_UNIQUE:${name}`);
  const hook = `import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, next) {
      const result = next(url, context);
      if (url === ${JSON.stringify(url)}) {
        const source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
        process.stderr.write('MUTATION_APPLIED\\n');
        return { ...result, source: source.replace(${JSON.stringify(from)}, ${JSON.stringify(to)}) };
      }
      return result;
    }});`;
  const pattern = testName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const args = ['--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, testFile];
  const healthy = spawnSync(process.execPath, args,
    { cwd: fileURLToPath(root), encoding: 'utf8', timeout: 15_000 });
  if (healthy.status !== 0 || !/# pass 1\b/u.test(healthy.stdout)) {
    throw new Error(`HEALTHY_SELECTED_TEST_MUST_PASS:${name}\n${healthy.stdout}${healthy.stderr}`);
  }
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript;base64,${Buffer.from(hook).toString('base64')}`,
    ...args],
  { cwd: fileURLToPath(root), encoding: 'utf8', timeout: 15_000 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const detected = result.status === 1 && output.includes('MUTATION_APPLIED')
    && /^not ok \d+ - /mu.test(output) && /# fail 1\b/u.test(output)
    && output.includes('ERR_ASSERTION') && output.includes(testName)
    && !/SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND/u.test(output);
  results.push({ name, file, test: testName, detected });
  if (!detected) process.stderr.write(output);
}
console.log(JSON.stringify({ mutationMode: 'in-memory loader; no application writes',
  detected: results.filter((r) => r.detected).length, total: results.length, results }, null, 2));
if (results.some((r) => !r.detected)) process.exitCode = 1;
