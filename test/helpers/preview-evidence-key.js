import { decryptPreviewOriginal } from '../../cloudflare/preview-evidence-codec.js';
const pair = await crypto.subtle.generateKey({name:'RSA-OAEP', hash:'SHA-256',
  modulusLength:2048, publicExponent:new Uint8Array([1,0,1])}, true, ['encrypt','decrypt']);
export const testPublicKey = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
export const testPrivateKey = pair.privateKey;
export async function decryptStored(bucket, key) {
  const envelope = JSON.parse(Buffer.from(bucket.objects.get(key).bytes));
  return decryptPreviewOriginal(envelope, pair.privateKey);
}
