import { dialectOf, query, type SqlClient } from '../sql.js';

/** One wrapped data key, as the app stores it. Never holds the plaintext key. */
export interface DataKeyRecord {
  /** 32 lowercase hex characters; named by every ciphertext sealed with this data key. */
  id: string;
  /** The subject key on the control plane that wraps it. */
  key: string;
  /** `agora:ct1:<key>:<version>:…`: the data key encrypted under the subject key. */
  wrapped: string;
  createdAt: string;
  /** Set once a newer data key replaced it for writes; it still opens what it sealed. */
  retiredAt?: string;
}

/** Where an app keeps its wrapped data keys (its own database, by default). */
export interface DataKeyStore {
  setup?(): Promise<void>;
  insert(record: DataKeyRecord): Promise<void>;
  get(id: string): Promise<DataKeyRecord | null>;
  /** The newest data key of a subject key that is not retired. */
  current(key: string): Promise<DataKeyRecord | null>;
  /** Retires every active data key of a subject key; returns how many. */
  retire(key: string, at: string): Promise<number>;
  /** Replaces the wrapped form (after a rewrap under a newer subject-key version). */
  updateWrapped(id: string, from: string, to: string): Promise<boolean>;
  /** Deletes every data key of a subject key; returns how many. */
  deleteKey(key: string): Promise<number>;
  /** Data keys ordered by id, after `cursor`, optionally of one subject key. */
  page(options: { after?: string; limit: number; key?: string }): Promise<DataKeyRecord[]>;
}

/** The data keys in memory: tests and local development. */
export class MemoryDataKeyStore implements DataKeyStore {
  readonly #rows = new Map<string, DataKeyRecord>();

  async insert(record: DataKeyRecord): Promise<void> {
    if (this.#rows.has(record.id)) throw new Error(`crypto: data key ${record.id} already exists`);
    this.#rows.set(record.id, { ...record });
  }

  async get(id: string): Promise<DataKeyRecord | null> {
    const row = this.#rows.get(id);
    return row ? { ...row } : null;
  }

  async current(key: string): Promise<DataKeyRecord | null> {
    let best: DataKeyRecord | undefined;
    for (const row of this.#rows.values()) {
      if (row.key !== key || row.retiredAt !== undefined) continue;
      if (
        !best ||
        row.createdAt > best.createdAt ||
        (row.createdAt === best.createdAt && row.id > best.id)
      ) {
        best = row;
      }
    }
    return best ? { ...best } : null;
  }

  async retire(key: string, at: string): Promise<number> {
    let count = 0;
    for (const row of this.#rows.values()) {
      if (row.key === key && row.retiredAt === undefined) {
        row.retiredAt = at;
        count += 1;
      }
    }
    return count;
  }

  async updateWrapped(id: string, from: string, to: string): Promise<boolean> {
    const row = this.#rows.get(id);
    if (!row || row.wrapped !== from) return false;
    row.wrapped = to;
    return true;
  }

  async deleteKey(key: string): Promise<number> {
    let count = 0;
    for (const [id, row] of this.#rows) {
      if (row.key === key) {
        this.#rows.delete(id);
        count += 1;
      }
    }
    return count;
  }

  async page(options: { after?: string; limit: number; key?: string }): Promise<DataKeyRecord[]> {
    return [...this.#rows.values()]
      .filter((row) => options.key === undefined || row.key === options.key)
      .filter((row) => options.after === undefined || row.id > options.after)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, options.limit)
      .map((row) => ({ ...row }));
  }
}

interface DataKeyRow {
  id: string;
  key_name: string;
  wrapped: string;
  created_at: string;
  retired_at: string | null;
}

const COLUMNS = 'id, key_name, wrapped, created_at, retired_at';

function recordOf(row: DataKeyRow): DataKeyRecord {
  return {
    id: row.id,
    key: row.key_name,
    wrapped: row.wrapped,
    createdAt: row.created_at,
    ...(row.retired_at !== null && row.retired_at !== undefined
      ? { retiredAt: row.retired_at }
      : {}),
  };
}

function affected(result: unknown): number {
  if (Array.isArray(result)) {
    // mysql2 through knex: [ResultSetHeader, fields]
    const header = result[0] as { affectedRows?: number } | undefined;
    if (header && typeof header.affectedRows === 'number') return header.affectedRows;
    return 0;
  }
  const value = result as { rowCount?: number; changes?: number; affectedRows?: number } | null;
  return value?.rowCount ?? value?.changes ?? value?.affectedRows ?? 0;
}

/**
 * The data keys in the app's database (`crypto_data_keys`), through Lucid: Postgres, MySQL or
 * SQLite. One small row per data key, shared by every value it sealed, so a value carries only the
 * data key's id and rewrapping a subject key touches this table, never the data.
 */
export class LucidDataKeyStore implements DataKeyStore {
  readonly #client: () => SqlClient;

