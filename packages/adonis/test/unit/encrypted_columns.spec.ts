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
import { encrypted, SealedValue, UNDECRYPTABLE_EXTRA } from '../../src/subjects/lucid.js';
import { addEncryptedColumnCheck, encryptedColumnCheck } from '../../src/subjects/migration.js';
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

/** Bound to a mutable `slug`, namespaced, nulls what it cannot open. */
class Doc extends BaseModel {
  static override table = 'docs';
  static override selfAssignPrimaryKey = true;

  @column({ isPrimary: true })
  declare id: string;

  @column()
  declare slug: string;

  @column()
  declare researcherId: number;

  @encrypted({
    subject: (doc: Doc) => doc.researcherId,
    namespace: 'researcher',
    row: (doc: Doc) => doc.slug,
    onUndecryptable: 'null',
    using: () => subjects,
  })
  declare body: string | null;
}

/** Legacy reads with a per-row cutoff and a counter. */
let legacySeen: string[] = [];
class CutoffNote extends BaseModel {
  static override table = 'notes';
  static override selfAssignPrimaryKey = true;

  @column({ isPrimary: true })
  declare id: string;

  @column()
  declare researcherId: number;

  @column()
  declare title: string;

  @encrypted({
    subject: (note: CutoffNote) => note.researcherId,
    legacyPlaintext: (note: CutoffNote) => note.title === 'old',
    onLegacyRead: (note: CutoffNote, attribute) => void legacySeen.push(`${note.id}.${attribute}`),
    using: () => subjects,
  })
  declare body: string | null;
}

class JsonbNote extends BaseModel {
  static override table = 'jsonb_notes';
  static override selfAssignPrimaryKey = true;

  @column({ isPrimary: true })
  declare id: string;

  @column()
  declare researcherId: number;

  @encrypted({
    subject: (row: JsonbNote) => row.researcherId,
    json: true,
    legacyPlaintext: true,
    using: () => subjects,
  })
  declare answers: unknown;
}

/** A table guarded by the CHECK constraint helper. */
class Guarded extends BaseModel {
  static override table = 'guarded';
  static override selfAssignPrimaryKey = true;

  @column({ isPrimary: true })
  declare id: string;

  @column()
  declare researcherId: number;

  @encrypted({ subject: (row: Guarded) => row.researcherId, using: () => subjects })
  declare body: string | null;
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
      await database.rawQuery(
        `CREATE TABLE ${table('docs')} (id varchar(36) PRIMARY KEY, slug text NOT NULL, researcher_id integer NOT NULL, body text NULL)`,
      );
      const check = encryptedColumnCheck({
        column: 'body',
        subjectColumn: 'researcher_id',
        dialect,
      });
      if (dialect === 'sqlite') {
        await database.rawQuery(
          `CREATE TABLE guarded (id varchar(36) PRIMARY KEY, researcher_id integer NOT NULL, body text NULL, CHECK ${check})`,
        );
        await database.rawQuery(
          `CREATE TABLE guarded_nullable (id varchar(36) PRIMARY KEY, researcher_id integer NULL, body text NULL, CHECK ${check})`,
        );
      } else {
        await database.rawQuery(
          `CREATE TABLE ${table('guarded')} (id varchar(36) PRIMARY KEY, researcher_id integer NOT NULL, body text NULL)`,
        );
        // Schema-qualified: nothing here depends on search_path.
        await database.rawQuery(
          addEncryptedColumnCheck({
            table: `${schema}.guarded`,
            column: 'body',
            subjectColumn: 'researcher_id',
            dialect,
          }),
        );
        await database.rawQuery(
          `CREATE TABLE ${table('guarded_nullable')} (id varchar(36) PRIMARY KEY, researcher_id integer NULL, body text NULL)`,
        );
        await database.rawQuery(
          addEncryptedColumnCheck({
            table: 'guarded_nullable',
            schema,
            column: 'body',
            subjectColumn: 'researcher_id',
            dialect,
          }),
        );
      }
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
        requireType: false,
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
      await database.rawQuery(`DELETE FROM ${table('docs')}`);
      await database.rawQuery(`DELETE FROM ${table('guarded')}`);
      await database.rawQuery(`DELETE FROM ${table('guarded_nullable')}`);
      legacySeen = [];
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
      await expect(note.saveQuietly()).rejects.toThrow(/without a matching encryption/);
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
        requireType: false,
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

