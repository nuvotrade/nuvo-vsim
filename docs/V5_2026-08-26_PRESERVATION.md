# NUVO VSIM V5 preservation record — 2026-08-26

## Identity

- Authoritative source directory: `/Users/nuvo/Documents/Codex/2026-08-23/referenced-chatgpt-conversation-this-is-an-2/work/claude-review.8xjXJ5`
- Git remote: `https://github.com/nuvotrade/nuvo-vsim`
- Branch: `claude/nuvo-vsim-architecture-il96te`
- Consolidated code commit: `8abbbf4d16d3f6e918531c0ffd0db61c3ca215d5`
- Preservation tag: `v5-2026-08-26-consolidated`
- Live Worker: `nuvo-vsim-v5-shadow`
- Live Worker version: `0139fd54-8237-40ae-8ae9-e27261b936b1` (version 122)
- Live version creation: `2026-08-27T04:25:58.688528Z`
- Bundled `entry.js` size: `1,726,407` bytes
- Bundled `entry.js` SHA-256: `170547277e33ca1fab967a57c8b16dfe06ae3bc6d9b2dd7dc57b33764be0ab80`
- Cloudflare script ETag: `51be1acf90ce826fc44de168c0acfa0da3b54811a4afe0b5f42a07969a2ddd62`

The directory name originated as an isolated review workspace, but it is a normal Git checkout with a tracked remote branch. It is the authoritative source for this release because the local build from the consolidated code commit is byte-for-byte identical to the code downloaded from the live Worker version. The older checkout that was roughly 240 KB smaller is not authoritative.

As of this preservation point, `vsim.nuvotrade.co` still resolves to the older `nuvo-command.pages.dev` Pages deployment, not to `nuvo-vsim-v5-shadow`. The hostname migration audit is pending. Do not infer that the custom domain serves this tagged release.

## Repeatable production comparison

Run from the source directory. This is read-only against Cloudflare except for local output files.

```bash
npx wrangler deploy --dry-run --config cloudflare/wrangler.jsonc \
  --outfile "$CHECKPOINT/cloudflare/local-worker-bundle.js"

# `--outfile` is a multipart upload body. Extract its entry.js part and extract
# entry.js from GET /accounts/{account}/workers/scripts/nuvo-vsim-v5-shadow.
# Then compare the two extracted modules:
shasum -a 256 "$CHECKPOINT/cloudflare/local-worker-entry.js" \
  "$CHECKPOINT/cloudflare/deployed-worker.multipart.entry.js"
cmp "$CHECKPOINT/cloudflare/local-worker-entry.js" \
  "$CHECKPOINT/cloudflare/deployed-worker.multipart.entry.js"
```

Expected: both hashes equal `170547277e33ca1fab967a57c8b16dfe06ae3bc6d9b2dd7dc57b33764be0ab80`, and `cmp` exits 0. The checkpoint also contains the downloaded multipart response, extracted deployed module, local multipart build, extracted local module, version metadata, and Wrangler build metadata.

## Data backup

Backup directory:

`/Users/nuvo/Documents/Codex/2026-08-23/vsim-v5-checkpoints/2026-08-26-consolidated-precommit`

Verification file:

`/Users/nuvo/Documents/Codex/2026-08-23/vsim-v5-checkpoints/2026-08-26-consolidated-precommit/CLOUDFLARE_SHA256SUMS.txt`

The directory is intentionally outside Git and restricted locally because the D1 export contains encrypted OAuth token ciphertext and protected broker packets.

Captured state:

- D1 database `nuvo-vsim-v5-shadow`, ID `20eb40a8-c162-43b8-b480-0d28042501de`: full SQL export and restored SQLite copy.
- R2 bucket `nuvo-vsim-v5-evidence-shadow`: all 62 keys referenced by D1 were downloaded.
- Evidence chain: 62 records, sequences 0–61, contiguous, no gaps; 62/62 D1-to-package hash matches; 62/62 package payload hashes valid; 62/62 decision fingerprints valid; 62/62 predecessor/chain links valid. Head: `163fd237cbcf143cb1311a353bbfb69370726b552ec60825f8115372b3563e8f`.
- Broker observations: 643.
- Broker events: 5,485.
- FIFO fills: 1,229.
- FIFO-matched closed lifecycles: 748; unmatched closures: 0.
- Lifetime realized P&L reconstructed from the export: `-$4,604.61`.
- Token vault rows: 1. Schwab access and refresh tokens are encrypted in D1 with AES-GCM; they are not stored in source or as plaintext Worker secrets. Worker secrets hold the Schwab application credentials and token-encryption key.
- KV: the live V5 version has no KV binding. Scheduler configuration is part of the Worker version; sessions, OAuth state, token vault, evidence index, and canonical broker state are in D1.
- Durable Object: `VsimAccountCoordinator` stores only active-cycle lease and lock history in its own SQLite storage. Cloudflare does not expose that storage through the current backup path. Canonical cycle summaries, evidence, custody, and broker ledger state are backed up from D1/R2.

Primary backup checksums:

- D1 SQL export: `d079483166bf3ec61b8ce894a13df68b5db3b4c4e889b935a86bc3e33faa9e4e`
- Restored D1 SQLite: `b9c1dbee9daafb32635cbdb8d5fe71985c9eee0193545c51e4732cf17964382b`
- R2 object manifest: `7e76d369384517ed971ef45e3f61d9db8eaca39c515494f42409fa06652ba00f`
- Performance reconstruction: `c8378f86a30d23bf4af4695d713725f5cb7c70ae421098d78a6ee99b1c001880`
- Pre-commit working-tree archive: `37a33ac44aaaf5663f97b5d63d4704062955bc772590245317db0cfd1e6a893f`

## Rollback

Source rollback:

```bash
git fetch origin --tags
git switch --detach v5-2026-08-26-consolidated
npm ci
npm test
```

Worker rollback without rebuilding:

```bash
npx wrangler versions deploy \
  0139fd54-8237-40ae-8ae9-e27261b936b1@100 \
  --name nuvo-vsim-v5-shadow \
  --config cloudflare/wrangler.jsonc \
  --message "Rollback to v5-2026-08-26-consolidated" \
  --yes
```

If a custom-domain cutover is later performed, route/DNS rollback is separate: restore the exact pre-cutover Pages/custom-domain binding recorded by the migration audit. Do not restore D1 or R2 merely to undo routing; those stores continue to advance and restoring them would discard valid append-only history.
