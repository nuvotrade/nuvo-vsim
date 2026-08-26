const WEBHOOK_PATH = '/api/integrations/telegram/webhook';
const MAX_BODY_BYTES = 1024 * 1024;

async function safeEqual(left, right) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(left || ''))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(right || ''))),
  ]);
  const leftDigest = new Uint8Array(a);
  const rightDigest = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < leftDigest.length; i += 1) {
    difference |= leftDigest[i] ^ rightDigest[i];
  }
  return difference === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== WEBHOOK_PATH) {
      return new Response('Not found', { status: 404 });
    }

    const expected = env.TELEGRAM_WEBHOOK_SECRET;
    const supplied = request.headers.get('x-telegram-bot-api-secret-token');
    if (!expected || !await safeEqual(supplied, expected)) {
      return new Response('Unauthorized', { status: 401 });
    }

    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return new Response('Payload too large', { status: 413 });
    }
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) {
      return new Response('Payload too large', { status: 413 });
    }

    const upstreamUrl = new URL(WEBHOOK_PATH, 'https://nuvo-vsim-v5-shadow.internal');
    const headers = new Headers(request.headers);
    headers.delete('cf-access-jwt-assertion');
    headers.delete('cookie');
    headers.set('x-nuvo-telegram-gateway', 'signed-webhook');

    return env.VSIM.fetch(new Request(upstreamUrl, {
      method: 'POST',
      headers,
      body,
    }));
  },
};
