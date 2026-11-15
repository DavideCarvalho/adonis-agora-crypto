import { describe, expect, it } from 'vitest';
import {
  assertSchemaName,
  dialectOf,
  inSchema,
  qualifyTables,
  type SqlDatabase,
  schemaOf,
} from '../../src/sql.js';

describe('schema qualification', () => {
  it('qualifies every table this package owns, in DDL and in queries', () => {
    expect(
      qualifyTables('CREATE TABLE IF NOT EXISTS crypto_keys (app varchar)', 'billing', 'postgres'),
    ).toBe('CREATE TABLE IF NOT EXISTS "billing".crypto_keys (app varchar)');

    expect(
      qualifyTables(
        'SELECT app, name FROM crypto_key_versions WHERE app = ?',
        'billing',
        'postgres',
      ),
    ).toBe('SELECT app, name FROM "billing".crypto_key_versions WHERE app = ?');

    expect(qualifyTables('DELETE FROM crypto_audit WHERE app = ?', 'billing', 'postgres')).toBe(
      'DELETE FROM "billing".crypto_audit WHERE app = ?',
    );
  });

  it('does not touch another lib’s tables, nor the index name', () => {
    // `crypto_audit_app_at` is a different identifier (the regex must not eat it), and a table this
    // package does not own stays exactly as it was.
    expect(
      qualifyTables(
        'CREATE INDEX crypto_audit_app_at ON crypto_audit (app, at)',
        'billing',
        'postgres',
      ),
    ).toBe('CREATE INDEX crypto_audit_app_at ON "billing".crypto_audit (app, at)');

    expect(qualifyTables('SELECT * FROM config_versions', 'billing', 'postgres')).toBe(
      'SELECT * FROM config_versions',
    );
  });

  it('uses backticks on MySQL', () => {
    expect(qualifyTables('SELECT * FROM crypto_keys', 'billing', 'mysql')).toBe(
      'SELECT * FROM `billing`.crypto_keys',
    );
  });

  it('refuses a schema name that would open SQL injection', () => {
    expect(() => assertSchemaName('billing" ; drop schema public')).toThrow(/invalid schema/);
    expect(() => assertSchemaName('9lives')).toThrow(/invalid schema/);
    expect(() => assertSchemaName('billing_v2')).not.toThrow();
  });
});

describe('inSchema', () => {
  function fakeDb(): { db: SqlDatabase; seen: string[] } {
    const seen: string[] = [];
    const db: SqlDatabase = {
      dialect: { name: 'postgres' },
      async rawQuery(sql) {
        seen.push(sql);
        return [];
      },
      async transaction(callback) {
        const trx = {
          dialect: { name: 'postgres' },
          async rawQuery(sql: string) {
            seen.push(`trx:${sql}`);
            return [];
          },
        };
        return callback(trx);
      },
    };
    return { db, seen };
  }

  it('qualifies every query and every transaction inside it', async () => {
    const { db, seen } = fakeDb();
    const scoped = inSchema(db, 'billing');

    await scoped.rawQuery('SELECT * FROM crypto_keys');
    await scoped.transaction(async (trx) => {
      await trx.rawQuery('SELECT * FROM crypto_key_versions');
    });

    expect(seen).toEqual([
      'SELECT * FROM "billing".crypto_keys',
      'trx:SELECT * FROM "billing".crypto_key_versions',
    ]);
    expect(schemaOf(scoped)).toBe('billing');
  });

  it('returns the same client when no schema is configured', () => {
    const { db } = fakeDb();
    expect(inSchema(db, undefined)).toBe(db);
  });

  it('refuses SQLite, where a schema is not a namespace', () => {
    const sqlite: SqlDatabase = {
      dialect: { name: 'sqlite' },
      async rawQuery() {
        return [];
      },
      async transaction(callback) {
        return callback(sqlite);
      },
    };
    expect(() => inSchema(sqlite, 'billing')).toThrow(/Postgres or MySQL/);
  });

  it('reports the dialect it cannot handle', () => {
    expect(() => dialectOf({ rawQuery: async () => [], dialect: { name: 'oracle' } })).toThrow(
      /unsupported database dialect/,
    );
  });
});
