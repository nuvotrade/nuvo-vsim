import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DATA_FILES = Object.freeze([
  'decision.json',
  'proposal.json',
  'order-events.json',
  'fills.json',
  'cash.json',
  'shares.json',
  'pnl.json',
]);

const BUNDLE_FILES = Object.freeze(['manifest.json', ...DATA_FILES]);

function invariant(condition, message) {
  if (!condition) throw new Error(`RESOLVED_UNIT_EMIT:${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalValue(value, path = '$', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    invariant(Number.isFinite(value), `${path}:FINITE_NUMBER_REQUIRED`);
    return value;
  }

  invariant(typeof value === 'object', `${path}:JSON_VALUE_REQUIRED`);
  invariant(!ancestors.has(value), `${path}:CYCLIC_VALUE_FORBIDDEN`);
  ancestors.add(value);

  let result;
  if (Array.isArray(value)) {
    result = value.map((entry, index) => canonicalValue(entry, `${path}[${index}]`, ancestors));
  } else {
    const prototype = Object.getPrototypeOf(value);
    invariant(prototype === Object.prototype || prototype === null, `${path}:PLAIN_OBJECT_REQUIRED`);
    result = Object.fromEntries(Object.keys(value).sort().map((key) => {
      invariant(value[key] !== undefined, `${path}.${key}:DEFINED_VALUE_REQUIRED`);
      return [key, canonicalValue(value[key], `${path}.${key}`, ancestors)];
    }));
  }

  ancestors.delete(value);
  return result;
}

export function canonicalResolvedUnitJson(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function fileRecord(path, bytes) {
  return Object.freeze({
    path,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  });
}

function exactBundleFileSet(bundle) {
  return JSON.stringify(Object.keys(bundle).sort()) === JSON.stringify(BUNDLE_FILES.slice().sort());
}

function refreshOrderedFiles(manifest, records) {
  invariant(Array.isArray(manifest.orderedFiles), 'manifest.json:ORDERED_FILES_REQUIRED');
  invariant(manifest.orderedFiles.length === DATA_FILES.length,
    'manifest.json:ORDERED_FILES_COUNT_INVALID');

  const entriesByPath = new Map(manifest.orderedFiles.map((entry) => [entry.path, entry]));
  invariant(entriesByPath.size === DATA_FILES.length,
    'manifest.json:ORDERED_FILES_DUPLICATE_PATH');
  invariant(DATA_FILES.every((path) => entriesByPath.has(path)),
    'manifest.json:ORDERED_FILES_PATH_MISMATCH');

  manifest.orderedFiles = manifest.orderedFiles.map((entry) => ({
    ...entry,
    byteLength: records[entry.path].byteLength,
    sha256: records[entry.path].sha256,
  }));
}

function refreshParentReferences(manifest, parentEmission) {
  if (!Object.hasOwn(manifest, 'parentBundleReferences')) return;
  invariant(parentEmission && parentEmission.files,
    'manifest.json:PARENT_EMISSION_REQUIRED');
  invariant(parentEmission.files['manifest.json'] && parentEmission.files['shares.json'],
    'manifest.json:PARENT_EMISSION_HASHES_REQUIRED');

  manifest.parentBundleReferences = {
    ...manifest.parentBundleReferences,
    manifestSha256: parentEmission.files['manifest.json'].sha256,
    sharesSha256: parentEmission.files['shares.json'].sha256,
  };
}

export function emitResolvedUnitBundle(foldOutput, targetDirectory, { parentEmission = null } = {}) {
  invariant(foldOutput && typeof foldOutput === 'object' && !Array.isArray(foldOutput),
    'FOLD_OUTPUT_OBJECT_REQUIRED');
  invariant(exactBundleFileSet(foldOutput), 'EXACT_BUNDLE_FILE_SET_REQUIRED');
  invariant(typeof targetDirectory === 'string' && targetDirectory.length > 0,
    'TARGET_DIRECTORY_REQUIRED');

  const outputDirectory = resolve(targetDirectory);
  mkdirSync(outputDirectory, { recursive: true });
  invariant(readdirSync(outputDirectory).length === 0, 'TARGET_DIRECTORY_MUST_BE_EMPTY');

  const records = {};
  const bytesByPath = {};
  for (const path of DATA_FILES) {
    const bytes = Buffer.from(canonicalResolvedUnitJson(foldOutput[path]), 'utf8');
    bytesByPath[path] = bytes;
    records[path] = fileRecord(path, bytes);
  }

  const manifest = canonicalValue(foldOutput['manifest.json'], '$[manifest.json]');
  refreshOrderedFiles(manifest, records);
  refreshParentReferences(manifest, parentEmission);
  const manifestBytes = Buffer.from(canonicalResolvedUnitJson(manifest), 'utf8');
  bytesByPath['manifest.json'] = manifestBytes;
  records['manifest.json'] = fileRecord('manifest.json', manifestBytes);

  for (const path of BUNDLE_FILES) {
    writeFileSync(join(outputDirectory, path), bytesByPath[path], { flag: 'wx' });
  }

  return Object.freeze({
    directory: outputDirectory,
    files: Object.freeze(Object.fromEntries(
      BUNDLE_FILES.map((path) => [path, records[path]]),
    )),
  });
}

export const RESOLVED_UNIT_BUNDLE_FILES = BUNDLE_FILES;
