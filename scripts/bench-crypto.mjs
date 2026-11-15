#!/usr/bin/env node
/**
 * Crypto performance bench: what our libs actually cost, and whether the event loop blocks.
 *
 *   node scripts/bench-crypto.mjs [--json]
 *
 * It measures the hot paths (the Adonis encryption the crypto kit uses, the kit's X25519 and
 * Ed25519, HMAC, and the HTTP round trip through the crypto server), then probes the **event loop**
 * while the same work runs: synchronous `createCipheriv` (what Adonis' encryption does) against
 * `crypto.subtle` (Node's async WebCrypto, which runs on the libuv threadpool).
 *
 * Not part of `pnpm test`: numbers on a shared CI box are noisy. The bench is for a human answer
 * ("do we need worker threads?") and for before/after measurements.
 */
import { createCipheriv, randomBytes, subtle } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const kit = await import(`${root}packages/adonis/dist/src/crypto-kit/index.js`);

const json = process.argv.includes('--json');
const sizes = [
  ['128 B', 128],
  ['4 KiB', 4 * 1024],
  ['64 KiB', 64 * 1024],
  ['1 MiB', 1024 * 1024],
];

function payload(bytes) {
  return randomBytes(bytes).toString('base64');
}

/** Runs `fn` for at least `targetMs`, returns ops/sec and p50/p95 in microseconds. */
async function measure(fn, { targetMs = 400, warmup = 20 } = {}) {
  for (let index = 0; index < warmup; index += 1) await fn();
  const samples = [];
  const start = performance.now();
  while (performance.now() - start < targetMs) {
    const at = performance.now();
    await fn();
    samples.push((performance.now() - at) * 1000);
  }
  samples.sort((a, b) => a - b);
  const elapsed = (performance.now() - start) / 1000;
  return {
    opsPerSec: Math.round(samples.length / elapsed),
    p50us: Math.round(samples[Math.floor(samples.length * 0.5)] ?? 0),
    p95us: Math.round(samples[Math.floor(samples.length * 0.95)] ?? 0),
  };
}

const rows = [];
const record = (group, name, size, result) => rows.push({ group, name, size, ...result });

// 1. The crypto kit's symmetric path (Adonis encryption: synchronous createCipheriv).
const kitKeyring = kit.createKeyring({
  purpose: 'bench:secrets',
  keys: ['bench-key-of-32-characters!!!!!!!!'],
});
for (const [label, bytes] of sizes) {
  const plaintext = payload(bytes);
  const sealed = await kit.seal(kitKeyring, plaintext, { aad: 'bench' });
  record(
    'kit seal (Adonis AES-GCM, sync)',
    'seal',
    label,
    await measure(() => kit.seal(kitKeyring, plaintext, { aad: 'bench' })),
  );
  record(
    'kit open (Adonis AES-GCM, sync)',
    'open',
    label,
    await measure(() => kit.open(kitKeyring, sealed, { aad: 'bench' })),
  );
}

// 2. Node's WebCrypto AES-GCM (async, libuv threadpool) for the same payloads.
const subtleKey = await subtle.importKey('raw', randomBytes(32), 'AES-GCM', false, [
  'encrypt',
  'decrypt',
]);
for (const [label, bytes] of sizes) {
  const data = randomBytes(bytes);
  const iv = randomBytes(12);
  record(
    'crypto.subtle AES-GCM (async, threadpool)',
    'encrypt',
    label,
    await measure(() => subtle.encrypt({ name: 'AES-GCM', iv }, subtleKey, data)),
  );
}