    it('refuses to move a partly-loaded row to another subject (the unloaded value would stay with the old owner)', async () => {
      const note = await Note.create({ id: randomUUID(), researcherId: 1, title: 't', body: 'b' });
      const partial = await Note.query()
        .select('id', 'researcher_id', 'title')
        .where('id', note.id)
        .firstOrFail();
      partial.researcherId = 2;
      await expect(partial.save()).rejects.toThrow(/not loaded/);
      const [row] = await raw(`SELECT researcher_id FROM ${table('notes')} WHERE id = ?`, [
        note.id,
      ]);
      expect(Number(row!.researcher_id)).toBe(1);
      // A partial row whose subject does not change saves normally.
      partial.researcherId = 1;
      partial.title = 'renamed';
      await partial.save();
      expect((await Note.findOrFail(note.id)).body).toBe('b');
    });

    it('a CHECK constraint stops query-builder writes of plaintext or of another subject', async () => {
      const id = randomUUID();
      await expect(
        database.rawQuery(
          `INSERT INTO ${table('guarded')} (id, researcher_id, body) VALUES (?, 1, 'plain')`,
          [id],
        ),
      ).rejects.toThrow();
      const row = await Guarded.create({ id, researcherId: 1, body: 'sealed' });
      await expect(
        Guarded.query().where('id', id).update({ body: 'plain again' }),
      ).rejects.toThrow();
      // Moving the row to another subject behind the model's back is refused too.
      await expect(Guarded.query().where('id', id).update({ researcher_id: 2 })).rejects.toThrow();
      // An underscore in the id is a literal, not a wildcard: subject 1 never matches subject 11.
      await expect(Guarded.query().where('id', id).update({ researcher_id: 11 })).rejects.toThrow();
      expect((await Guarded.findOrFail(row.id)).body).toBe('sealed');
      const moved = await Guarded.findOrFail(row.id);
      moved.researcherId = 2;
      await moved.save();
      expect((await Guarded.findOrFail(row.id)).body).toBe('sealed');
    });

    it('legacyPlaintext never treats another agora ciphertext as plaintext, honours a cutoff and counts reads', async () => {
      const ct1 = randomUUID();
      await database.rawQuery(
        `INSERT INTO ${table('notes')} (id, researcher_id, title, body) VALUES (?, 1, 'old', 'agora:ct1:pii:1:abc')`,
        [ct1],
      );
      await expect(LegacyNote.findOrFail(ct1)).rejects.toThrow(/another kind of agora ciphertext/);
      const oldRow = randomUUID();
      const newRow = randomUUID();
      await database.rawQuery(
        `INSERT INTO ${table('notes')} (id, researcher_id, title, body) VALUES (?, 1, 'old', 'before cutoff'), (?, 1, 'new', 'after cutoff')`,
        [oldRow, newRow],
      );
      expect((await CutoffNote.findOrFail(oldRow)).body).toBe('before cutoff');
      expect(legacySeen).toEqual([`${oldRow}.body`]);
      await expect(CutoffNote.findOrFail(newRow)).rejects.toThrow(/not encrypted/);
    });

    it("onUndecryptable: 'null' keeps a listing working when one subject was forgotten", async () => {
      await Doc.create({ id: randomUUID(), slug: 'a', researcherId: 1, body: 'gone soon' });
      await Doc.create({ id: randomUUID(), slug: 'b', researcherId: 2, body: 'stays' });
      await subjects.forget({ type: 'researcher', id: 1 });
      const docs = await Doc.query().orderBy('slug', 'asc');
      expect(docs.map((doc) => doc.body)).toEqual([null, 'stays']);
      expect(docs[0]!.$extras[UNDECRYPTABLE_EXTRA]).toEqual(['body']);
      expect(docs[0]!.$isDirty).toBe(false);
      // An outage still throws: null is only for values that are gone or wrong.
      subjects.clear();
      down = true;
      await expect(Doc.query()).rejects.toThrow(/unavailable/);
    });

