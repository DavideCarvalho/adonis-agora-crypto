import type {
  CryptoAuditRecord,
  CryptoKeyType,
  OffsetPage,
  PublicJwk,
} from '@adonis-agora/crypto-core';

/** One named key, without any material. */
export interface CryptoKeyRecord {
  partition: string;
  name: string;
  type: CryptoKeyType;
  description?: string;
  latestVersion: number;
  minDecryptionVersion: number;
  deletionAllowed: boolean;
  exportable: boolean;
  /** ISO 8601. Set on insert, never changes. */
  createdAt: string;
  createdBy: string;
  /**
   * ISO 8601. Set on insert (equal to `createdAt`) and on every change: rotation, policy, delete.
   * Absent on keys created before 1.0 that were never changed since.
   */
  updatedAt?: string;
  updatedBy?: string;
  /** Set by a delete: the name stays reserved and no operation is served any more. */
  deletedAt?: string;
}

/** One version: the sealed material plus the public metadata. */
export interface CryptoKeyVersionRecord {
  partition: string;
  name: string;
  version: number;
  /** `agora:v1:…`; never plaintext key material. */
  sealed: string;
  kid?: string;
  publicKey?: PublicJwk;
  createdAt: string;
  createdBy: string;
}

export interface AuditFilters {
  key?: string;
  operation?: string;
  result?: string;
  actor?: string;
}

export interface AuditPageQuery {
  page: number;
  size: number;
  /** Default `desc` (newest first). */
  sort?: 'asc' | 'desc';
  filters?: AuditFilters;
}

/** A position in the audit trail: the `(at, id)` of one row. */
export interface AuditPosition {
  at: string;
  id: string;
}

/**
 * One keyset read of the audit trail: rows strictly past `from` in `order`, ordered by
 * `(at, id)` in that direction. The service asks for one row more than the page so it knows
 * whether another page follows, and builds the opaque cursors itself.
 */
export interface AuditSeekQuery {
  /** Rows to return at most. */
  limit: number;
  /** `desc`: rows before `from` (older first); `asc`: rows after it. */
  order: 'asc' | 'desc';
  /** Absent on the first page. */
  from?: AuditPosition;
  filters?: AuditFilters;
}

export interface AuditCounts {
  operations: number;
  denied: number;
  errors: number;
  lastAt?: string;
}

export interface KeyPolicyPatch {
  description?: string | null;
  minDecryptionVersion?: number;
  deletionAllowed?: boolean;
  exportable?: boolean;
  updatedAt: string;
  updatedBy: string;
}

/**
 * Where a crypto server keeps keys and its audit trail. Two drivers: in-process memory (tests,
 * local development) and Lucid (Postgres, MySQL, SQLite). A store never sees plaintext key
 * material: the service seals before writing.
 */
export interface CryptoStore {
  /** Creates the store's tables (Lucid), when the driver needs it. Idempotent. */
  setup?(): Promise<void> | void;
  getKey(partition: string, name: string): Promise<CryptoKeyRecord | null>;
  /** Every key of an app, deleted ones included (the console shows them), sorted by name. */
  listKeys(partition: string): Promise<CryptoKeyRecord[]>;
  /** Every app that holds a key, sorted. */
  partitions(): Promise<string[]>;
  version(partition: string, name: string, version: number): Promise<CryptoKeyVersionRecord | null>;
  /** Every version of a key, oldest first. */
  versions(partition: string, name: string): Promise<CryptoKeyVersionRecord[]>;
  /** Inserts the key and its first version. Fails when the name is taken. */
  createKey(key: CryptoKeyRecord, version: CryptoKeyVersionRecord): Promise<void>;
  /** Inserts a new version and makes it the latest. Fails on a version conflict. */
  addVersion(
    version: CryptoKeyVersionRecord,
    next: { latestVersion: number; updatedAt: string; updatedBy: string },
  ): Promise<void>;
  updateKey(partition: string, name: string, patch: KeyPolicyPatch): Promise<void>;
  /** Rewrites one version's sealed material (the root keyring rotated; the key itself did not). */
  replaceMaterial(
    partition: string,
    name: string,
    version: number,
    sealed: string,
    kid?: string,
  ): Promise<void>;
  /** Marks the key deleted and destroys every version's material. */
  deleteKey(partition: string, name: string, at: string, by: string): Promise<void>;
  appendAudit(record: CryptoAuditRecord): Promise<void>;
  /** Offset page with an exact total. Kept for `?page=` clients; the console uses {@link seekAudit}. */
  listAudit(partition: string, query: AuditPageQuery): Promise<OffsetPage<CryptoAuditRecord>>;
  /**
   * Keyset read for cursor paging: no count, no offset. Optional for third-party stores: without
   * it a cursor request answers `unsupported` and `?page=` keeps working.
   */
  seekAudit?(partition: string, query: AuditSeekQuery): Promise<CryptoAuditRecord[]>;
  /** Counters for the console's overview, from `since` (inclusive). */
  auditCounts(partition: string, since: string): Promise<AuditCounts>;
}