// 3. Asymmetric and HMAC primitives.
const x25519 = kit.generateKeyPair('x25519');
const ed25519 = kit.generateKeyPair('ed25519');
const message = payload(1024);
const signature = kit.sign(ed25519.privateKey, message);
for (const [label, bytes] of [
  ['128 B', 128],
  ['4 KiB', 4 * 1024],
]) {
  const plaintext = payload(bytes);
  const sealed = kit.sealTo(x25519.publicKey, plaintext, { aad: 'bench' });
  record(
    'kit sealTo (x25519, sync)',
    'sealTo',
    label,
    await measure(() => kit.sealTo(x25519.publicKey, plaintext, { aad: 'bench' })),
  );
  record(
    'kit openWith (x25519, sync)',
    'openWith',
    label,
    await measure(() => kit.openWith(x25519.privateKey, sealed, { aad: 'bench' })),
  );
}
record(
  'kit sign (Ed25519)',
  'sign',
  '1 KiB',
  await measure(() => kit.sign(ed25519.privateKey, message)),
);
record(
  'kit verify (Ed25519)',
  'verify',
  '1 KiB',
  await measure(() => kit.verify(ed25519.publicKey, message, signature)),
);
const hmacKey = randomBytes(32);
record(
  'node:crypto hmac-sha256',
  'hmac',
  '1 KiB',
  await measure(async () => {
    const { createHmac } = await import('node:crypto');
    createHmac('sha256', hmacKey).update(message).digest('base64url');
  }),
);

// 4. Does the event loop stay free while the work runs?
//
// A 5 ms timer is scheduled before the workload; the largest lateness it sees is how long something
// else waited for the CPU. `crypto.subtle` hands the work to the libuv threadpool (a real I/O wait);
// the kit (and Adonis encryption) is CPU-bound inside the process: awaiting its promises only drains
// microtasks, which never lets timers run.
async function timerLateness(run) {
  let max = 0;
  let last = performance.now();
  let stopped = false;
  const tick = () => {
    const now = performance.now();
    max = Math.max(max, now - last - 5);
    last = now;
    if (!stopped) setTimeout(tick, 5);
  };
  setTimeout(tick, 5);
  await run();
  stopped = true;
  // The tick parked during the work fires right after it, and is what measures the block.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return Math.round(max);
}

const oneMiB = payload(1024 * 1024);
const sixtyFourKiB = payload(64 * 1024);
const rawKey = randomBytes(32);
const benchIv = randomBytes(12);
const syncCipher = (key, iv, data) => {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([cipher.update(data), cipher.final()]);
};
const kitLag64 = await timerLateness(async () => {
  for (let index = 0; index < 50; index += 1)
    await kit.seal(kitKeyring, sixtyFourKiB, { aad: 'bench' });
});
const kitLag1MiB = await timerLateness(async () => {
  for (let index = 0; index < 20; index += 1) await kit.seal(kitKeyring, oneMiB, { aad: 'bench' });
});
const rawLag = await timerLateness(async () => {
  for (let index = 0; index < 20; index += 1) syncCipher(rawKey, benchIv, Buffer.from(oneMiB));
});
const subtleLag = await timerLateness(async () => {
  for (let index = 0; index < 20; index += 1) {
    await subtle.encrypt({ name: 'AES-GCM', iv: benchIv }, subtleKey, Buffer.from(oneMiB));
  }
});

// 5. The whole HTTP path through the crypto server, with an in-process store.
const { CryptoApi } = await import(`${root}packages/adonis/dist/src/http/api.js`);
const { MemoryStore } = await import(`${root}packages/adonis/dist/src/store/memory_store.js`);
const { CryptoService } = await import(`${root}packages/adonis/dist/src/crypto/service.js`);
const { createCryptoKeyring } = await import(`${root}packages/adonis/dist/src/crypto/keyring.js`);
const { createServer } = await import('node:http');

const store = new MemoryStore();
const service = new CryptoService({
  store,
  keyring: createCryptoKeyring({ appKey: 'bench-key-of-32-characters!!!!!!!!' }),
});
const principal = { partition: 'bench', capabilities: ['crypto:*'], actor: 'bench' };
await service.createKey(principal, { name: 'bench', type: 'aes256-gcm' });
const api = new CryptoApi({
  service,
  verifyTenant: async (request) =>
    request.token === 'bench' ? { partition: 'bench', capabilities: ['crypto:*'] } : null,
});

