// Offline, in-memory mutations. Never modifies application or test files.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const cases = [
  {
    name: 'OPEN_SHORT routed to flat-only arm', file: 'cloudflare/lane-1-runtime.js',
    replacements: [
      ["  if (['OPEN_SHORT', 'OPEN_LONG'].includes(liveState?.stage)) {",
        "  if (false && ['OPEN_SHORT', 'OPEN_LONG'].includes(liveState?.stage)) {"],
      ["  if (!['FLAT', 'DISARMED'].includes(liveState?.stage)\n    || liveState?.positionSide !== 'FLAT') {",
        "  if (false && (!['FLAT', 'DISARMED'].includes(liveState?.stage)\n    || liveState?.positionSide !== 'FLAT')) {"],
    ], testFile: 'test/lane-1-production-adapters.test.js',
    testName: 'dashboard ARM reads live OPEN_SHORT and routes only to guarded arm-existing',
  },
  {
    name: 'FLAT routed to arm-existing', file: 'cloudflare/lane-1-runtime.js',
    replacements: [["    const state = await coordinator.principalArm({",
      "    const state = await coordinator.principalArmExisting({"]],
    testFile: 'test/lane-1-production-adapters.test.js',
    testName: 'dashboard ARM reads live FLAT coordinator state and selects flat-only arm',
  },
  {
    name: 'pending-fill precondition skipped', file: 'cloudflare/lane-1-runtime.js',
    replacements: [["  if (liveState?.pendingFill || ['FILL_PENDING_EXECUTION', 'FILL_PENDING_FEE']\n    .includes(liveState?.stage)) {",
      "  if (false && (liveState?.pendingFill || ['FILL_PENDING_EXECUTION', 'FILL_PENDING_FEE']\n    .includes(liveState?.stage))) {"]],
    testFile: 'test/lane-1-production-adapters.test.js',
    testName: 'dashboard ARM names FAULT and pending-fill refusals before either transition',
  },
  {
    name: 'stage read from cache instead of live coordinator', file: 'cloudflare/lane-1-runtime.js',
    replacements: [["  try { liveState = await coordinator.status(); }",
      "  try { liveState = dependencies.cachedState; }"]],
    testFile: 'test/lane-1-production-adapters.test.js',
    testName: 'dashboard ARM reads live OPEN_SHORT and routes only to guarded arm-existing',
  },
  {
    name: 'failed ingress reports green', file: 'cloudflare/system-health.js',
    replacements: [["  const tvColor = tvBroken ? 'RED' : ingressProven ? 'GREEN' : 'AMBER';",
      "  const tvColor = tvBroken ? 'GREEN' : ingressProven ? 'GREEN' : 'AMBER';"]],
    testFile: 'test/system-health.test.js',
    testName: 'explicit failed authenticated ingress is red and can never report healthy',
  },
  {
    name: 'UNPROVEN rendered green', file: 'cloudflare/system-health.js',
    replacements: [["  const tvColor = tvBroken ? 'RED' : ingressProven ? 'GREEN' : 'AMBER';",
      "  const tvColor = tvBroken ? 'RED' : ingressProven ? 'GREEN' : 'GREEN';"]],
    testFile: 'test/system-health.test.js',
    testName: 'TV health is UNPROVEN on a new Worker and silence never becomes broken',
  },
  {
    name: 'silence rendered broken', file: 'cloudflare/system-health.js',
    replacements: [["  const tvBroken = ingressBroken || (ingressProven && marketOpen && !tvTapeFresh);",
      "  const tvBroken = !ingressProven || ingressBroken || (ingressProven && marketOpen && !tvTapeFresh);"]],
    testFile: 'test/system-health.test.js',
    testName: 'TV health is UNPROVEN on a new Worker and silence never becomes broken',
  },
  {
    name: 'STALE inferred without independent evidence', file: 'cloudflare/system-health.js',
    replacements: [["'UNPROVEN · NO ACCEPTED SIGNAL ON THIS VERSION · SILENCE IS NOT A FAULT'",
      "'STALE · EXPECTED_SIGNAL_MISSING'"]],
    testFile: 'test/system-health.test.js',
    testName: 'TV health is UNPROVEN on a new Worker and silence never becomes broken',
  },
];

