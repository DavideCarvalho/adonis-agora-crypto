import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CryptoService } from '../../src/crypto/service.js';
import { inSchema, type SqlClient, type SqlDatabase } from '../../src/sql.js';
import { LucidStore } from '../../src/store/lucid_store.js';
import { testKeyring } from '../../src/testing/index.js';

/**
 * The `schema` option against a real Postgres, in a schema that is **not** `public` and not in the
 * connection's `search_path`: every statement this package sends names its table as
 * `"<schema>".crypto_*`, so nothing depends on `search_path` (safe behind PgBouncer in transaction
 * mode). Skipped unless `CRYPTO_TEST_PG_URL` is set; CI provides a Postgres service.
 */
const url = process.env.CRYPTO_TEST_PG_URL;
const maybe = url ? describe : describe.skip;

const SCHEMA = `crypto_test_${randomBytes(4).toString('hex')}`;

/**
 * The store writes Lucid-style `?` placeholders (Lucid/knex rewrites them per driver); talking to
 * `pg` directly means doing that rewrite here, exactly as knex does for Postgres.
 */
function placeholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}
const PRINCIPAL = { partition: 'shop', capabilities: ['crypto:*'], actor: 'test' };

maybe('schema on a real Postgres', () => {
  let pool: Pool;
  let service: CryptoService;
  let client: SqlDatabase;

  beforeAll(async () => {
    // A search_path that deliberately does NOT include the schema: if any statement relied on it,
    // the table would not be found (and nothing runs `SET`, which PgBouncer's transaction mode
    // would not keep anyway).
    pool = new Pool({ connectionString: url, options: '-c search_path=public' });
    client = {
      dialect: { name: 'postgres' },
      rawQuery: (sql, bindings) => pool.query(placeholders(sql), bindings as unknown[]),
      transaction: async (callback) => {
        const connection = await pool.connect();
        try {
          await connection.query('BEGIN');
          const trx: SqlClient = {
            dialect: { name: 'postgres' },
            rawQuery: (sql, bindings) => connection.query(placeholders(sql), bindings as unknown[]),
          };
          const result = await callback(trx);
          await connection.query('COMMIT');
          return result;
        } catch (error) {
          await connection.query('ROLLBACK');
          throw error;
        } finally {
          connection.release();
        }
      },
    };

    await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
    const store = new LucidStore(inSchema(client, SCHEMA), { autoCreateSchema: true });
    await store.setup();
    service = new CryptoService({ store, keyring: testKeyring() });
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await pool?.end();
  });

  it('creates the tables in the configured schema, never in public', async () => {
    const { rows } = await pool.query<{ table_schema: string; table_name: string }>(
      "SELECT table_schema, table_name FROM information_schema.tables WHERE table_name LIKE 'crypto\\_%'",
    );
    const inSchemaRows = rows
      .filter((row) => row.table_schema === SCHEMA)
      .map((row) => row.table_name)
      .sort();
    expect(inSchemaRows).toEqual(['crypto_audit', 'crypto_key_versions', 'crypto_keys']);
    expect(rows.filter((row) => row.table_schema === 'public')).toEqual([]);
  });

  it('reads and writes keys and the audit trail through the schema', async () => {
    const created = await service.createKey(PRINCIPAL, {
      name: 'orders',
      type: 'aes256-gcm',
      deletionAllowed: true,
    });
    expect(created.name).toBe('orders');

    const { ciphertext } = await service.encrypt(PRINCIPAL, {
      key: 'orders',
      plaintext: 'in a schema',
    });
    const { plaintext } = await service.decrypt(PRINCIPAL, { key: 'orders', ciphertext });
    expect(plaintext).toBe('in a schema');

    const audit = await service.audit(PRINCIPAL, { page: 1, size: 10 });
    expect(audit.data.some((row) => row.key === 'orders' && row.operation === 'encrypt')).toBe(
      true,
    );

    // Read straight from the schema, bypassing the store: the rows are there, in that schema.
    const keys = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM "${SCHEMA}".crypto_keys`,
    );
    expect(Number(keys.rows[0]!.count)).toBe(1);
    const audited = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM "${SCHEMA}".crypto_audit`,
    );
    expect(Number(audited.rows[0]!.count)).toBeGreaterThan(0);
  });

  it('rotates and deletes inside the schema (transactions)', async () => {
    const rotated = await service.rotateKey(PRINCIPAL, 'orders');
    expect(rotated.latestVersion).toBe(2);

    const deleted = await service.deleteKey(PRINCIPAL, 'orders');
    expect(deleted.deleted).toBe(true);
  });
});