  /**
   * `db` is a client, or a function that returns one per query — so a Lucid global transaction
   * (`testUtils.db().withGlobalTransaction()`) is picked up, since `db.connection()` returns it.
   */
  constructor(
    db: SqlClient | (() => SqlClient),
    private readonly options: { autoCreateSchema?: boolean } = {},
  ) {
    this.#client = typeof db === 'function' ? db : () => db;
    dialectOf(this.#client());
  }

  get db(): SqlClient {
    return this.#client();
  }

  async setup(): Promise<void> {
    if (this.options.autoCreateSchema === false) return;
    await query(
      this.db,
      `CREATE TABLE IF NOT EXISTS crypto_data_keys (
      id varchar(32) NOT NULL PRIMARY KEY,
      key_name varchar(64) NOT NULL,
      wrapped text NOT NULL,
      created_at varchar(32) NOT NULL,
      retired_at varchar(32) NULL
    )`,
    );
    try {
      await query(
        this.db,
        'CREATE INDEX crypto_data_keys_key_name ON crypto_data_keys (key_name, created_at)',
      );
    } catch (error) {
      if (!/exist|duplicate/i.test((error as Error).message)) throw error;
    }
  }

  async insert(record: DataKeyRecord): Promise<void> {
    await query(this.db, `INSERT INTO crypto_data_keys (${COLUMNS}) VALUES (?, ?, ?, ?, ?)`, [
      record.id,
      record.key,
      record.wrapped,
      record.createdAt,
      record.retiredAt ?? null,
    ]);
  }

  async get(id: string): Promise<DataKeyRecord | null> {
    const rows = await query<DataKeyRow>(
      this.db,
      `SELECT ${COLUMNS} FROM crypto_data_keys WHERE id = ? LIMIT 1`,
      [id],
    );
    return rows[0] ? recordOf(rows[0]) : null;
  }

  async current(key: string): Promise<DataKeyRecord | null> {
    const rows = await query<DataKeyRow>(
      this.db,
      `SELECT ${COLUMNS} FROM crypto_data_keys WHERE key_name = ? AND retired_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`,
      [key],
    );
    return rows[0] ? recordOf(rows[0]) : null;
  }

  async retire(key: string, at: string): Promise<number> {
    return affected(
      await this.db.rawQuery(
        'UPDATE crypto_data_keys SET retired_at = ? WHERE key_name = ? AND retired_at IS NULL',
        [at, key],
      ),
    );
  }

  async updateWrapped(id: string, from: string, to: string): Promise<boolean> {
    return (
      affected(
        await this.db.rawQuery(
          'UPDATE crypto_data_keys SET wrapped = ? WHERE id = ? AND wrapped = ?',
          [to, id, from],
        ),
      ) > 0
    );
  }

  async deleteKey(key: string): Promise<number> {
    return affected(
      await this.db.rawQuery('DELETE FROM crypto_data_keys WHERE key_name = ?', [key]),
    );
  }

  async page(options: { after?: string; limit: number; key?: string }): Promise<DataKeyRecord[]> {
    const where: string[] = [];
    const bindings: unknown[] = [];
    if (options.key !== undefined) {
      where.push('key_name = ?');
      bindings.push(options.key);
    }
    if (options.after !== undefined) {
      where.push('id > ?');
      bindings.push(options.after);
    }
    const limit = Math.max(1, Math.min(10_000, Math.floor(options.limit)));
    const rows = await query<DataKeyRow>(
      this.db,
      `SELECT ${COLUMNS} FROM crypto_data_keys${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id ASC LIMIT ${limit}`,
      bindings,
    );
    return rows.map(recordOf);
  }
}
