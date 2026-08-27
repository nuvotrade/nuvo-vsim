import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const assets = [
  ['BUNDLED_DESIGN_HTML', new URL('../cloudflare/design/index.html', import.meta.url)],
  ['BUNDLED_DESIGN_STYLES', new URL('../cloudflare/design/styles.css', import.meta.url)],
  ['BUNDLED_DESIGN_APP', new URL('../cloudflare/design/app.js', import.meta.url)],
];

const lines = [
  '// Generated from the byte-verified files in cloudflare/design/.',
  '// Run `npm run build:design-assets` after intentionally changing those source files.',
  '',
];

const hashes = {};
for (const [name, source] of assets) {
  const bytes = await readFile(source);
  hashes[name] = createHash('sha256').update(bytes).digest('hex');
  lines.push(`export const ${name} = ${JSON.stringify(bytes.toString('utf8'))};`);
}

lines.push(`export const BUNDLED_DESIGN_SHA256 = Object.freeze(${JSON.stringify(hashes)});`);
lines.push('');
await writeFile(new URL('../cloudflare/design-assets.js', import.meta.url), lines.join('\n'));
