import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalResolvedUnitJson,
  emitResolvedUnitBundle,
  RESOLVED_UNIT_BUNDLE_FILES,
} from '../src/economic/emit-resolved-unit-bundle.js';
import { foldResolvedEpisode } from '../src/economic/fold-resolved-unit.js';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIRST_BUNDLE = 'E3_FIRST_UNIT_FIXTURE_BUNDLE';
const CONTINUATION_BUNDLE = 'E3_CC_CONTINUATION_BUNDLE';

function readBundle(name) {
  const directory = join(REPOSITORY_ROOT, 'docs', name);
  return Object.fromEntries(readdirSync(directory)
    .filter((path) => path.endsWith('.json'))
    .map((path) => [path, JSON.parse(readFileSync(join(directory, path), 'utf8'))]));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function emitEpisode(root) {
  const { firstUnit, coveredCallContinuation } = foldResolvedEpisode([
    readBundle(FIRST_BUNDLE),
    readBundle(CONTINUATION_BUNDLE),
  ]);
  const first = emitResolvedUnitBundle(firstUnit, join(root, 'docs', FIRST_BUNDLE));
  const continuation = emitResolvedUnitBundle(
    coveredCallContinuation,
    join(root, 'docs', CONTINUATION_BUNDLE),
    { parentEmission: first },
  );
  return { first, continuation };
}

function hashes(emission) {
  return Object.fromEntries(RESOLVED_UNIT_BUNDLE_FILES.map((path) => [
    path,
    sha256(readFileSync(join(emission.directory, path))),
  ]));
}

function assertManifestMatchesEmittedBytes(emission) {
  const manifest = JSON.parse(readFileSync(join(emission.directory, 'manifest.json'), 'utf8'));
  for (const entry of manifest.orderedFiles) {
    const bytes = readFileSync(join(emission.directory, entry.path));
    assert.equal(entry.byteLength, bytes.byteLength, `${entry.path} byte length`);
    assert.equal(entry.sha256, sha256(bytes), `${entry.path} SHA-256`);
  }
}

test('emitter writes canonical stable bytes and refreshes manifest integrity fields', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'nuvo-e3-emit-stability-'));
  try {
    const firstRun = emitEpisode(join(temporaryRoot, 'first-run'));
    const secondRun = emitEpisode(join(temporaryRoot, 'second-run'));

    assert.deepEqual(hashes(firstRun.first), hashes(secondRun.first));
    assert.deepEqual(hashes(firstRun.continuation), hashes(secondRun.continuation));
    assertManifestMatchesEmittedBytes(firstRun.first);
    assertManifestMatchesEmittedBytes(firstRun.continuation);

    for (const emission of [firstRun.first, firstRun.continuation]) {
      assert.deepEqual(readdirSync(emission.directory).sort(),
        RESOLVED_UNIT_BUNDLE_FILES.slice().sort());
      for (const path of RESOLVED_UNIT_BUNDLE_FILES) {
        const bytes = readFileSync(join(emission.directory, path), 'utf8');
        assert.equal(bytes, canonicalResolvedUnitJson(JSON.parse(bytes)), `${path} canonical bytes`);
        assert.equal(emission.files[path].sha256, sha256(bytes), `${path} returned SHA-256`);
      }
    }

    const emittedParentHashes = firstRun.first.files;
    const continuationManifest = JSON.parse(readFileSync(
      join(firstRun.continuation.directory, 'manifest.json'),
      'utf8',
    ));
    assert.equal(continuationManifest.parentBundleReferences.manifestSha256,
      emittedParentHashes['manifest.json'].sha256);
    assert.equal(continuationManifest.parentBundleReferences.sharesSha256,
      emittedParentHashes['shares.json'].sha256);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('unchanged replay scripts exit zero against emitted temporary bundles', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'nuvo-e3-emit-replay-'));
  try {
    mkdirSync(join(temporaryRoot, 'tools'), { recursive: true });
    for (const script of ['replay-e3-fixture.mjs', 'replay-e3-cc.mjs']) {
      const source = join(REPOSITORY_ROOT, 'tools', script);
      const destination = join(temporaryRoot, 'tools', script);
      copyFileSync(source, destination);
      assert.equal(sha256(readFileSync(destination)), sha256(readFileSync(source)),
        `${script} copied without byte changes`);
    }

    emitEpisode(temporaryRoot);

    const fixture = spawnSync(process.execPath, [
      join(temporaryRoot, 'tools', 'replay-e3-fixture.mjs'),
    ], { cwd: temporaryRoot, encoding: 'utf8' });
    const continuation = spawnSync(process.execPath, [
      join(temporaryRoot, 'tools', 'replay-e3-cc.mjs'),
    ], { cwd: temporaryRoot, encoding: 'utf8' });

    process.stdout.write(`temporary replay-e3-fixture exit=${fixture.status}\n${fixture.stdout}`);
    if (fixture.stderr) process.stdout.write(fixture.stderr);
    process.stdout.write(`temporary replay-e3-cc exit=${continuation.status}\n${continuation.stdout}`);
    if (continuation.stderr) process.stdout.write(continuation.stderr);

    assert.equal(fixture.status, 0, fixture.stderr || fixture.stdout);
    assert.match(fixture.stdout, /E3 fixture replay: PASS/u);
    assert.equal(continuation.status, 0, continuation.stderr || continuation.stdout);
    assert.match(continuation.stdout, /E3 CC continuation replay: PASS/u);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