    it('namespaces keep researcher 7 and project 7 apart', async () => {
      const doc = await Doc.create({ id: randomUUID(), slug: 'n', researcherId: 7, body: 'x' });
      const [row] = await raw(`SELECT body FROM ${table('docs')} WHERE id = ?`, [doc.id]);
      expect(String(row!.body).startsWith('agora:se1:subject_researcher_7:')).toBe(true);
    });

    it('re-seals when the row binding changes, and refuses it on a partly-loaded row', async () => {
      const doc = await Doc.create({
        id: randomUUID(),
        slug: 'first',
        researcherId: 3,
        body: 'bound',
      });
      const loaded = await Doc.findOrFail(doc.id);
      loaded.slug = 'second';
      await loaded.save();
      expect((await Doc.findOrFail(doc.id)).body).toBe('bound');
      const partial = await Doc.query()
        .select('id', 'slug', 'researcher_id')
        .where('id', doc.id)
        .firstOrFail();
      partial.slug = 'third';
      await expect(partial.save()).rejects.toThrow(/not loaded/);
    });

    it('saveQuietly after a failed save cannot write a ciphertext bound to the old id', async () => {
      const note = new Note();
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      note.merge({
        id: randomUUID(),
        researcherId: 1,
        title: 't',
        body: 'secret',
        answers: circular,
      });
      await expect(note.save()).rejects.toThrow();
      note.answers = null;
      note.id = randomUUID();
      await expect(note.saveQuietly()).rejects.toThrow(/without a matching encryption/);
      expect(await raw(`SELECT * FROM ${table('notes')}`)).toEqual([]);
      // A normal save afterwards works and binds to the new id.
      await note.save();
      expect((await Note.findOrFail(note.id)).body).toBe('secret');
    });

    it('row: false needs the subject column to read', async () => {
      const survey = await Survey.create({ researcherId: 3, notes: 'n' });
      await expect(
        Survey.query().select('id', 'notes').where('id', survey.id).firstOrFail(),
      ).rejects.toThrow(/select the subject column/);
    });

    it('updateOrCreate and firstOrCreate work (warm the subject first on SQLite)', async () => {
      await subjects.warm(9);
      const id = randomUUID();
      const created = await Note.updateOrCreate({ id }, { researcherId: 9, body: 'v1' });
      expect(created.body).toBe('v1');
      const updated = await Note.updateOrCreate({ id }, { researcherId: 9, body: 'v2' });
      expect(updated.body).toBe('v2');
      const found = await Note.firstOrCreate({ id }, { researcherId: 9, body: 'ignored' });
      expect(found.body).toBe('v2');
      await database.transaction(async (trx) => {
        const inTrx = await Note.findOrFail(id, { client: trx });
        inTrx.body = 'v3';
        await inTrx.useTransaction(trx).save();
      });
      expect((await Note.findOrFail(id)).body).toBe('v3');
    });

    it('backfill skips bad rows when asked, refuses other agora ciphertext and re-seals moved values loudly', async () => {
      const good = '10000000-0000-4000-8000-000000000001';
      const badJson = '10000000-0000-4000-8000-000000000002';
      const ct1 = '10000000-0000-4000-8000-000000000003';
      const moved = '10000000-0000-4000-8000-000000000004';
      await database.rawQuery(
        `INSERT INTO ${table('notes')} (id, researcher_id, title, body, answers) VALUES (?, 1, 't', 'fine', '{"a":1}'), (?, 1, 't', 'fine', '{not json'), (?, 1, 't', 'agora:ct1:pii:1:abc', NULL)`,
        [good, badJson, ct1],
      );
      const note = await Note.create({ id: moved, researcherId: 1, body: 'mine' });
      await database.rawQuery(`UPDATE ${table('notes')} SET researcher_id = 2 WHERE id = ?`, [
        note.id,
      ]);

      await expect(
        backfillEncryptedColumns(LegacyNote as unknown as BackfillModel),
      ).rejects.toThrow(SubjectKeyError);
      const result = await backfillEncryptedColumns(LegacyNote as unknown as BackfillModel, {
        onError: 'skip',
      });
      expect(result.failed).toBe(2);
      // Sealed for another subject: reported, left alone until someone adopts it explicitly.
      expect(result).toMatchObject({ moved: 1, adopted: 0 });
      await expect(Note.findOrFail(moved)).rejects.toThrow(/another subject/);
      const adopted = await backfillEncryptedColumns(LegacyNote as unknown as BackfillModel, {
        onError: 'skip',
        adoptMoved: true,
      });
      expect(adopted).toMatchObject({ moved: 1, adopted: 1 });
      expect(result.failures.map((f) => `${f.id}:${f.attribute}:${f.code}`).sort()).toEqual([
        `${badJson}:answers:invalid`,
        `${ct1}:body:invalid`,
      ]);
      expect(JSON.stringify(result.failures)).not.toContain('not json');
      expect((await Note.findOrFail(moved)).body).toBe('mine');
      const [row] = await raw(`SELECT body FROM ${table('notes')} WHERE id = ?`, [ct1]);
      expect(row!.body).toBe('agora:ct1:pii:1:abc');
    });

