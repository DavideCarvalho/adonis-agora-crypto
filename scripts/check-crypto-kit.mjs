#!/usr/bin/env node
/**
 * agora crypto-kit drift check v1 — keep identical across libs.
 *
 * Every @adonis-agora lib that stores secrets keeps a verbatim copy of the canonical crypto kit at
 * `src/crypto-kit/`. This fails when a copy differs from the canonical files pinned below.
 *
 * Usage: node scripts/check-crypto-kit.mjs <package dir> [<package dir> ...]
 * e.g.   node scripts/check-crypto-kit.mjs packages/adonis
 *
 * Never edit a copy or these hashes in one repo: update _1x/shared/crypto-kit, re-copy every lib,
 * then update the hashes here.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FROZEN = {
  'asymmetric.ts': '4efe4c1f2e6875130685cde333d8cc64382464b01ed383206c28dc545463f11f',
  'crypto-kit.cases.ts': 'e93c8ab7c440083588de112e4ba259bf5ef9562fcf3db731bedab4340337f901',
  'index.ts': 'd5f1e67bb362bbb2bcd4a034ea1a03014fa266f386a0d0d2e5944983e088a2a4',
  'keyring.ts': '9ca9066d509d9694b71b0fe4f1a1f15aa74f7bbf24a892e44aef59ed6736f49f',
  'kms.ts': '0363c60641e136c511b193c3b35cff01d9e2e8b97966e98da7caea719a4a48d8',
  'seal.ts': 'd4900af5c1d9804e570fc5eaa499bfb20e9fb2352191a7b1bbc307db7650d726',
};

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: node scripts/check-crypto-kit.mjs <package dir> [<package dir> ...]');
  process.exit(2);
}

let failed = false;
for (const dir of dirs) {
  for (const [file, sha256] of Object.entries(FROZEN)) {
    const path = join(resolve(dir), 'src', 'crypto-kit', file);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      console.error(`✖ ${path}: missing`);
      failed = true;
      continue;
    }
    const actual = createHash('sha256').update(text).digest('hex');
    if (!text.startsWith('// agora crypto-kit v1')) {
      console.error(`✖ ${path}: missing the canonical header`);
      failed = true;
    } else if (actual !== sha256) {
      console.error(
        `✖ ${path}: differs from the canonical copy (sha256 ${actual}, expected ${sha256})`,
      );
      failed = true;
    } else {
      console.log(`✔ ${path}`);
    }
  }
}
process.exit(failed ? 1 : 0);
