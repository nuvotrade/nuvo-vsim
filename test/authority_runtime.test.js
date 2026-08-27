import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { systemFault } from '../cloudflare/worker.js';
import { AuthorityConfigurationError } from '../src/constitution/authority.js';

async function faultFor(authority) {
  const env = {};
  if (authority !== Symbol.for('missing')) env.NUVO_AUTHORITY_LEVEL = authority;
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await worker.fetch(new Request('https://vsim.nuvotrade.co/'), env, {});
    return { response, body: await response.json() };
  } finally {
    console.error = originalError;
  }
}

test('missing authority configuration is a distinct system fault and never serves the dashboard', async () => {
  const { response, body } = await faultFor(Symbol.for('missing'));
  assert.equal(response.status, 503);
  assert.equal(body.outcome, 'SYSTEM_FAULT');
  assert.equal(body.decision, null);
  assert.equal(body.faultCode, 'AUTHORITY_CONFIG_MISSING');
  assert.equal(body.faultStage, 'AUTHORITY_BOUNDARY');
  assert.ok(!Object.hasOwn(body, 'authority_level'), 'a fault must not serialize authority as null');
});

test('malformed authority configuration is an invalid fault, not a Shadow fallback', async () => {
  const { response, body } = await faultFor('not-an-authority');
  assert.equal(response.status, 503);
  assert.equal(body.outcome, 'SYSTEM_FAULT');
  assert.equal(body.decision, null);
  assert.equal(body.faultCode, 'AUTHORITY_CONFIG_INVALID');
  assert.ok(!Object.hasOwn(body, 'authority_level'));
});

test('a guard receiving an unvalidated value surfaces as SYSTEM_FAULT, never denial', () => {
  const body = systemFault(new AuthorityConfigurationError(
    'AUTHORITY_VALUE_UNVALIDATED', 'A behavioral gate received a plain number.',
  ));
  assert.equal(body.outcome, 'SYSTEM_FAULT');
  assert.equal(body.decision, null);
  assert.equal(body.faultCode, 'AUTHORITY_VALUE_UNVALIDATED');
  assert.notEqual(body.outcome, 'AUTHORITY_DENIED');
});

test('the scheduler stops before touching storage when authority is missing', async () => {
  let touchedDatabase = false;
  let scheduled;
  const env = Object.defineProperty({}, 'DB', {
    get() { touchedDatabase = true; throw new Error('DB must not be touched'); },
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    worker.scheduled({ scheduledTime: Date.now() }, env, {
      waitUntil(promise) { scheduled = promise; },
    });
    await scheduled;
  } finally {
    console.error = originalError;
  }
  assert.equal(touchedDatabase, false);
});
