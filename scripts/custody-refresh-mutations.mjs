// Offline, in-memory loader mutations. Never modifies application or test files.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const helper = 'cloudflare/custody-refresh.js';
const platform = 'cloudflare/platform.js';
const worker = 'cloudflare/worker.js';
const testFile = 'test/custody-refresh.test.js';
const policyTest = 'custody refresh skips the broker below 60 seconds and refreshes at the boundary';
const coordinatorTest = 'account coordinator serializes refreshes and rechecks stored age before every broker call';
const failureTest = 'custody refresh distinguishes Schwab throttling from an ordinary read failure';
const viewTest = 'BOT refresh is a genuine single-flight custody read with visible degradation';
const cases = [
  ['remove 60-second debounce', helper, 'export const CUSTODY_REFRESH_DEBOUNCE_MS = 60_000;',
    'export const CUSTODY_REFRESH_DEBOUNCE_MS = 0;', policyTest],
  ['remove coordinator serialization', helper, 'const task = previous.then(operation);',
    'const task = Promise.resolve().then(operation);', coordinatorTest],
  ['skip stored-age recheck inside coordinator', helper, 'if (!policy.refreshRequired) {',
    'if (false && !policy.refreshRequired) {', coordinatorTest],
  ['lose Schwab rate-limit classification', helper,
    "code: rateLimited ? 'SCHWAB_CUSTODY_RATE_LIMITED' : 'SCHWAB_CUSTODY_REFRESH_FAILED',",
    "code: 'SCHWAB_CUSTODY_REFRESH_FAILED',", failureTest],
  ['surface Schwab throttling as a page error', worker,
    "if (error.message === 'SCHWAB_CUSTODY_RATE_LIMITED') {",
    'if (false) {', viewTest],
  ['remove browser single-flight', worker,
    'if (custodyRefreshInFlight) return custodyRefreshInFlight;',
    'if (false && custodyRefreshInFlight) return custodyRefreshInFlight;', viewTest],
  ['remove bounded browser response', worker,
    "}), 20_000, 'SCHWAB_CUSTODY_REFRESH_TIMEOUT');",
    '}));', viewTest],
  ['hide refresh failure', worker,
    "const message = 'CUSTODY REFRESH FAILED — showing stored snapshot. ' + error.message;",
    "const message = 'Stored snapshot';", viewTest],
  ['allow refresh recursion after success', worker,
    'await refresh({ requestCustody: false });', 'await refresh({ requestCustody: true });', viewTest],
  ['remove automatic render-then-refresh', worker,
    'if (requestCustody) window.setTimeout(() => { refreshCustody().catch(() => {}); }, 0);',
    'void requestCustody;', viewTest],
  ['restore always-green connected header', worker,
    "custodyFresh ? 'Shadow connected' : 'Custody stale'", "'Shadow connected'", viewTest],
  ['remove stale metric-card state', worker,
    "card.dataset.custodyState = custodyStale ? 'stale' : 'fresh';",
    "card.dataset.custodyState = 'fresh';", viewTest],
];

const results = [];
for (const [name, file, from, to, testName] of cases) {
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
