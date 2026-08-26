import test from 'node:test';
import assert from 'node:assert/strict';
import gateway from '../cloudflare/telegram-gateway.js';

const secret = 'test-webhook-secret';

function envWith(handler) {
  return {
    TELEGRAM_WEBHOOK_SECRET: secret,
    VSIM: { fetch: handler },
  };
}

test('Telegram gateway exposes only the POST webhook path', async () => {
  const env = envWith(() => { throw new Error('must not forward'); });
  const wrongPath = await gateway.fetch(new Request('https://gateway.example/status'), env);
  const wrongMethod = await gateway.fetch(new Request('https://gateway.example/api/integrations/telegram/webhook'), env);
  assert.equal(wrongPath.status, 404);
  assert.equal(wrongMethod.status, 404);
});

test('Telegram gateway rejects a missing or incorrect Telegram secret', async () => {
  const env = envWith(() => { throw new Error('must not forward'); });
  const request = new Request('https://gateway.example/api/integrations/telegram/webhook', {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
    body: '{}',
  });
  const response = await gateway.fetch(request, env);
  assert.equal(response.status, 401);
});

test('Telegram gateway forwards a signed update over the private service binding', async () => {
  let forwarded;
  const env = envWith(async (request) => {
    forwarded = request;
    return new Response(null, { status: 204 });
  });
  const request = new Request('https://gateway.example/api/integrations/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': secret,
      cookie: 'must-not-forward=1',
    },
    body: '{"update_id":1}',
  });
  const response = await gateway.fetch(request, env);
  assert.equal(response.status, 204);
  assert.equal(new URL(forwarded.url).pathname, '/api/integrations/telegram/webhook');
  assert.equal(forwarded.headers.get('x-nuvo-telegram-gateway'), 'signed-webhook');
  assert.equal(forwarded.headers.get('cookie'), null);
  assert.equal(await forwarded.text(), '{"update_id":1}');
});