    it('backfill with row: false refuses to adopt a value sealed for another subject', async () => {
      const survey = await Survey.create({ researcherId: 1, notes: 'n' });
      await database.rawQuery(`UPDATE ${table('surveys')} SET researcher_id = 2 WHERE id = ?`, [
        survey.id,
      ]);
      const result = await backfillEncryptedColumns(Survey as unknown as BackfillModel, {
        onError: 'skip',
      });
      expect(result).toMatchObject({ moved: 1, adopted: 0, failed: 0 });
      const adopting = await backfillEncryptedColumns(Survey as unknown as BackfillModel, {
        onError: 'skip',
        adoptMoved: true,
      });
      expect(adopting).toMatchObject({ adopted: 0, failed: 1 });
      expect(adopting.failures[0]!.message).toMatch(/no row binding/);
    });

    it.skipIf(dialect !== 'postgres')(
      'backfill refuses a jsonb column instead of guessing',
      async () => {
        await database.rawQuery(
          `CREATE TABLE ${table('jsonb_notes')} (id varchar(36) PRIMARY KEY, researcher_id integer NOT NULL, answers jsonb NULL)`,
        );
        await database.rawQuery(
          `INSERT INTO ${table('jsonb_notes')} (id, researcher_id, answers) VALUES (?, 1, '{"a":1}')`,
          [randomUUID()],
        );
        const result = await backfillEncryptedColumns(JsonbNote as unknown as BackfillModel, {
          onError: 'skip',
        });
        expect(result.failed).toBe(1);
        expect(result.failures[0]!.message).toMatch(/not stored as text/);
      },
    );

    it('the CHECK refuses a value on a row whose subject is NULL, and refuses upper-case prefixes', async () => {
      await expect(
        database.rawQuery(
          `INSERT INTO ${table('guarded_nullable')} (id, researcher_id, body) VALUES (?, NULL, 'PLAINTEXT SECRET')`,
          [randomUUID()],
        ),
      ).rejects.toThrow();
      await expect(
        database.rawQuery(
          `INSERT INTO ${table('guarded_nullable')} (id, researcher_id, body) VALUES (?, NULL, 'agora:se1:subject_1:x')`,
          [randomUUID()],
        ),
      ).rejects.toThrow();
      await database.rawQuery(
        `INSERT INTO ${table('guarded_nullable')} (id, researcher_id, body) VALUES (?, NULL, NULL)`,
        [randomUUID()],
      );
      for (const value of [
        'AGORA:SE1:plaintext',
        'agora:se1:SUBJECT_1:x',
        'Agora:se1:subject_1:x',
      ]) {
        await expect(
          database.rawQuery(
            `INSERT INTO ${table('guarded')} (id, researcher_id, body) VALUES (?, 1, ?)`,
            [randomUUID(), value],
          ),
        ).rejects.toThrow();
      }
    });

    it('an upper-case AGORA: prefix is never served as legacy plaintext nor encrypted by the backfill', async () => {
      const id = randomUUID();
      await database.rawQuery(
        `INSERT INTO ${table('notes')} (id, researcher_id, title, body) VALUES (?, 1, 't', 'AGORA:SE1:injected')`,
        [id],
      );
      await expect(LegacyNote.findOrFail(id)).rejects.toThrow(/another kind of agora ciphertext/);
      const result = await backfillEncryptedColumns(LegacyNote as unknown as BackfillModel, {
        onError: 'skip',
        columns: ['body'],
      });
      expect(result.failed).toBe(1);
      const [row] = await raw(`SELECT body FROM ${table('notes')} WHERE id = ?`, [id]);
      expect(row!.body).toBe('AGORA:SE1:injected');
    });

