# Encrypted capture-only release

2026-08-31. Supersedes the retention HOLD in LANE_1_PREVIEW_CAPTURE_ONLY_HOLD.md.
Principal approved: encrypted exact original, deterministic redacted inspection,
capture-only deployment, one VALIDATE of the existing morning row, then keys/types
from the decrypted ORIGINAL. Stop before mapping, asset widening, or ARM.

## Two payload artifacts, independently named hashes

1. `original.encrypted.json`: AES-256-GCM encrypts every response byte. A random
   per-response AES key is wrapped with RSA-OAEP-SHA256. Authenticated additional
   data binds the original SHA to source ingress, TV hash, request hash, Worker,
   HTTP status, acquisition time and capture ID. No plaintext original is stored.
2. `inspection.json`: deterministic canonical JSON containing `originalSha256`,
   `redactionVersion`, sorted `removedPaths`, parse status and the allowlisted body.
   Its separately computed `redactedSha256` does not claim to be the original SHA.

`manifest.json` is the index, not a third body copy. Both semantic payload hashes
are recorded in the manifest and D1 receipt. An additional `encryptedSha256`
verifies the encryption envelope's stored bytes; it is not the original hash.

`SCHWAB_PREVIEW_ALLOWLIST_V1` allows only named preview/order/leg/validation paths.
Account identifiers, token fields, unknown extensions and free-form message text
are removed as whole fields, never regex-scrubbed. Removed array entries retain
index positions with explicit removed-path markers. Never interpret a removed
value as a Schwab omission or null. Capture classification still uses ORIGINAL
bytes; reports/D1 summaries use the redacted projection only.

## Key custody

Public key fingerprint:
`7d47f3ba2c3e3c1afcab0eab032474efbf5cfa5a53e426e7a00aa0203da1656a`.
Public SPKI only is committed in `cloudflare/preview-evidence-public-key.js`.
Private key: `/Users/nuvo/.codex/keys/nuvo-preview-evidence-v1/private.pem`.
Directory mode 0700; key mode 0600. Actual public/private round trip was verified
locally. No private key is uploaded to Cloudflare or GitHub. Preserve this key:
losing it prevents decryption of these evidence objects. No Schwab credential or
existing token-encryption key is reused, rotated, or changed.

The existing evidence bucket has r2.dev public access disabled and no custom
domains (read-only checks on 2026-08-31). No new binding, secret or public route.

## Behavior and failure bounds

The capture callback runs after the single `/previewOrder` response and before
JSON/schema validation. Original ciphertext is saved/read-back/hash-verified before
the redactor runs. Writes are conditional and append-only. A later parser/D1
failure does not discard the encrypted original. No retry, coordinator claim,
broker order, new alert or authority change is introduced.

Capture bounds memory at 8 MiB and refuses larger/broken responses without storing
a truncated body. Complete 1–8 MiB originals are saved but refused for parsing;
the existing 1 MiB parser limit remains. Invalid UTF8/malformed JSON is encrypted
and retained; its inspection copy contains no free text.

Outgoing ticket and acceptance checks are unchanged: one SPY share, intended
instruction, MARKET/SINGLE/NORMAL/DAY. No semantic mapping/asset-type changes here.

## Tests/build/rollback

- Live/base Git: `aab2f6e8f677fbc41f5435268218880c5870081e`.
- Rollback version: `98f7b19a-7874-49e9-b3a3-7f1a697acaa4`.
- Prior bundle: `2a9fb432796b9e6409c856e8eb78ec0ac39551104b8e225117f147a212a20223`, 1,956,123 bytes.
- Candidate bundle: `b2c1da801481310ed50bfd5292cb184d6b0a73a8daaa3b026db89a30c7871510`, 1,969,832 bytes.
- Two independent dry builds match; candidate is +13,709 bytes.
- Full tests: 532 live baseline -> 545 capture draft -> 549 encrypted capture;
  66 suites, all pass, no skip. Tests include actual local workerd/R2,
  encryption/decryption, tamper refusal, deterministic redaction and two hashes.
- Synthetic fixtures prove mechanics/guards only, NOT live Schwab compatibility.
- Runtime/config bindings must compare identical before traffic is switched.

Rollback from this repository (not executed):

```sh
node node_modules/wrangler/bin/wrangler.js rollback 98f7b19a-7874-49e9-b3a3-7f1a697acaa4 --config cloudflare/wrangler.jsonc --message "Rollback capture-only; ARM remains OFF" --yes
```

After deployment, confirm both ARM keys off and exact source row
`327c1bcb-e57c-4f9e-9611-5f94a3ef076f`, then VALIDATE once. Save receipt, download
both artifact objects, decrypt original in memory using the offline inspector,
verify original/redacted hashes, and report original keys/types before proposing
any new DTO/mapping. No new TradingView signal and no second validation here.
