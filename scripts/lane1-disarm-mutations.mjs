// Offline, in-memory loader mutations. Never modifies application or test files.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const runtime = 'cloudflare/lane-1-runtime.js';
const worker = 'cloudflare/worker.js';
const adapterTest = 'test/lane-1-production-adapters.test.js';
const viewTest = 'test/lane-1-spy-view.test.js';
const mobileTest = 'test/mobile-dashboard.test.js';
const cases = [
  ['trust write result instead of authoritative readback', runtime,
    'const state = await coordinator.status();',
    "const state = { armed: false, stage: 'DISARMED', updatedAt: null };",
    adapterTest, 'dashboard DISARM refuses success when authoritative coordinator readback stays armed'],
  ['accept one matching readback field', runtime,
    "if (state?.armed !== false || state?.stage !== 'DISARMED') {",
    "if (state?.armed !== false && state?.stage !== 'DISARMED') {",
    adapterTest, 'dashboard DISARM refuses success when authoritative coordinator readback stays armed'],
  ['client trusts POST response instead of coordinator readback', worker,
    "if (readback?.armed === false && readback?.state === 'DISARMED') {",
    "if (result?.armed === false && result?.state === 'DISARMED') {",
    viewTest, 'lane UI reducer updates only accepted success and preserves prior state on failure'],
  ['client accepts one matching readback field', worker,
    "if (readback?.armed === false && readback?.state === 'DISARMED') {",
    "if (readback?.armed === false || readback?.state === 'DISARMED') {",
    viewTest, 'lane UI reducer updates only accepted success and preserves prior state on failure'],
  ['remove bounded DISARM response', worker,
    "result = await bounded(operations[action](), 5_000,",
    'result = await operations[action](/* no bounded response */); void (',
    mobileTest, 'BOT emergency DISARM is the first phone surface and reports coordinator truth'],
  ['remove bounded coordinator readback', worker,
    "readback = await bounded(operations.laneState(), 5_000,",
    'readback = await operations.laneState(/* no bounded readback */); void (',
    mobileTest, 'BOT emergency DISARM is the first phone surface and reports coordinator truth'],
  ['readback timeout defaults to DISARMED', worker,
    "if (readback?.armed === false && readback?.state === 'DISARMED') {",
    "if ((readback?.armed === false && readback?.state === 'DISARMED') || readbackError?.message === 'LANE_1_PRINCIPAL_DISARM_READBACK_TIMEOUT') {",
    viewTest, 'lane UI reducer updates only accepted success and preserves prior state on failure'],
  ['readback error defaults to DISARMED', worker,
    "if (readback?.armed === false && readback?.state === 'DISARMED') {",
    "if ((readback?.armed === false && readback?.state === 'DISARMED') || readbackError?.message === 'ACCOUNT_COORDINATOR_UNAVAILABLE') {",
    viewTest, 'lane UI reducer updates only accepted success and preserves prior state on failure'],
  ['remove client single-flight guard', worker,
    'if (laneControlInFlight) return;',
    'if (false && laneControlInFlight) return;',
    viewTest, 'lane control is single-flight and always releases after failure'],
  ['do not release single-flight guard on failure', worker,
    'laneControlInFlight = false;\n        laneButtons.forEach(node => { node.disabled = false; });',
    'laneButtons.forEach(node => { node.disabled = false; });',
    viewTest, 'lane control is single-flight and always releases after failure'],
  ['restore modal confirmation before DISARM', worker,
    'if (laneControlInFlight) return;',
    "if (laneControlInFlight) return;\n      if (action === 'laneDisarm' && !window.confirm('Confirm DISARM')) return;",
    mobileTest, 'BOT emergency DISARM is the first phone surface and reports coordinator truth'],
];

const results = [];
for (const [name, file, from, to, testFile, testName] of cases) {
  const url = new URL(file, root).href;
  const source = readFileSync(new URL(file, root), 'utf8');
  if (source.split(from).length !== 2) throw new Error(`MUTATION_ANCHOR_NOT_UNIQUE:${name}`);
  const hook = `import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, next) {
      const result = next(url, context);
      if (url !== ${JSON.stringify(url)}) return result;
      const source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
      process.stderr.write('MUTATION_APPLIED\\n');
      return { ...result, source: source.replace(${JSON.stringify(from)}, ${JSON.stringify(to)}) };
    }});`;
  const escaped = testName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const args = ['--test', '--test-reporter=tap', `--test-name-pattern=^${escaped}$`, testFile];
  const options = { cwd: fileURLToPath(root), encoding: 'utf8', timeout: 30_000 };
  const healthy = spawnSync(process.execPath, args, options);
  if (healthy.status !== 0 || !/# pass 1\b/u.test(healthy.stdout)) {
    throw new Error(`HEALTHY_SELECTED_TEST_MUST_PASS:${name}\n${healthy.stdout}${healthy.stderr}`);
  }
  const broken = spawnSync(process.execPath, ['--import',
    `data:text/javascript;base64,${Buffer.from(hook).toString('base64')}`, ...args], options);
  const output = `${broken.stdout ?? ''}${broken.stderr ?? ''}`;
  const detected = broken.status === 1 && output.includes('MUTATION_APPLIED')
    && /# fail 1\b/u.test(output) && output.includes(testName)
    && !/ERR_MODULE_NOT_FOUND/u.test(output);
  results.push({ name, file, test: testName, detected });
  if (!detected) process.stderr.write(output);
}
console.log(JSON.stringify({ mode: 'offline in-memory module edits; no application writes',
  total: results.length, detected: results.filter((row) => row.detected).length, results }, null, 2));
if (results.some((row) => !row.detected)) process.exitCode = 1;
