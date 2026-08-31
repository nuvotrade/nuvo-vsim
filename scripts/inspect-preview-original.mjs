// Offline only. Never writes decrypted broker bytes or private key material.
import { readFile, stat } from 'node:fs/promises';
import { createPrivateKey } from 'node:crypto';
import { decryptPreviewOriginal, bytesHash } from '../cloudflare/preview-evidence-codec.js';

export async function readPreviewOriginal(envelopePath, privateKeyPath) {
  if (((await stat(privateKeyPath)).mode & 0o077) !== 0) throw new Error('PRIVATE_KEY_PERMISSIONS');
  const envelope = JSON.parse(await readFile(envelopePath, 'utf8'));
  const der = createPrivateKey(await readFile(privateKeyPath)).export({type:'pkcs8',format:'der'});
  const key = await crypto.subtle.importKey('pkcs8', der,
    {name:'RSA-OAEP',hash:'SHA-256'}, false, ['decrypt']);
  const bytes = await decryptPreviewOriginal(envelope, key);
  const raw = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(bytes);
  return { bytes, raw, body:JSON.parse(raw), originalSha256:bytesHash(bytes), envelope };
}

export function typedShape(value) {
  if (value === null) return {type:'null'};
  if (Array.isArray(value)) return {type:'array',length:value.length,items:value.map(typedShape)};
  if (typeof value === 'object') return {type:'object',fields:Object.fromEntries(
    Object.entries(value).map(([key,child]) => [key,typedShape(child)]))};
  return {type:typeof value};
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [envelopePath,privateKeyPath] = process.argv.slice(2);
  if (!envelopePath || !privateKeyPath) throw new Error('Usage: node scripts/inspect-preview-original.mjs ENVELOPE PRIVATE_KEY');
  const {body,raw,originalSha256} = await readPreviewOriginal(envelopePath,privateKeyPath);
  const firstLegPath = body.orderStrategy?.orderLegs?.[0] !== undefined
    ? 'orderStrategy.orderLegs[0]' : body.orderLegs?.[0] !== undefined ? 'orderLegs[0]' : null;
  const firstLeg = firstLegPath === 'orderStrategy.orderLegs[0]' ? body.orderStrategy.orderLegs[0]
    : firstLegPath === 'orderLegs[0]' ? body.orderLegs[0] : null;
  console.log(JSON.stringify({originalSha256,rootKeys:Object.keys(body),
    orderStrategyKeys:Object.keys(body.orderStrategy??{}),firstLegPath,
    firstLegKeys:Object.keys(firstLeg??{}),firstLegTypes:typedShape(firstLeg),
    originalFirstLineCharacters:raw.split(/\r?\n/u)[0].length,
    rootTypes:typedShape(body)},null,2));
}