    it('onUndecryptable: null covers forgotten only; invalid needs an explicit opt-in; every failure is reported', async () => {
      const seen: string[] = [];
      class Strict extends BaseModel {
        static override table = 'docs';
        static override selfAssignPrimaryKey = true;
        @column({ isPrimary: true }) declare id: string;
        @column() declare slug: string;
        @column() declare researcherId: number;
        @encrypted({
          subject: (doc: Strict) => doc.researcherId,
          namespace: 'researcher',
          row: (doc: Strict) => doc.slug,
          onUndecryptable: 'null',
          onUndecryptableError: (_doc, attribute, error) =>
            void seen.push(`${attribute}:${error.code}`),
          using: () => subjects,
        })
        declare body: string | null;
      }
      class Lenient extends BaseModel {
        static override table = 'docs';
        static override selfAssignPrimaryKey = true;
        @column({ isPrimary: true }) declare id: string;
        @column() declare slug: string;
        @column() declare researcherId: number;
        @encrypted({
          subject: (doc: Lenient) => doc.researcherId,
          namespace: 'researcher',
          row: (doc: Lenient) => doc.slug,
          onUndecryptable: { null: ['forgotten', 'invalid'] },
          using: () => subjects,
        })
        declare body: string | null;
      }
      const a = await Doc.create({ id: randomUUID(), slug: 'a', researcherId: 1, body: 'A' });
      const b = await Doc.create({ id: randomUUID(), slug: 'b', researcherId: 1, body: 'B' });
      // Swap a's ciphertext into b: tampering, not forgetting.
      const [rowA] = await raw(`SELECT body FROM ${table('docs')} WHERE id = ?`, [a.id]);
      await database.rawQuery(`UPDATE ${table('docs')} SET body = ? WHERE id = ?`, [
        rowA!.body,
        b.id,
      ]);
      await expect(Strict.findOrFail(b.id)).rejects.toThrow(SubjectKeyError);
      expect(seen).toEqual(['body:invalid']);
      const lenient = await Lenient.findOrFail(b.id);
      expect(lenient.body).toBeNull();
      expect(lenient.$extras[UNDECRYPTABLE_EXTRA]).toEqual(['body']);
    });

    it('a value nulled by onUndecryptable cannot be saved back as null by accident', async () => {
      const doc = await Doc.create({ id: randomUUID(), slug: 'z', researcherId: 1, body: 'kept' });
      await subjects.forget({ type: 'researcher', id: 1 });
      const loaded = await Doc.findOrFail(doc.id);
      expect(loaded.body).toBeNull();
      // fill() drops the attribute, which Lucid writes as NULL: refused.
      loaded.fill({ id: doc.id, slug: 'z', researcherId: 1 });
      await expect(loaded.save()).rejects.toThrow(/would destroy the stored value/);
      const [row] = await raw(`SELECT body FROM ${table('docs')} WHERE id = ?`, [doc.id]);
      expect(String(row!.body).startsWith('agora:se1:')).toBe(true);
      // Saving other columns without touching it is fine.
      const again = await Doc.findOrFail(doc.id);
      again.slug = 'z';
      await again.save();
    });

    it('--skip-errors still stops on an outage', async () => {
      await database.rawQuery(
        `INSERT INTO ${table('notes')} (id, researcher_id, title, body) VALUES (?, 1, 't', 'plain')`,
        [randomUUID()],
      );
      down = true;
      await expect(
        backfillEncryptedColumns(LegacyNote as unknown as BackfillModel, { onError: 'skip' }),
      ).rejects.toThrow(/unavailable/);
    });

    it('backfill refuses unknown columns', async () => {
      await expect(
        backfillEncryptedColumns(Note as unknown as BackfillModel, { columns: ['nope'] }),
      ).rejects.toThrow(/no encrypted column/);
    });
  });
}
