import type {
  CryptoAuditRecord,
  CryptoKeyType,
  OffsetPage,
  PublicJwk,
} from '@adonis-agora/crypto-core';
import { dialectOf, jsonValue, parseJson, query, type SqlDatabase, toNumber } from '../sql.js';
import {
  type AuditCounts,
  type AuditPageQuery,
  type AuditSeekQuery,
  type CryptoKeyRecord,
  type CryptoKeyVersionRecord,
  type CryptoStore,
  type KeyPolicyPatch,
} from './store.js';

export interface LucidStoreOptions {
  /** Create the three tables at boot. Default `true` (the Agora convention). */
  autoCreateSchema?: boolean;
  /** Clock, so tests can pin timestamps. */
  now?: () => string;
  /**
   * Read another app's keys without their material (the federated console): every version is read
   * without its `material` column (`sealed` comes back empty), so the role needs no `SELECT` on it,
   * and every write is refused. Default `false`.
   */
  metadataOnly?: boolean;
}

interface KeyRow {
  app: string;
  name: string;
  type: string;
  description: string | null;
  latest_version: unknown;
  min_decryption_version: unknown;
  deletion_allowed: unknown;
  exportable: unknown;
  created_at: string;
  created_by: string;
  updated_at: string | null;
  updated_by: string | null;
  deleted_at: string | null;
}

interface VersionRow {
  app: string;
  name: string;
  version: unknown;
  material: string;
  kid: string | null;
  public_key: unknown;
  created_at: string;
  created_by: string;
}

interface AuditRow {
  id: string;
  at: string;
  app: string;
  key_name: string | null;
  version: unknown;
  operation: string;
  actor: string;
  client_id: string | null;
  result: string;
  error: string | null;
  metadata: unknown;
}

const KEY_COLUMNS =
  'app, name, type, description, latest_version, min_decryption_version, deletion_allowed, exportable, created_at, created_by, updated_at, updated_by, deleted_at';
const VERSION_COLUMNS = 'app, name, version, material, kid, public_key, created_at, created_by';
/** {@link VERSION_COLUMNS} without the sealed material: what a metadata-only store selects. */
const VERSION_METADATA_COLUMNS =
  "app, name, version, '' AS material, kid, public_key, created_at, created_by";
const AUDIT_COLUMNS =
  'id, at, app, key_name, version, operation, actor, client_id, result, error, metadata';

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique|duplicate|constraint/i.test(message);
}

function keyOf(row: KeyRow): CryptoKeyRecord {
  return {
    partition: row.app,
    name: row.name,
    type: row.type as CryptoKeyType,
    ...(row.description !== null ? { description: row.description } : {}),
    latestVersion: toNumber(row.latest_version),
    minDecryptionVersion: toNumber(row.min_decryption_version),
    deletionAllowed: toNumber(row.deletion_allowed) === 1,
    exportable: toNumber(row.exportable) === 1,
    createdAt: row.created_at,
    createdBy: row.created_by,
    ...(row.updated_at !== null ? { updatedAt: row.updated_at } : {}),
    ...(row.updated_by !== null ? { updatedBy: row.updated_by } : {}),
    ...(row.deleted_at !== null ? { deletedAt: row.deleted_at } : {}),
  };
}

