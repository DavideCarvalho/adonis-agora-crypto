import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CryptoAuditRecord } from '@adonis-agora/crypto-core';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuditCursorQuery, CryptoService } from '../../src/crypto/service.js';
import { inSchema, type SqlClient, type SqlDatabase } from '../../src/sql.js';
import { LucidStore } from '../../src/store/lucid_store.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import type { CryptoStore } from '../../src/store/store.js';
import { testKeyring } from '../../src/testing/index.js';

const PRINCIPAL = { partition: 'shop', capabilities: ['crypto:*'], actor: 'test' };

/**
 * 23 rows in five `at` buckets (so most rows tie on `at` with others), mixed operations and
 * results, plus rows of another app that must never show up.
 */
function fixture(): CryptoAuditRecord[] {
  const rows: CryptoAuditRecord[] = [];
  for (let n = 0; n < 23; n++) {
    rows.push({
      id: `id-${String((n * 7) % 23).padStart(2, '0')}`,
      at: `2026-11-17T10:00:0${n % 5}.000Z`,
      partition: 'shop',
      key: n % 2 === 0 ? 'orders' : 'users',
      operation: n % 3 === 0 ? 'decrypt' : 'encrypt',
      actor: 'svc',
      result: n % 4 === 0 ? 'denied' : 'ok',
    });
  }
  rows.push({
    id: 'other-1',
    at: '2026-11-17T10:00:09.000Z',
    partition: 'billing',
    operation: 'encrypt',
    actor: 'svc',
    result: 'ok',
  });
  return rows;
}

const byKeyset = (a: CryptoAuditRecord, b: CryptoAuditRecord) =>
  a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1;

function expected(filter: (row: CryptoAuditRecord) => boolean = () => true, asc = false) {
  const rows = fixture()
    .filter((row) => row.partition === 'shop' && filter(row))
    .sort(byKeyset);
  return (asc ? rows : rows.reverse()).map((row) => row.id);
}

/** Walks every page forward, then back from the last one; returns both id sequences. */
async function walk(service: CryptoService, base: Omit<AuditCursorQuery, 'after' | 'before'>) {
  const pages: string[][] = [];
  let after: string | undefined;
  let lastPrev: string | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const page = await service.auditCursor(PRINCIPAL, {
      ...base,
      ...(after !== undefined ? { after } : {}),
    });
    expect(page.data.length).toBeLessThanOrEqual(base.size);
    expect(page.meta.hasPrev).toBe(pages.length > 0);
    pages.push(page.data.map((row) => row.id));
    lastPrev = page.meta.prevCursor;
    if (!page.meta.hasNext) {
      expect(page.meta.nextCursor).toBeNull();
      break;
    }
    after = page.meta.nextCursor ?? undefined;
  }
  // Backward from the last page reproduces the same pages, in order.
  const back: string[][] = [];
  let before = lastPrev;
  while (before !== null) {
    const page = await service.auditCursor(PRINCIPAL, { ...base, before });
    expect(page.meta.hasNext).toBe(true);
    back.unshift(page.data.map((row) => row.id));
    before = page.meta.hasPrev ? page.meta.prevCursor : null;
  }
  return { pages, back };
}

function suite(name: string, makeStore: () => Promise<CryptoStore>) {
  describe(`audit by cursor (${name})`, () => {
    let service: CryptoService;

    beforeAll(async () => {
      const store = await makeStore();
      await store.setup?.();
      for (const row of fixture()) await store.appendAudit(row);
      service = new CryptoService({ store, keyring: testKeyring() });
    });

    it('walks every row once, newest first, across ties on `at`, both directions', async () => {
      const { pages, back } = await walk(service, { size: 4 });
      const ids = pages.flat();
      expect(ids).toEqual(expected());
      expect(new Set(ids).size).toBe(ids.length);
      expect(pages).toHaveLength(6);
      expect(back).toEqual(pages.slice(0, -1));
    });

    it('keeps the filters on every page', async () => {
      const denied = await walk(service, { size: 2, filters: { result: 'denied' } });
      expect(denied.pages.flat()).toEqual(expected((row) => row.result === 'denied'));
      const decrypts = await walk(service, {
        size: 3,
        filters: { key: 'orders', operation: 'decrypt' },
      });
      expect(decrypts.pages.flat()).toEqual(
        expected((row) => row.key === 'orders' && row.operation === 'decrypt'),
      );
    });

    it('walks oldest first with sort asc', async () => {
      const { pages, back } = await walk(service, { size: 5, sort: 'asc' });
      expect(pages.flat()).toEqual(expected(undefined, true));
      expect(back).toEqual(pages.slice(0, -1));
    });

    it('answers a single page without cursors when every row fits', async () => {
      const page = await service.auditCursor(PRINCIPAL, { size: 23 });
      expect(page.data).toHaveLength(23);
      expect(page.meta).toEqual({
        nextCursor: null,
        prevCursor: null,
        hasNext: false,
        hasPrev: false,
      });
    });

    it('refuses a cursor it did not issue', async () => {
      await expect(
        service.auditCursor(PRINCIPAL, { size: 4, after: 'not-a-cursor' }),
      ).rejects.toMatchObject({ code: 'invalid' });
      await expect(
        service.auditCursor(PRINCIPAL, {
          size: 4,
          after: Buffer.from('[1]').toString('base64url'),
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
    });

    it('still answers ?page= with the offset envelope', async () => {
      const page = await service.audit(PRINCIPAL, { page: 2, size: 4 });
      expect(page.meta).toMatchObject({ total: 23, currentPage: 2, lastPage: 6 });
      expect(page.data.map((row) => row.id)).toEqual(expected().slice(4, 8));
    });
  });
}

suite('memory', async () => new MemoryStore());

const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of closers.splice(0)) await close();
});

suite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agora-crypto-cursor-'));
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
  await app.init();
  const database = new Database(
    {
      connection: 'sqlite',
      connections: {
        sqlite: {
          client: 'better-sqlite3',
          connection: { filename: join(dir, 'db.sqlite') },
          useNullAsDefault: true,
        },
      },
    },
    new LoggerFactory().create(),
    new Emitter(app),
  );
  closers.push(async () => {
    await database.manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });
  return new LucidStore(database.connection() as unknown as SqlDatabase);
});

/** Same as `postgres_schema.spec.ts`: runs only when CI provides `CRYPTO_TEST_PG_URL`. */
const url = process.env.CRYPTO_TEST_PG_URL;
if (url) {
  suite('postgres', async () => {
    const schema = `crypto_cursor_${randomBytes(4).toString('hex')}`;
    const pool = new Pool({ connectionString: url });
    const placeholders = (sql: string) => {
      let index = 0;
      return sql.replace(/\?/g, () => `$${++index}`);
    };
    const client: SqlDatabase = {
      dialect: { name: 'postgres' },
      rawQuery: (sql, bindings) => pool.query(placeholders(sql), bindings as unknown[]),
      transaction: async (callback) => callback(client as SqlClient),
    };
    await pool.query(`CREATE SCHEMA "${schema}"`);
    closers.push(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    });
    return new LucidStore(inSchema(client, schema), { autoCreateSchema: true });
  });
}
