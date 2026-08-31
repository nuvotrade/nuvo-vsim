// Offline, in-memory loader mutations. Never modifies application/test files.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const lane = 'src/lane/lane-1-spy-v2.js';
const runtime = 'cloudflare/lane-1-runtime.js';
const laneTest = 'test/lane-1-spy-v2.test.js';
const ingressTest = 'test/lane-1-ingress-preview.test.js';
const header = 'export function normalizeLane1V21Signal(side) {';
const rawInstruction = 'const brokerInstruction = rawSignalSide;';
const diagnosticTest = 'four-action ingress: raw lowercase buy is distinguishable from accepted BUY';
const sealTest = 'four-action: seal preserves every exact instruction independently of position';
const cases = [
  ['restore SELL/EXIT alias', lane, [["if (side === 'SELL') return { signal: 'EXIT', exitScope: 'LONG' };",
    "if (side === 'EXIT' || side === 'SELL') return { signal: 'EXIT', exitScope: 'ANY' };"]],
  laneTest, 'TV vocabulary is exactly four broker instructions with explicit exit intent'],
  ['accept LONG alias', lane, [["if (side === 'BUY')", "if (side === 'BUY' || side === 'LONG')"]],
  laneTest, 'four-action: legacy LONG refuses before state access'],
  ['accept SHORT alias', lane, [["if (side === 'SELL_SHORT')", "if (side === 'SELL_SHORT' || side === 'SHORT')"]],
  laneTest, 'four-action: legacy SHORT refuses before state access'],
  ['accept COVER alias', lane, [["if (side === 'BUY_TO_COVER')", "if (side === 'BUY_TO_COVER' || side === 'COVER')"]],
  laneTest, 'four-action: legacy COVER refuses before state access'],
  ['case insensitive matching', lane, [[header, `${header}\n  if (typeof side === 'string') side = side.toUpperCase();`]],
  laneTest, 'four-action: case folding trimming and coercion are forbidden'],
  ['trimming matching', lane, [[header, `${header}\n  if (typeof side === 'string') side = side.trim();`]],
  laneTest, 'four-action: case folding trimming and coercion are forbidden'],
  ['string coercion matching', lane, [[header, `${header}\n  side = String(side);`]],
  laneTest, 'four-action: case folding trimming and coercion are forbidden'],
  ['SELL while SHORT constructs cover', lane, [[rawInstruction,
    "const brokerInstruction = rawSignalSide === 'SELL' && positionSide === 'SHORT' ? 'BUY_TO_COVER' : rawSignalSide;"]],
  laneTest, sealTest],
  ['restore position-based builder interpretation', lane, [[rawInstruction,
    "const brokerInstruction = signal === 'LONG' ? 'BUY' : signal === 'SHORT' ? 'SELL_SHORT' : positionSide === 'LONG' ? 'SELL' : 'BUY_TO_COVER';"]],
  laneTest, sealTest],
  ['reinterpret SELL through both state check and builder', lane, [
    ['custody = custodyDisposition(state, expectedSnapshot, body.side);',
      "custody = custodyDisposition(state, expectedSnapshot, body.side === 'SELL' && state.positionSide === 'SHORT' ? 'BUY_TO_COVER' : body.side);"],
    [rawInstruction, "const brokerInstruction = rawSignalSide === 'SELL' && positionSide === 'SHORT' ? 'BUY_TO_COVER' : rawSignalSide;"]],
  laneTest, 'four-action: SELL while SHORT refuses and never constructs a cover dispatch'],
  ['skip signal/instruction agreement', lane,
    [["if (signal !== normalized.signal) throw new Error('LANE_1_INSTRUCTION_BINDING_MISMATCH');", '']],
  laneTest, 'four-action: seal refuses missing aliases and contradictory normalized direction'],
  ['normalize raw side in stored message', runtime, [['rawMessage[key] = value;',
    "rawMessage[key] = key === 'side' && typeof value === 'string' ? value.trim().toUpperCase() : value;"]],
  ingressTest, diagnosticTest],
  ['normalize display side again', runtime, [["side: typeof body?.side === 'string' ? body.side : null,",
    "side: String(body?.side ?? '').trim().toUpperCase() || null,"]], ingressTest, diagnosticTest],
  ['backfill rejected acceptedInstruction from raw', runtime, [['acceptedInstruction: binding?.replayBody.side ?? null,',
    'acceptedInstruction: binding?.replayBody.side ?? body?.side ?? null,']], ingressTest, diagnosticTest],
  ['omit rejection receipt', runtime, [["if (authenticated && result.status === 400 && ingressDiagnostic) {",
    'if (false) {']], ingressTest, diagnosticTest],
];

const results = [];
for (const [name, file, edits, testFile, testName] of cases) {
  const url = new URL(file, root).href;
  const source = readFileSync(new URL(file, root), 'utf8');
  for (const [from] of edits) {
    if (source.split(from).length !== 2) throw new Error(`MUTATION_ANCHOR_NOT_UNIQUE:${name}`);
  }
  const hook = `import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, next) {
      const result = next(url, context);
      if (url !== ${JSON.stringify(url)}) return result;
      let source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
      for (const [from, to] of ${JSON.stringify(edits)}) source = source.replace(from, to);
      process.stderr.write('MUTATION_APPLIED\\n');
      return { ...result, source };
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
    && /# fail 1\b/u.test(output) && output.includes('ERR_ASSERTION')
    && output.includes(testName) && !/SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND/u.test(output);
  results.push({ name, file, test: testName, healthy: 'PASS', detected });
  if (!detected) process.stderr.write(output);
}
console.log(JSON.stringify({ mode: 'offline in-memory module edits; no application writes',
  total: results.length, detected: results.filter((row) => row.detected).length, results }, null, 2));
if (results.some((row) => !row.detected)) process.exitCode = 1;
