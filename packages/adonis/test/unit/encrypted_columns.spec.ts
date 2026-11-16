import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { BaseModel, column } from '@adonisjs/lucid/orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { localOperations } from '../../src/operations.js';
import { inSchema, type SqlDatabase } from '../../src/sql.js';
import { type BackfillModel, backfillEncryptedColumns } from '../../src/subjects/backfill.js';
import { readSubjectCiphertext } from '../../src/subjects/ciphertext.js';
import { SubjectKeyError } from '../../src/subjects/errors.js';
import { encrypted, SealedValue } from '../../src/subjects/lucid.js';
import { LucidDataKeyStore } from '../../src/subjects/store.js';
import { SubjectKeys } from '../../src/subjects/subject_keys.js';
import { memoryCrypto } from '../../src/testing/index.js';

/**
 * Encrypted Lucid columns end to end: real models, real queries, a real database. SQLite always;
 * Postgres too when `CRYPTO_TEST_PG_URL` is set (CI provides one).
 */
type Dialect = 'sqlite' | 'postgres';
const dialects: Dialect[] = process.env.CRYPTO_TEST_PG_URL ? ['sqlite', 'postgres'] : ['sqlite'];

let subjects: SubjectKeys;
let down = false;

class Note extends BaseModel {
  static override table = 'notes';
  static override selfAssignPrimaryKey = true;

  @column({ isPrimary: true })
  declare id: string;

  @column()
  declare researcherId: number;

  @column()
  declare title: string;

  @encrypted({ subject: (note: Note) => note.researcherId, using: () => subjects })
  declare body: string | null;

  @encrypted({ subject: (note: Note) => note.researcherId, json: true, using: () => subjects })
  declare answers: Record<string, unknown> | null;
}

/** Auto-increment ids: bound to table and column only. */
class Survey extends BaseModel {
  static override table = 'surveys';

  @column({ isPrimary: true })
  declare id: number;

  @column()
  declare researcherId: number;

  @encrypted({
    subject: (survey: Survey) => survey.researcherId,
    row: false,
    using: () => subjects,
  })
  declare notes: string;
}

/** The same table as Note, during a migration: plaintext rows are still there. */
class LegacyNote extends BaseModel {
  static override table = 'notes';
  static override selfAssignPrimaryKey = true;

  @column({ isPrimary: true })
  declare id: string;

  @column()
  declare researcherId: number;

  @column()
  declare title: string;

  @encrypted({
    subject: (note: LegacyNote) => note.researcherId,
    legacyPlaintext: true,
    columnName: 'body',
    using: () => subjects,
  })
  declare body: string | null;

  @encrypted({
    subject: (note: LegacyNote) => note.researcherId,
    json: true,
    legacyPlaintext: true,
    using: () => subjects,
  })
  declare answers: Record<string, unknown> | null;
}