function versionOf(row: VersionRow): CryptoKeyVersionRecord {
  const publicKey = row.public_key === null ? undefined : parseJson<PublicJwk>(row.public_key);
  return {
    partition: row.app,
    name: row.name,
    version: toNumber(row.version),
    sealed: row.material,
    ...(row.kid !== null ? { kid: row.kid } : {}),
    ...(publicKey !== undefined ? { publicKey } : {}),
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function auditOf(row: AuditRow): CryptoAuditRecord {
  const metadata =
    row.metadata === null
      ? undefined
      : parseJson<Record<string, string | number | boolean>>(row.metadata);
  return {
    id: row.id,
    at: row.at,
    partition: row.app,
    ...(row.key_name !== null ? { key: row.key_name } : {}),
    ...(row.version !== null ? { version: toNumber(row.version) } : {}),
    operation: row.operation as CryptoAuditRecord['operation'],
    actor: row.actor,
    ...(row.client_id !== null ? { clientId: row.client_id } : {}),
    result: row.result as CryptoAuditRecord['result'],
    ...(row.error !== null ? { error: row.error } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/**
 * Keys and the audit trail in your database, through Lucid: Postgres, MySQL or SQLite. One row per
 * key, one per version (the sealed material only), one per audit event. Rotation inserts a version
 * and moves `latest_version` in one transaction, so two replicas rotating at once produce two
 * ordered versions instead of losing one.
 */
export class LucidStore implements CryptoStore {
  readonly dialect: ReturnType<typeof dialectOf>;

  constructor(
    readonly db: SqlDatabase,
    private readonly options: LucidStoreOptions = {},
  ) {
    this.dialect = dialectOf(db);
  }

  /** The version columns this store reads: never `material` in a metadata-only store. */
  get #versionColumns(): string {
    return this.options.metadataOnly ? VERSION_METADATA_COLUMNS : VERSION_COLUMNS;
  }

  #assertWritable(): void {
    if (this.options.metadataOnly) {
      throw new Error("crypto: this store only reads another app's key metadata");
    }
  }

  async setup(): Promise<void> {
    if (this.options.autoCreateSchema === false || this.options.metadataOnly) return;
    await query(
      this.db,
      `CREATE TABLE IF NOT EXISTS crypto_keys (
      app varchar(128) NOT NULL,
      name varchar(64) NOT NULL,
      type varchar(24) NOT NULL,
      description text NULL,
      latest_version integer NOT NULL,
      min_decryption_version integer NOT NULL,
      deletion_allowed integer NOT NULL,
      exportable integer NOT NULL,
      created_at varchar(32) NOT NULL,
      created_by varchar(255) NOT NULL,
      updated_at varchar(32) NULL,
      updated_by varchar(255) NULL,
      deleted_at varchar(32) NULL,
      PRIMARY KEY (app, name)
    )`,
    );
    await query(
      this.db,
      `CREATE TABLE IF NOT EXISTS crypto_key_versions (
      app varchar(128) NOT NULL,
      name varchar(64) NOT NULL,
      version integer NOT NULL,
      material text NOT NULL,
      kid varchar(128) NULL,
      public_key text NULL,
      created_at varchar(32) NOT NULL,
      created_by varchar(255) NOT NULL,
      PRIMARY KEY (app, name, version)
    )`,
    );
    await query(
      this.db,
      `CREATE TABLE IF NOT EXISTS crypto_audit (
      id varchar(36) NOT NULL PRIMARY KEY,
      at varchar(32) NOT NULL,
      app varchar(128) NOT NULL,
      key_name varchar(64) NULL,
      version integer NULL,
      operation varchar(24) NOT NULL,
      actor varchar(255) NOT NULL,
      client_id varchar(255) NULL,
      result varchar(16) NOT NULL,
      error text NULL,
      metadata text NULL
    )`,
    );
    // MySQL has no `CREATE INDEX IF NOT EXISTS`; a duplicate index name is the only error this
    // raises on a second boot, so ignore it.
    try {
      await query(this.db, 'CREATE INDEX crypto_audit_app_at ON crypto_audit (app, at)');
    } catch (error) {
      if (!/exist|duplicate/i.test((error as Error).message)) throw error;
    }
  }

  async getKey(partition: string, name: string): Promise<CryptoKeyRecord | null> {
    const rows = await query<KeyRow>(
      this.db,
      `SELECT ${KEY_COLUMNS} FROM crypto_keys WHERE app = ? AND name = ? LIMIT 1`,
      [partition, name],
    );
    return rows[0] ? keyOf(rows[0]) : null;
  }

  async listKeys(partition: string): Promise<CryptoKeyRecord[]> {
    const rows = await query<KeyRow>(
      this.db,
      `SELECT ${KEY_COLUMNS} FROM crypto_keys WHERE app = ? ORDER BY name ASC`,
      [partition],
    );
    return rows.map(keyOf);
  }

  async partitions(): Promise<string[]> {
    const rows = await query<{ app: string }>(
      this.db,
      'SELECT DISTINCT app FROM crypto_keys ORDER BY app ASC',
    );
    return rows.map((row) => row.app);
  }

  async version(
    partition: string,
    name: string,
    version: number,
  ): Promise<CryptoKeyVersionRecord | null> {
    const rows = await query<VersionRow>(
      this.db,
      `SELECT ${this.#versionColumns} FROM crypto_key_versions WHERE app = ? AND name = ? AND version = ? LIMIT 1`,
      [partition, name, version],
    );
    return rows[0] ? versionOf(rows[0]) : null;
  }

  async versions(partition: string, name: string): Promise<CryptoKeyVersionRecord[]> {
    const rows = await query<VersionRow>(
      this.db,
      `SELECT ${this.#versionColumns} FROM crypto_key_versions WHERE app = ? AND name = ? ORDER BY version ASC`,
      [partition, name],
    );
    return rows.map(versionOf);
  }

  async createKey(key: CryptoKeyRecord, version: CryptoKeyVersionRecord): Promise<void> {
    this.#assertWritable();
    await this.db.transaction(async (trx) => {
      await query(
        trx,
        `INSERT INTO crypto_keys
         (app, name, type, description, latest_version, min_decryption_version, deletion_allowed, exportable, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          key.partition,
          key.name,
          key.type,
          key.description ?? null,
          key.latestVersion,
          key.minDecryptionVersion,
          key.deletionAllowed ? 1 : 0,
          key.exportable ? 1 : 0,
          key.createdAt,
          key.createdBy,
        ],
      );
      await query(
        trx,
        `INSERT INTO crypto_key_versions
         (app, name, version, material, kid, public_key, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          version.partition,
          version.name,
          version.version,
          version.sealed,
          version.kid ?? null,
          version.publicKey ? jsonValue(version.publicKey) : null,
          version.createdAt,
          version.createdBy,
        ],
      );
    });
  }

  async addVersion(
    version: CryptoKeyVersionRecord,
    next: { latestVersion: number; updatedAt: string; updatedBy: string },
  ): Promise<void> {
    this.#assertWritable();
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.db.transaction(async (trx) => {
          const current = await query<KeyRow>(
            trx,
            `SELECT ${KEY_COLUMNS} FROM crypto_keys WHERE app = ? AND name = ? LIMIT 1`,
            [version.partition, version.name],
          );
          const record = current[0];
          if (!record) throw new Error(`crypto: key "${version.name}" does not exist`);
          if (record.deleted_at !== null)
            throw new Error(`crypto: key "${version.name}" is deleted`);
          const latest = toNumber(record.latest_version);
          const wanted = latest + 1;
          const row: CryptoKeyVersionRecord = { ...version, version: wanted };
          await query(
            trx,
            `INSERT INTO crypto_key_versions
             (app, name, version, material, kid, public_key, created_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              row.partition,
              row.name,
              row.version,
              row.sealed,
              row.kid ?? null,
              row.publicKey ? jsonValue(row.publicKey) : null,
              row.createdAt,
              row.createdBy,
            ],
          );
          await query(
            trx,
            'UPDATE crypto_keys SET latest_version = ?, updated_at = ?, updated_by = ? WHERE app = ? AND name = ?',
            [wanted, next.updatedAt, next.updatedBy, version.partition, version.name],
          );
        });
        return;
      } catch (error) {
        lastError = error;
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw lastError;
  }

  async updateKey(partition: string, name: string, patch: KeyPolicyPatch): Promise<void> {
    this.#assertWritable();
    const current = await this.getKey(partition, name);
    if (!current) throw new Error(`crypto: key "${name}" does not exist`);
    const description =
      patch.description === null
        ? null
        : patch.description !== undefined
          ? patch.description
          : (current.description ?? null);
    await query(
      this.db,
      `UPDATE crypto_keys
       SET description = ?, min_decryption_version = ?, deletion_allowed = ?, exportable = ?, updated_at = ?, updated_by = ?
       WHERE app = ? AND name = ?`,
      [
        description,
        patch.minDecryptionVersion ?? current.minDecryptionVersion,
        (patch.deletionAllowed ?? current.deletionAllowed) ? 1 : 0,
        (patch.exportable ?? current.exportable) ? 1 : 0,
        patch.updatedAt,
        patch.updatedBy,
        partition,
        name,
      ],
    );
  }

  async replaceMaterial(
    partition: string,
    name: string,
    version: number,
    sealed: string,
    kid?: string,
  ): Promise<void> {
    this.#assertWritable();
    await query(
      this.db,
      'UPDATE crypto_key_versions SET material = ?' +
        (kid !== undefined ? ', kid = ?' : '') +
        ' WHERE app = ? AND name = ? AND version = ?',
      kid !== undefined
        ? [sealed, kid, partition, name, version]
        : [sealed, partition, name, version],
    );
  }

  async deleteKey(partition: string, name: string, at: string, by: string): Promise<void> {
    this.#assertWritable();
    await this.db.transaction(async (trx) => {
      const current = await query<KeyRow>(
        trx,
        `SELECT ${KEY_COLUMNS} FROM crypto_keys WHERE app = ? AND name = ? LIMIT 1`,
        [partition, name],
      );
      const record = current[0];
      if (!record) throw new Error(`crypto: key "${name}" does not exist`);
      await query(trx, 'DELETE FROM crypto_key_versions WHERE app = ? AND name = ?', [
        partition,
        name,
      ]);
      await query(
        trx,
        'UPDATE crypto_keys SET deleted_at = ?, min_decryption_version = ?, updated_at = ?, updated_by = ? WHERE app = ? AND name = ?',
        [at, toNumber(record.latest_version) + 1, at, by, partition, name],
      );
    });
  }

  async appendAudit(record: CryptoAuditRecord): Promise<void> {
    this.#assertWritable();
    await query(
      this.db,
      `INSERT INTO crypto_audit
       (id, at, app, key_name, version, operation, actor, client_id, result, error, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.at,
        record.partition,
        record.key ?? null,
        record.version ?? null,
        record.operation,
        record.actor,
        record.clientId ?? null,
        record.result,
        record.error ?? null,
        record.metadata ? jsonValue(record.metadata) : null,
      ],
    );
  }

  #auditWhere(partition: string, query_: AuditPageQuery): { sql: string; bindings: unknown[] } {
    const filters = query_.filters ?? {};
    const clauses = ['app = ?'];
    const bindings: unknown[] = [partition];
    if (filters.key !== undefined) {
      clauses.push('key_name = ?');
      bindings.push(filters.key);
    }
    if (filters.operation !== undefined) {
      clauses.push('operation = ?');
      bindings.push(filters.operation);
    }
    if (filters.result !== undefined) {
      clauses.push('result = ?');
      bindings.push(filters.result);
    }
    if (filters.actor !== undefined) {
      clauses.push('actor = ?');
      bindings.push(filters.actor);
    }
    return { sql: clauses.join(' AND '), bindings };
  }

  async listAudit(
    partition: string,
    query_: AuditPageQuery,
  ): Promise<OffsetPage<CryptoAuditRecord>> {
    const where = this.#auditWhere(partition, query_);
    const total = await query<{ total: unknown }>(
      this.db,
      `SELECT count(*) AS total FROM crypto_audit WHERE ${where.sql}`,
      where.bindings,
    );
    const order = query_.sort === 'asc' ? 'ASC' : 'DESC';
    const rows = await query<AuditRow>(
      this.db,
      `SELECT ${AUDIT_COLUMNS} FROM crypto_audit WHERE ${where.sql}
       ORDER BY at ${order}, id ${order} LIMIT ? OFFSET ?`,
      [...where.bindings, query_.size, (query_.page - 1) * query_.size],
    );
    const count = toNumber(total[0]?.total);
    const lastPage = Math.max(1, Math.ceil(count / query_.size));
    return {
      data: rows.map(auditOf),
      meta: {
        total: count,
        perPage: query_.size,
        currentPage: query_.page,
        lastPage,
        firstPage: 1,
      },
    };
  }

  async seekAudit(partition: string, query_: AuditSeekQuery): Promise<CryptoAuditRecord[]> {
    const where = this.#auditWhere(partition, { page: 1, size: 1, filters: query_.filters ?? {} });
    const clauses = [where.sql];
    const bindings = [...where.bindings];
    const op = query_.order === 'asc' ? '>' : '<';
    if (query_.from !== undefined) {
      if (this.dialect === 'postgres') {
        // A row comparison is one index range on (app, at[, id]).
        clauses.push(`(at, id) ${op} (?, ?)`);
        bindings.push(query_.from.at, query_.from.id);
      } else {
        // The same predicate spelled so MySQL and SQLite still range-scan on `at`.
        clauses.push(`at ${op}= ? AND (at ${op} ? OR id ${op} ?)`);
        bindings.push(query_.from.at, query_.from.at, query_.from.id);
      }
    }
    const order = query_.order === 'asc' ? 'ASC' : 'DESC';
    const rows = await query<AuditRow>(
      this.db,
      `SELECT ${AUDIT_COLUMNS} FROM crypto_audit WHERE ${clauses.join(' AND ')}
       ORDER BY at ${order}, id ${order} LIMIT ?`,
      [...bindings, query_.limit],
    );
    return rows.map(auditOf);
  }

  async auditCounts(partition: string, since: string): Promise<AuditCounts> {
    const rows = await query<{ result: string; count: unknown; last_at: string | null }>(
      this.db,
      'SELECT result, count(*) AS count, max(at) AS last_at FROM crypto_audit WHERE app = ? AND at >= ? GROUP BY result',
      [partition, since],
    );
    const counts: AuditCounts = { operations: 0, denied: 0, errors: 0 };
    let lastAt: string | undefined;
    for (const row of rows) {
      const count = toNumber(row.count);
      if (row.result === 'ok') counts.operations = count;
      if (row.result === 'denied') counts.denied = count;
      if (row.result === 'error') counts.errors = count;
      if (row.last_at !== null && (lastAt === undefined || row.last_at > lastAt)) {
        lastAt = row.last_at;
      }
    }
    return lastAt === undefined ? counts : { ...counts, lastAt };
  }
}