function selectedArgs(testFile, testName) {
  const escaped = testName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return ['--test', '--test-reporter=tap', `--test-name-pattern=^${escaped}$`, testFile];
}

function run(args, env = process.env) {
  return spawnSync(process.execPath, args, { cwd: fileURLToPath(root), encoding: 'utf8',
    timeout: 60_000, env });
}

const results = [];
for (const item of cases) {
  const target = new URL(item.file, root);
  const source = readFileSync(target, 'utf8');
  for (const [from] of item.replacements) {
    if (source.split(from).length !== 2) throw new Error(`MUTATION_ANCHOR_NOT_UNIQUE:${item.name}`);
  }
  const args = selectedArgs(item.testFile, item.testName);
  const baseline = run(args);
  if (baseline.status !== 0 || !/# pass 1\b/u.test(baseline.stdout)) {
    throw new Error(`HEALTHY_SELECTED_TEST_MUST_PASS:${item.name}\n${baseline.stdout}${baseline.stderr}`);
  }
  const hook = `import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, next) {
      const result = next(url, context);
      if (url !== ${JSON.stringify(target.href)}) return result;
      let source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
      for (const replacement of ${JSON.stringify(item.replacements)}) source = source.replace(replacement[0], replacement[1]);
      process.stderr.write('MUTATION_APPLIED\\n');
      return { ...result, source };
    }});`;
  const broken = run(['--import',
    `data:text/javascript;base64,${Buffer.from(hook).toString('base64')}`, ...args]);
  const output = `${broken.stdout ?? ''}${broken.stderr ?? ''}`;
  const detected = broken.status === 1 && output.includes('MUTATION_APPLIED')
    && /# fail 1\b/u.test(output) && output.includes(item.testName);
  results.push({ name: item.name, file: item.file, test: item.testName, detected });
  if (!detected) process.stderr.write(output);
}

const coordinatorTest = 'arm-existing preserves recovered SHORT and the coordinator admits only BUY_TO_COVER';
const coordinatorArgs = selectedArgs('test/lane-1-coordinator-repair.test.js', coordinatorTest);
const coordinatorBaseline = run(coordinatorArgs);
if (coordinatorBaseline.status !== 0 || !/# pass 1\b/u.test(coordinatorBaseline.stdout)) {
  throw new Error(`HEALTHY_SELECTED_TEST_MUST_PASS:arm-existing instruction guard\n${coordinatorBaseline.stdout}${coordinatorBaseline.stderr}`);
}
const coordinatorBroken = run(coordinatorArgs,
  { ...process.env, LANE1_COORDINATOR_MUTATION: 'ARM_EXISTING_PERMITS_WRONG_EXIT' });
const coordinatorOutput = `${coordinatorBroken.stdout ?? ''}${coordinatorBroken.stderr ?? ''}`;
const coordinatorDetected = coordinatorBroken.status === 1
  && coordinatorOutput.includes('COORDINATOR_MUTATION_APPLIED')
  && /# fail 1\b/u.test(coordinatorOutput) && coordinatorOutput.includes(coordinatorTest);
results.push({ name: 'arm-existing permits BUY or SELL_SHORT', file: 'cloudflare/platform.js',
  test: coordinatorTest, detected: coordinatorDetected });
if (!coordinatorDetected) process.stderr.write(coordinatorOutput);

console.log(JSON.stringify({ mode: 'offline in-memory mutations; no application writes',
  total: results.length, detected: results.filter((row) => row.detected).length, results }, null, 2));
if (results.some((row) => !row.detected)) process.exitCode = 1;