for (const dialect of dialects) {
  describe(`encrypted columns (${dialect})`, () => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let store: LucidDataKeyStore;
    const schema = `crypto_cols_${randomUUID().slice(0, 8)}`;

    const raw = async (sql: string, bindings: unknown[] = []) => {
      const result = (await database.rawQuery(sql, bindings)) as unknown;
      return (
        Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      ) as Array<Record<string, unknown>>;
    };
    const table = (name: string) => (dialect === 'postgres' ? `"${schema}".${name}` : name);

    beforeAll(async () => {
      const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
      await app.init();
      const dir = mkdtempSync(join(tmpdir(), 'agora-crypto-cols-'));
      database = new Database(
        dialect === 'sqlite'
          ? {
              connection: 'main',
              connections: {
                main: {
                  client: 'better-sqlite3',
                  connection: { filename: join(dir, 'db.sqlite') },
                  useNullAsDefault: true,
                },
              },
            }
          : {
              connection: 'main',
              connections: {
                main: {
                  client: 'pg',
                  connection: process.env.CRYPTO_TEST_PG_URL!,
                  searchPath: [schema],
                },
              },
            },
        new LoggerFactory().create(),
        new Emitter(app),
      );
      if (dialect === 'postgres') await database.rawQuery(`CREATE SCHEMA "${schema}"`);
      BaseModel.useAdapter(database.modelAdapter());
      cleanup = async () => {
        if (dialect === 'postgres') {
          await database.rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        }
        await database.manager.closeAll();
        rmSync(dir, { recursive: true, force: true });
      };
      const conn = database.connection() as unknown as SqlDatabase;
      // Postgres: the store qualifies its table with the schema (no search_path dependency).
      store = new LucidDataKeyStore(dialect === 'postgres' ? inSchema(conn, schema) : conn);
      await store.setup();
      await database.rawQuery(
        `CREATE TABLE ${table('notes')} (id varchar(36) PRIMARY KEY, researcher_id integer NOT NULL, title text NULL, body text NULL, answers text NULL)`,
      );
      await database.rawQuery(
        `CREATE TABLE ${table('surveys')} (id ${dialect === 'postgres' ? 'serial' : 'integer'} PRIMARY KEY ${dialect === 'sqlite' ? 'AUTOINCREMENT' : ''}, researcher_id integer NOT NULL, notes text NOT NULL)`,
      );
    });

    afterAll(async () => {
      await cleanup?.();
    });

    beforeEach(async () => {
      down = false;
      const crypto = memoryCrypto();
      const operations = localOperations(crypto.service, crypto.principal);
      const failing = <T extends (...args: never[]) => unknown>(fn: T): T =>
        ((...args: never[]) => {
          if (down) {
            return Promise.reject(
              Object.assign(new Error('crypto: fetch failed'), {
                name: 'CryptoClientError',
                code: 'network',
                status: 0,
              }),
            );
          }
          return fn(...args);
        }) as T;
      subjects = new SubjectKeys({
        operations: {
          generateDataKey: failing(operations.generateDataKey),
          decrypt: failing(operations.decrypt),
          rewrap: failing(operations.rewrap),
          createKey: failing(operations.createKey),
          deleteKey: failing(operations.deleteKey),
          getKey: failing(operations.getKey),
        },
        store,
      });
      await database.rawQuery(`DELETE FROM ${table('notes')}`);
      await database.rawQuery(`DELETE FROM ${table('surveys')}`);
      await database.rawQuery(`DELETE FROM ${table('crypto_data_keys')}`);
    });

    it('stores ciphertext, reads plaintext (find, fetch, paginate, first)', async () => {
      const note = await Note.create({
        id: randomUUID(),
        researcherId: 7,
        title: 'visible',
        body: 'field notes',
        answers: { q1: 'yes', score: 3 },
      });
      expect(note.body).toBe('field notes');
      expect(note.answers).toEqual({ q1: 'yes', score: 3 });
      expect(note.$isDirty).toBe(false);

      const [row] = await raw(`SELECT body, answers, title FROM ${table('notes')}`);
      expect(String(row!.body).startsWith('agora:se1:subject_7:')).toBe(true);
      expect(String(row!.answers).startsWith('agora:se1:subject_7:')).toBe(true);
      expect(JSON.stringify(row)).not.toContain('field notes');
      expect(row!.title).toBe('visible');

      const found = await Note.findOrFail(note.id);
      expect(found.body).toBe('field notes');
      expect(found.answers).toEqual({ q1: 'yes', score: 3 });
      expect(found.$isDirty).toBe(false);
      expect(found.serialize()).toMatchObject({ body: 'field notes' });

      const all = await Note.query().where('researcher_id', 7);
      expect(all[0]!.body).toBe('field notes');
      const page = await Note.query().paginate(1, 10);
      expect(page.all()[0]!.answers).toEqual({ q1: 'yes', score: 3 });
      expect((await Note.query().first())!.body).toBe('field notes');
    });

    it('re-encrypts only what changed, and keeps nulls', async () => {
      const note = await Note.create({
        id: randomUUID(),
        researcherId: 1,
        title: 't',
        body: 'v1',
        answers: null,
      });
      const [before] = await raw(`SELECT body FROM ${table('notes')} WHERE id = ?`, [note.id]);
      note.title = 'renamed';
      await note.save();
      const [same] = await raw(`SELECT body, answers FROM ${table('notes')} WHERE id = ?`, [
        note.id,
      ]);
      expect(same!.body).toBe(before!.body);
      expect(same!.answers).toBeNull();

      note.body = 'v2';
      await note.save();
      const reloaded = await Note.findOrFail(note.id);
      expect(reloaded.body).toBe('v2');

      // JSON mutated in place is detected.
      reloaded.answers = { a: 1 };
      await reloaded.save();
      const again = await Note.findOrFail(note.id);
      again.answers!.a = 2;
      await again.save();
      expect((await Note.findOrFail(note.id)).answers).toEqual({ a: 2 });
    });

    it('re-seals for the new subject when a row changes owner', async () => {
      const note = await Note.create({ id: randomUUID(), researcherId: 1, title: 't', body: 'b' });
      const loaded = await Note.findOrFail(note.id);
      loaded.researcherId = 2;
      await loaded.save();
      const [row] = await raw(`SELECT body FROM ${table('notes')} WHERE id = ?`, [note.id]);
      expect(String(row!.body).startsWith('agora:se1:subject_2:')).toBe(true);
      expect((await Note.findOrFail(note.id)).body).toBe('b');
    });

    it('a ciphertext swapped between rows or columns does not open', async () => {
      const a = await Note.create({ id: randomUUID(), researcherId: 1, title: 'a', body: 'A' });
      const b = await Note.create({ id: randomUUID(), researcherId: 1, title: 'b', body: 'B' });
      const [rowA] = await raw(`SELECT body FROM ${table('notes')} WHERE id = ?`, [a.id]);
      await database.rawQuery(`UPDATE ${table('notes')} SET body = ? WHERE id = ?`, [
        rowA!.body,
        b.id,
      ]);
      await expect(Note.findOrFail(b.id)).rejects.toThrow(SubjectKeyError);
      await expect(Note.query().where('id', b.id)).rejects.toThrow(/did not open/);

      await database.rawQuery(
        `UPDATE ${table('notes')} SET body = NULL, answers = ? WHERE id = ?`,
        [rowA!.body, a.id],
      );
      await expect(Note.findOrFail(a.id)).rejects.toThrow(SubjectKeyError);
    });

    it('a row moved to another subject in the database does not open', async () => {
      const note = await Note.create({ id: randomUUID(), researcherId: 1, title: 't', body: 'x' });
      await database.rawQuery(`UPDATE ${table('notes')} SET researcher_id = 2 WHERE id = ?`, [
        note.id,
      ]);
      await expect(Note.findOrFail(note.id)).rejects.toThrow(/another subject/);
    });

    it('plaintext in the database throws without legacyPlaintext', async () => {
      const id = randomUUID();
      await database.rawQuery(
        `INSERT INTO ${table('notes')} (id, researcher_id, title, body) VALUES (?, 1, 't', 'plain')`,
        [id],
      );
      await expect(Note.findOrFail(id)).rejects.toThrow(/not encrypted/);
    });

    it('never writes plaintext: saveQuietly and a missing row id throw', async () => {
      const note = new Note();
      note.merge({ id: randomUUID(), researcherId: 1, title: 't', body: 'secret' });
      await expect(note.saveQuietly()).rejects.toThrow(/without encryption/);
      expect(await raw(`SELECT * FROM ${table('notes')}`)).toEqual([]);

      const noId = new Note();
      noId.merge({ researcherId: 1, title: 't', body: 'secret' });
      await expect(noId.save()).rejects.toThrow(/no id yet/);

      const noSubject = new Note();
      noSubject.merge({ id: randomUUID(), title: 't', body: 'secret' });
      await expect(noSubject.save()).rejects.toThrow(/needs a subject/);
      expect(await raw(`SELECT * FROM ${table('notes')}`)).toEqual([]);
    });

    it('a value loaded without the hooks refuses to be read as data', async () => {
      await Note.create({ id: randomUUID(), researcherId: 1, title: 't', body: 'x' });
      const [row] = await raw(`SELECT * FROM ${table('notes')}`);
      const model = Note.$createFromAdapterResult(row!)!;
      expect(model.body).toBeInstanceOf(SealedValue);
      expect(() => `${model.body}`).toThrow(/not decrypted/);
      expect(() => JSON.stringify(model.serialize())).toThrow(/not decrypted/);
    });

    it('works with auto-increment ids when bound to table and column only', async () => {
      const survey = await Survey.create({ researcherId: 3, notes: 'n' });
      expect(survey.id).toBeGreaterThan(0);
      expect((await Survey.findOrFail(survey.id)).notes).toBe('n');
    });

    it('keeps cached subjects readable when the control plane is down; uncached fail typed', async () => {
      const cachedNote = await Note.create({ id: randomUUID(), researcherId: 1, body: 'one' });
      const coldNote = await Note.create({ id: randomUUID(), researcherId: 2, body: 'two' });
      subjects.evict(2);
      down = true;
      expect((await Note.findOrFail(cachedNote.id)).body).toBe('one');
      const error = await Note.findOrFail(coldNote.id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SubjectKeyError);
      expect((error as SubjectKeyError).code).toBe('unavailable');
      await expect(Note.create({ id: randomUUID(), researcherId: 3, body: 'x' })).rejects.toThrow(
        /unavailable/,
      );
      expect(await raw(`SELECT * FROM ${table('notes')} WHERE researcher_id = 3`)).toEqual([]);
    });

    it('forgetting a subject makes its rows unreadable, others untouched', async () => {
      const mine = await Note.create({ id: randomUUID(), researcherId: 1, body: 'mine' });
      const theirs = await Note.create({ id: randomUUID(), researcherId: 2, body: 'theirs' });
      await subjects.forget(1);
      const error = await Note.findOrFail(mine.id).catch((e: unknown) => e);
      expect((error as SubjectKeyError).code).toBe('forgotten');
      expect((await Note.findOrFail(theirs.id)).body).toBe('theirs');
    });

    it('legacyPlaintext reads old rows as they are, and saving encrypts them', async () => {
      const id = randomUUID();
      await database.rawQuery(
        `INSERT INTO ${table('notes')} (id, researcher_id, title, body, answers) VALUES (?, 4, 't', 'old text', ?)`,
        [id, JSON.stringify({ old: true })],
      );
      const legacy = await LegacyNote.findOrFail(id);
      expect(legacy.body).toBe('old text');
      expect(legacy.answers).toEqual({ old: true });
      legacy.title = 'touched';
      await legacy.save();
      const [row] = await raw(`SELECT body, answers FROM ${table('notes')} WHERE id = ?`, [id]);
      expect(String(row!.body).startsWith('agora:se1:subject_4:')).toBe(true);
      expect(String(row!.answers).startsWith('agora:se1:subject_4:')).toBe(true);
      expect((await Note.findOrFail(id)).answers).toEqual({ old: true });
    });

    it('backfill encrypts in batches, is idempotent and resumable, and leaves updated rows alone', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        const id = `00000000-0000-4000-8000-00000000000${i}`;
        ids.push(id);
        await database.rawQuery(
          `INSERT INTO ${table('notes')} (id, researcher_id, title, body, answers) VALUES (?, ?, 't', ?, ?)`,
          [id, (i % 3) + 1, i === 3 ? null : `body ${i}`, JSON.stringify({ i })],
        );
      }
      // One row already encrypted through the model.
      const fresh = await Note.create({
        id: 'ffffffff-0000-4000-8000-000000000000',
        researcherId: 1,
        body: 'new',
        answers: { n: 1 },
      });

      const dry = await backfillEncryptedColumns(LegacyNote as unknown as BackfillModel, {
        batchSize: 3,
        dryRun: true,
      });
      expect(dry).toMatchObject({ rows: 8, encrypted: 13, reencrypted: 0 });
      expect(
        String((await raw(`SELECT body FROM ${table('notes')} WHERE id = ?`, [ids[0]]))[0]!.body),
      ).toBe('body 0');

      // Stop after the first batch, then resume from its cursor.
      const cursors: Array<string | number | undefined> = [];
      const first = await backfillEncryptedColumns(LegacyNote as unknown as BackfillModel, {
        batchSize: 3,
        onBatch: (progress) => {
          cursors.push(progress.cursor);
          if (cursors.length === 1) throw new Error('interrupted');
        },
      }).catch((error: Error) => error);
      expect((first as Error).message).toBe('interrupted');
      const resumed = await backfillEncryptedColumns(LegacyNote as unknown as BackfillModel, {
        batchSize: 3,
        after: cursors[0]!,
      });
      expect(resumed.rows).toBe(5);

      const rerun = await backfillEncryptedColumns(LegacyNote as unknown as BackfillModel, {
        batchSize: 3,
      });
      expect(rerun).toMatchObject({ rows: 8, encrypted: 0, reencrypted: 0, unchanged: 16 });

      const rows = await raw(`SELECT id, body, answers FROM ${table('notes')}`);
      for (const row of rows) {
        expect(row.body === null || String(row.body).startsWith('agora:se1:')).toBe(true);
        expect(String(row.answers).startsWith('agora:se1:')).toBe(true);
      }
      // Readable through the strict model now.
      const all = await Note.query().orderBy('id', 'asc');
      expect(all.map((note) => note.body)).toEqual([
        'body 0',
        'body 1',
        'body 2',
        null,
        'body 4',
        'body 5',
        'body 6',
        'new',
      ]);
      expect(all[5]!.answers).toEqual({ i: 5 });
      expect((await Note.findOrFail(fresh.id)).answers).toEqual({ n: 1 });
    });

    it('backfill --rotate re-encrypts values sealed with a retired data key', async () => {
      const note = await Note.create({
        id: randomUUID(),
        researcherId: 1,
        body: 'b',
        answers: { a: 1 },
      });
      const [before] = await raw(`SELECT body FROM ${table('notes')} WHERE id = ?`, [note.id]);
      await subjects.rotateDataKey(1);
      expect(
        await backfillEncryptedColumns(Note as unknown as BackfillModel, { columns: ['body'] }),
      ).toMatchObject({ unchanged: 1, reencrypted: 0 });
      const rotated = await backfillEncryptedColumns(Note as unknown as BackfillModel, {
        rotate: true,
      });
      expect(rotated).toMatchObject({ rows: 1, reencrypted: 2 });
      const [after] = await raw(`SELECT body FROM ${table('notes')} WHERE id = ?`, [note.id]);
      expect(readSubjectCiphertext(after!.body)!.dataKeyId).not.toBe(
        readSubjectCiphertext(before!.body)!.dataKeyId,
      );
      expect((await Note.findOrFail(note.id)).body).toBe('b');
    });

    it('LucidDataKeyStore: current, retire, guarded rewrap, delete and paging', async () => {
      const at = (n: number) => `2026-01-01T00:00:0${n}.000Z`;
      await store.insert({ id: 'a'.repeat(32), key: 'k1', wrapped: 'w1', createdAt: at(1) });
      await store.insert({ id: 'b'.repeat(32), key: 'k1', wrapped: 'w2', createdAt: at(2) });
      await store.insert({ id: 'c'.repeat(32), key: 'k2', wrapped: 'w3', createdAt: at(3) });
      expect((await store.current('k1'))?.id).toBe('b'.repeat(32));
      expect(await store.retire('k1', at(4))).toBe(2);
      expect(await store.current('k1')).toBeNull();
      expect((await store.get('a'.repeat(32)))?.retiredAt).toBe(at(4));
      expect(await store.updateWrapped('c'.repeat(32), 'stale', 'x')).toBe(false);
      expect(await store.updateWrapped('c'.repeat(32), 'w3', 'w4')).toBe(true);
      expect((await store.get('c'.repeat(32)))?.wrapped).toBe('w4');
      expect((await store.page({ limit: 2 })).map((row) => row.id[0])).toEqual(['a', 'b']);
      expect((await store.page({ limit: 2, after: 'b'.repeat(32) })).map((r) => r.key)).toEqual([
        'k2',
      ]);
      expect((await store.page({ limit: 5, key: 'k2' })).length).toBe(1);
      expect(await store.deleteKey('k1')).toBe(2);
      expect(await store.get('a'.repeat(32))).toBeNull();
    });

    it('follows a Lucid global transaction (test utils) when the store resolves per query', async () => {
      const crypto = memoryCrypto();
      const resolved = new LucidDataKeyStore(() => {
        const conn = database.connection() as unknown as SqlDatabase;
        return dialect === 'postgres' ? inSchema(conn, schema) : conn;
      });
      subjects = new SubjectKeys({
        operations: localOperations(crypto.service, crypto.principal),
        store: resolved,
      });
      await database.beginGlobalTransaction();
      try {
        const note = await Note.create({ id: randomUUID(), researcherId: 5, body: 'in trx' });
        subjects.clear();
        expect((await Note.findOrFail(note.id)).body).toBe('in trx');
      } finally {
        await database.rollbackGlobalTransaction();
      }
      expect(await raw(`SELECT * FROM ${table('notes')}`)).toEqual([]);
      expect(await raw(`SELECT * FROM ${table('crypto_data_keys')}`)).toEqual([]);
    });

    it('backfill refuses unknown columns', async () => {
      await expect(
        backfillEncryptedColumns(Note as unknown as BackfillModel, { columns: ['nope'] }),
      ).rejects.toThrow(/no encrypted column/);
    });
  });
}
