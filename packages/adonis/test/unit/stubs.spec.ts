import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import type { SqlDatabase } from '../../src/sql.js';
import { LucidStore } from '../../src/store/lucid_store.js';
import { stubsRoot } from '../../stubs/main.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function stubFiles(dir = stubsRoot()): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return stubFiles(path);
    return name.endsWith('.stub') ? [relative(stubsRoot(), path)] : [];
  });
}

async function app() {
  const dir = mkdtempSync(join(tmpdir(), 'agora-crypto-stubs-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const application = new AppFactory().create(pathToFileURL(`${dir}/`), () => {});
  await application.init();
  return { application, dir };
}

describe('stubs', () => {
  it('every stub `configure` publishes renders with a destination', async () => {
    const { application } = await app();
    const files = stubFiles();
    expect(files).toContain('database/migrations/add_crypto_audit_filter_indexes.stub');
    for (const file of files) {
      const stub = await (await application.stubs.create()).build(file, { source: stubsRoot() });
      const prepared = await stub.prepare({});
      expect(prepared.destination, file).toMatch(/\.ts$/);
    }
  });

  it('the opt-in audit index migration creates and drops its indexes on SQLite', async () => {
    const { application, dir } = await app();
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
      new Emitter(application),
    );
    cleanups.unshift(() => database.manager.closeAll());
    const connection = database.connection();
    await new LucidStore(connection as unknown as SqlDatabase).setup();
    const indexes = async () =>
      (
        (await connection.rawQuery(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'crypto_audit'",
        )) as Array<{ name: string }>
      ).map((row) => row.name);

    const Migration = await indexMigration(application);
    await new Migration(connection, 'indexes', false).execUp();
    expect(await indexes()).toEqual(expect.arrayContaining(INDEXES));
    await new Migration(connection, 'indexes', false).execDown();
    expect(await indexes()).not.toEqual(expect.arrayContaining([INDEXES[0]]));
  });

  const url = process.env.CRYPTO_TEST_PG_URL;
  it.skipIf(!url)('builds the indexes CONCURRENTLY on Postgres, idempotently', async () => {
    const { application } = await app();
    const database = new Database(
      { connection: 'pg', connections: { pg: { client: 'pg', connection: url } } },
      new LoggerFactory().create(),
      new Emitter(application),
    );
    cleanups.unshift(async () => {
      await connection.rawQuery(
        'DROP TABLE IF EXISTS crypto_audit, crypto_key_versions, crypto_keys',
      );
      await database.manager.closeAll();
    });
    const connection = database.connection();
    await new LucidStore(connection as unknown as SqlDatabase).setup();
    const indexes = async () =>
      (
        (await connection.rawQuery(
          "SELECT indexname FROM pg_indexes WHERE tablename = 'crypto_audit'",
        )) as { rows: Array<{ indexname: string }> }
      ).rows.map((row) => row.indexname);

    const Migration = await indexMigration(application);
    await new Migration(connection, 'indexes', false).execUp();
    // A second run (an install that already has them) is a no-op, not an error.
    await new Migration(connection, 'indexes', false).execUp();
    expect(await indexes()).toEqual(expect.arrayContaining(INDEXES));
    await new Migration(connection, 'indexes', false).execDown();
    expect((await indexes()).filter((name) => INDEXES.includes(name))).toEqual([]);
  });
});

const INDEXES = [
  'crypto_audit_app_at_id_idx',
  'crypto_audit_app_key_at_idx',
  'crypto_audit_app_operation_at_idx',
  'crypto_audit_app_result_at_idx',
  'crypto_audit_app_actor_at_idx',
];

/** Renders the published migration next to this spec (so its imports resolve) and loads it. */
async function indexMigration(application: Awaited<ReturnType<typeof app>>['application']) {
  const stub = await (await application.stubs.create()).build(
    'database/migrations/add_crypto_audit_filter_indexes.stub',
    { source: stubsRoot() },
  );
  const { contents } = await stub.prepare({});
  const file = join(import.meta.dirname, `.tmp_audit_indexes_${process.pid}_${Date.now()}.ts`);
  writeFileSync(file, contents);
  cleanups.push(() => rmSync(file, { force: true }));
  return (await import(pathToFileURL(file).href)).default;
}