const routes = [];
const register = (method) => (pattern, handler) => {
  routes.push({ method, pattern, handler });
  return { as: () => {} };
};
const router = {
  get: register('GET'),
  post: register('POST'),
  patch: register('PATCH'),
  delete: register('DELETE'),
};
api.register(router);
const match = (pattern, path) => {
  const names = [];
  const source = pattern.replace(/:([a-z]+)/g, (_, name) => {
    names.push(name);
    return '([^/]+)';
  });
  const found = new RegExp(`^${source}$`).exec(path);
  return found
    ? Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(found[index + 1])]))
    : null;
};
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  const url = new URL(req.url, 'http://x');
  for (const route of routes) {
    if (route.method !== req.method) continue;
    const params = match(route.pattern, url.pathname);
    if (!params) continue;
    let status = 200;
    const headers = {};
    const response = {
      status(code) {
        status = code;
        return response;
      },
      header(name, value) {
        headers[name] = value;
        return response;
      },
      json(body) {
        res.writeHead(status, { ...headers, 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      },
      send(body) {
        res.writeHead(status, headers);
        res.end(body);
      },
    };
    const ctx = {
      params,
      request: {
        header: (name) => req.headers[name.toLowerCase()],
        headers: () => req.headers,
        body: () => (raw ? JSON.parse(raw) : {}),
        qs: () => Object.fromEntries(url.searchParams),
        updateBody: () => {},
        request: req,
      },
      response,
    };
    await route.handler(ctx);
    if (!res.writableEnded) res.end();
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/_crypto/v1`;
const post = (path, body) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer bench',
      'x-crypto-app': 'bench',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }).then((response) => response.json());

for (const [label, bytes] of [
  ['1 KiB', 1024],
  ['64 KiB', 64 * 1024],
]) {
  const plaintext = payload(bytes);
  record(
    'HTTP encrypt (server, in-process store)',
    'POST /encrypt',
    label,
    await measure(() => post('/encrypt', { key: 'bench', plaintext })),
  );
  const { ciphertext } = await post('/encrypt', { key: 'bench', plaintext });
  record(
    'HTTP decrypt (server, in-process store)',
    'POST /decrypt',
    label,
    await measure(() => post('/decrypt', { key: 'bench', ciphertext })),
  );
}
server.close();

// 6. Report.
if (json) {
  process.stdout.write(
    `${JSON.stringify({ rows, timerLateness: { kit64KiB: kitLag64, kit1MiB: kitLag1MiB, rawAes1MiB: rawLag, subtle1MiB: subtleLag } }, null, 2)}\n`,
  );
} else {
  const groups = [...new Set(rows.map((row) => row.group))];
  console.log(`\nnode ${process.version} · ${process.env.CI ? 'CI' : 'local'}\n`);
  for (const group of groups) {
    console.log(group);
    console.log('  size     ops/s      p50        p95');
    for (const row of rows.filter((entry) => entry.group === group)) {
      console.log(
        `  ${row.size.padEnd(8)} ${String(row.opsPerSec).padStart(7)}  ${`${row.p50us} µs`.padStart(9)}  ${`${row.p95us} µs`.padStart(9)}`,
      );
    }
    console.log('');
  }
  console.log('Timer lateness while a workload runs (max, lower is better; ≈ max block)');
  console.log(`  kit seal 64 KiB × 50 (Adonis, sync):        ${kitLag64} ms`);
  console.log(`  kit seal 1 MiB × 20 (Adonis, sync):         ${kitLag1MiB} ms`);
  console.log(`  raw AES-GCM 1 MiB × 20 (sync):              ${rawLag} ms`);
  console.log(`  crypto.subtle 1 MiB × 20 (threadpool):      ${subtleLag} ms`);
  console.log('');
}
