// Offline, in-memory mutations. Never modifies application or test files.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const loaderCases = [
  ['reconciler returns early on coordinator FLAT', 'cloudflare/lane-1-runtime.js',
    `  const coordinator = dependencies.coordinator ?? coordinatorV2Adapter(env, ownerId);
  const client = dependencies.client ?? new SchwabD1Client(env);
  let brokerSnapshot;`,
    "  const staleState = await coordinator.status();\n  if (staleState.positionSide === 'FLAT') return { status: 200, body: { disposition: 'trusted-flat' } };\n  const client = dependencies.client ?? new SchwabD1Client(env);\n  let brokerSnapshot;",
    'test/lane-1-post-fill-repair.test.js',
    'broker-ledger reconstruction reads broker first, creates a strict recovered entry, and never qualifies it'],
  ['recovery capture skips encrypted-body readback', 'cloudflare/lane-1-fill-evidence.js',
    `if (readback.size !== encryptedBytes.byteLength || readback.size !== stored.size
    || readback.size !== saved.size || readback.sha256 !== encryptedSha256) {`,
    'if (false) {', 'test/lane-1-fill-evidence.test.js',
    'fill capture verifies encrypted body and manifest by readback before reporting complete'],
  ['MISSING_FEE becomes terminal again', 'src/lane/lane-1-spy-v2.js',
    "if (['FILL_PENDING_EXECUTION', 'FILL_PENDING_FEE'].includes(error?.message)) {",
    "if (['FILL_PENDING_EXECUTION'].includes(error?.message)) {",
    'test/lane-1-spy-v2.test.js',
    'MISSING_FEE is durable FILL_PENDING_FEE and never a terminal fault'],
  ['fill economics poll becomes unbounded', 'src/lane/lane-1-fill-contract.js',
    'return Math.min(deadlineMs, startedMs + (nextOffset ?? 120_000));',
    'return startedMs + (nextOffset ?? 600_000);',
    'test/lane-1-fill-contract.test.js',
    'fill economics polling uses the exact bounded 120-second schedule'],
  ['broker position mismatch renders as agreement', 'src/lane/lane-1-position-projection.js',
    'if (coordinator.positionSide !== broker.positionSide || coordinatorUnknown) {',
    'if (false && (coordinator.positionSide !== broker.positionSide || coordinatorUnknown)) {',
    'test/lane-1-position-projection.test.js',
    'broker SHORT against coordinator FLAT is prominent POSITION_DRIFT with both timestamps'],
  ['order response classified before capture', 'cloudflare/schwab-client.js',
    '    const acceptanceCapture = await captureLane1FillResponse({ bucket: this.env.EVIDENCE,',
    "    if (!response.ok) throw new Error(`SCHWAB_LANE_MARKET_ORDER_${instruction}_${response.status}`);\n    const acceptanceCapture = await captureLane1FillResponse({ bucket: this.env.EVIDENCE,",
    'test/lane-1-production-adapters.test.js',
    'failed Schwab order response is captured before transport classification'],
];
const coordinatorCases = [
  ['ARM clears recovered position', 'ARM_CLEARS_POSITION',
    'arm-existing preserves recovered SHORT and the coordinator admits only BUY_TO_COVER'],
  ['differing recovery identity accepted as no-op', 'DIFFERING_RECOVERY_IDENTITY_IS_NOOP',
    'strict recovery is atomic, idempotent, and a differing identity faults'],
  ['ARM-existing permits SELL instead of BUY_TO_COVER', 'ARM_EXISTING_PERMITS_WRONG_EXIT',
    'arm-existing preserves recovered SHORT and the coordinator admits only BUY_TO_COVER'],
];

function selectedArgs(testFile, testName) {
  const escaped = testName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return ['--test', '--test-reporter=tap', `--test-name-pattern=^${escaped}$`, testFile];
}
function healthy(testFile, testName) {
  return spawnSync(process.execPath, selectedArgs(testFile, testName), {
    cwd: fileURLToPath(root), encoding: 'utf8', timeout: 60_000,
  });
}

const results = [];
for (const [name, file, from, to, testFile, testName] of loaderCases) {
  const target = new URL(file, root);
  const targetHref = target.href;
  const source = readFileSync(target, 'utf8');
  if (source.split(from).length !== 2) throw new Error(`MUTATION_ANCHOR_NOT_UNIQUE:${name}`);
  const baseline = healthy(testFile, testName);
  if (baseline.status !== 0 || !/# pass 1\b/u.test(baseline.stdout)) {
    throw new Error(`HEALTHY_SELECTED_TEST_MUST_PASS:${name}\n${baseline.stdout}${baseline.stderr}`);
  }
  const hook = `import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, next) {
      const result = next(url, context);
      if (url !== ${JSON.stringify(targetHref)}) return result;
      const source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
      process.stderr.write('MUTATION_APPLIED\\n');
      return { ...result, source: source.replace(${JSON.stringify(from)}, ${JSON.stringify(to)}) };
    }});`;
  const broken = spawnSync(process.execPath, ['--import',
    `data:text/javascript;base64,${Buffer.from(hook).toString('base64')}`,
  ...selectedArgs(testFile, testName)], {
    cwd: fileURLToPath(root), encoding: 'utf8', timeout: 60_000,
  });
  const output = `${broken.stdout ?? ''}${broken.stderr ?? ''}`;
  const detected = broken.status === 1 && output.includes('MUTATION_APPLIED')
    && /# fail 1\b/u.test(output) && output.includes(testName);
  results.push({ name, file, test: testName, detected });
  if (!detected) process.stderr.write(output);
}

for (const [name, mutation, testName] of coordinatorCases) {
  const testFile = 'test/lane-1-coordinator-repair.test.js';
  const baseline = healthy(testFile, testName);
  if (baseline.status !== 0 || !/# pass 1\b/u.test(baseline.stdout)) {
    throw new Error(`HEALTHY_SELECTED_TEST_MUST_PASS:${name}\n${baseline.stdout}${baseline.stderr}`);
  }
  const broken = spawnSync(process.execPath, selectedArgs(testFile, testName), {
    cwd: fileURLToPath(root), encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, LANE1_COORDINATOR_MUTATION: mutation },
  });
  const output = `${broken.stdout ?? ''}${broken.stderr ?? ''}`;
  const detected = broken.status === 1 && output.includes('COORDINATOR_MUTATION_APPLIED')
    && /# fail 1\b/u.test(output) && output.includes(testName);
  results.push({ name, file: 'cloudflare/platform.js', test: testName, detected });
  if (!detected) process.stderr.write(output);
}

console.log(JSON.stringify({ mode: 'offline in-memory mutations; no application writes',
  total: results.length, detected: results.filter((row) => row.detected).length, results }, null, 2));
if (results.some((row) => !row.detected)) process.exitCode = 1;
