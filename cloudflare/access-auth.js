const encoder = new TextEncoder();
let cachedCertificates = null;

function decodeBase64Url(value) {
  const normalized = String(value).replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJson(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

function audienceMatches(audience, required) {
  return (Array.isArray(audience) ? audience : [audience]).includes(required);
}

async function certificates(teamDomain) {
  if (!cachedCertificates) {
    cachedCertificates = fetch(`https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`ACCESS_CERTS_${response.status}`);
        return response.json();
      }).catch((error) => {
        cachedCertificates = null;
        throw error;
      });
  }
  return cachedCertificates;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Validate Cloudflare Access at the Worker boundary; forwarded email headers alone are never trusted. */
export async function authenticateAccess(request, env) {
  if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_OWNER_ID) {
    throw new Error('ACCESS_NOT_CONFIGURED');
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new Error('ACCESS_TOKEN_MISSING');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('ACCESS_TOKEN_MALFORMED');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson(encodedHeader);
  const payload = decodeJson(encodedPayload);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('ACCESS_TOKEN_ALGORITHM_INVALID');
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp <= nowSeconds) throw new Error('ACCESS_TOKEN_EXPIRED');
  if (Number.isFinite(payload.nbf) && payload.nbf > nowSeconds + 30) throw new Error('ACCESS_TOKEN_NOT_YET_VALID');
  if (!audienceMatches(payload.aud, env.ACCESS_AUD)) throw new Error('ACCESS_TOKEN_AUDIENCE_INVALID');
  const certs = await certificates(env.ACCESS_TEAM_DOMAIN);
  const jwk = (certs.keys ?? []).find((candidate) => candidate.kid === header.kid);
  if (!jwk) throw new Error('ACCESS_SIGNING_KEY_UNKNOWN');
  const key = await crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, decodeBase64Url(encodedSignature),
    encoder.encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) throw new Error('ACCESS_TOKEN_SIGNATURE_INVALID');
  const email = String(payload.email ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('ACCESS_IDENTITY_MISSING');
  const id = await sha256Hex(email);
  if (id !== env.ACCESS_OWNER_ID) throw new Error('ACCESS_IDENTITY_NOT_ALLOWED');
  return Object.freeze({ id, email, subject: payload.sub ?? null });
}
