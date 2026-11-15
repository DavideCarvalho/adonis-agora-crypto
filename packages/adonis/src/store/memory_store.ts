import { randomUUID } from 'node:crypto';
import type { CryptoAuditRecord } from '@adonis-agora/crypto-core';
import {
  type AuditCounts,
  type AuditPageQuery,
  type CryptoKeyRecord,
  type CryptoKeyVersionRecord,
  type CryptoStore,
  type KeyPolicyPatch,
} from './store.js';

const slot = (partition: string, name: string) => `${partition}\u0000${name}`;

/** Offset-pages an in-memory list in the Agora list wire format. */
function page<T>(rows: T[], query: { page: number; size: number }) {
  const start = (query.page - 1) * query.size;
  const lastPage = Math.max(1, Math.ceil(rows.length / query.size));
  return {
    data: rows.slice(start, start + query.size),
    meta: {
      total: rows.length,
      perPage: query.size,
      currentPage: query.page,
      lastPage,
      firstPage: 1,
    },
  };
}

/**
 * The crypto store in process memory: tests, local development and a standalone app that does not
 * want a database. Key material is already sealed when it reaches it.
 */
export class MemoryStore implements CryptoStore {
  readonly #keys = new Map<string, CryptoKeyRecord>();
  readonly #versions = new Map<string, CryptoKeyVersionRecord[]>();
  readonly #audit = new Map<string, CryptoAuditRecord[]>();
  readonly #now: () => string;

  constructor(options: { now?: () => string } = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async getKey(partition: string, name: string): Promise<CryptoKeyRecord | null> {
    const record = this.#keys.get(slot(partition, name));
    return record ? { ...record } : null;
  }

  async listKeys(partition: string): Promise<CryptoKeyRecord[]> {
    return [...this.#keys.values()]
      .filter((record) => record.partition === partition)
      .map((record) => ({ ...record }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async partitions(): Promise<string[]> {
    return [...new Set([...this.#keys.values()].map((record) => record.partition))].sort();
  }

  async version(
    partition: string,
    name: string,
    version: number,
  ): Promise<CryptoKeyVersionRecord | null> {
    const found = this.#versions
      .get(slot(partition, name))
      ?.find((record) => record.version === version);
    return found ? { ...found } : null;
  }

  async versions(partition: string, name: string): Promise<CryptoKeyVersionRecord[]> {
    return (this.#versions.get(slot(partition, name)) ?? [])
      .map((record) => ({ ...record }))
      .sort((a, b) => a.version - b.version);
  }

  async createKey(key: CryptoKeyRecord, version: CryptoKeyVersionRecord): Promise<void> {
    const id = slot(key.partition, key.name);
    if (this.#keys.has(id)) throw new Error(`crypto: key "${key.name}" already exists`);
    this.#keys.set(id, { ...key });
    this.#versions.set(id, [{ ...version }]);
  }

  async addVersion(
    version: CryptoKeyVersionRecord,
    next: { latestVersion: number; updatedAt: string; updatedBy: string },
  ): Promise<void> {
    const id = slot(version.partition, version.name);
    const record = this.#keys.get(id);
    if (!record) throw new Error(`crypto: key "${version.name}" does not exist`);
    const list = this.#versions.get(id) ?? [];
    if (list.some((entry) => entry.version === version.version)) {
      throw new Error(`crypto: version ${version.version} of "${version.name}" already exists`);
    }
    list.push({ ...version });
    this.#versions.set(id, list);
    this.#keys.set(id, {
      ...record,
      latestVersion: next.latestVersion,
      updatedAt: next.updatedAt,
      updatedBy: next.updatedBy,
    });
  }

  async updateKey(partition: string, name: string, patch: KeyPolicyPatch): Promise<void> {
    const id = slot(partition, name);
    const record = this.#keys.get(id);
    if (!record) throw new Error(`crypto: key "${name}" does not exist`);
    const next: CryptoKeyRecord = {
      ...record,
      updatedAt: patch.updatedAt,
      updatedBy: patch.updatedBy,
      ...(patch.minDecryptionVersion !== undefined
        ? { minDecryptionVersion: patch.minDecryptionVersion }
        : {}),
      ...(patch.deletionAllowed !== undefined ? { deletionAllowed: patch.deletionAllowed } : {}),
      ...(patch.exportable !== undefined ? { exportable: patch.exportable } : {}),
    };
    if (patch.description === null) delete next.description;
    else if (patch.description !== undefined) next.description = patch.description;
    this.#keys.set(id, next);
  }

  async replaceMaterial(
    partition: string,
    name: string,
    version: number,
    sealed: string,
    kid?: string,
  ): Promise<void> {
    const id = slot(partition, name);
    const list = this.#versions.get(id);
    const found = list?.find((entry) => entry.version === version);
    if (!list || !found) throw new Error(`crypto: no version ${version} of "${name}"`);
    const next = { ...found, sealed, ...(kid !== undefined ? { kid } : {}) };
    this.#versions.set(
      id,
      list.map((entry) => (entry.version === version ? next : entry)),
    );
  }

  async deleteKey(partition: string, name: string, at: string, by: string): Promise<void> {
    const id = slot(partition, name);
    const record = this.#keys.get(id);
    if (!record) throw new Error(`crypto: key "${name}" does not exist`);
    this.#versions.delete(id);
    this.#keys.set(id, {
      ...record,
      deletedAt: at,
      minDecryptionVersion: record.latestVersion + 1,
      updatedAt: at,
      updatedBy: by,
    });
  }

  async appendAudit(record: CryptoAuditRecord): Promise<void> {
    const list = this.#audit.get(record.partition) ?? [];
    list.push({ ...record });
    this.#audit.set(record.partition, list);
  }

  async listAudit(
    partition: string,
    query: AuditPageQuery,
  ): Promise<ReturnType<typeof page<CryptoAuditRecord>>> {
    const filters = query.filters ?? {};
    const rows = (this.#audit.get(partition) ?? [])
      .filter(
        (row) =>
          (filters.key === undefined || row.key === filters.key) &&
          (filters.operation === undefined || row.operation === filters.operation) &&
          (filters.result === undefined || row.result === filters.result) &&
          (filters.actor === undefined || row.actor === filters.actor),
      )
      .sort((a, b) => (query.sort === 'asc' ? a.at.localeCompare(b.at) : b.at.localeCompare(a.at)));
    return page(rows, query);
  }

  async auditCounts(partition: string, since: string): Promise<AuditCounts> {
    const rows = (this.#audit.get(partition) ?? []).filter((row) => row.at >= since);
    const lastAt = rows
      .map((row) => row.at)
      .sort()
      .at(-1);
    return {
      operations: rows.filter((row) => row.result === 'ok').length,
      denied: rows.filter((row) => row.result === 'denied').length,
      errors: rows.filter((row) => row.result === 'error').length,
      ...(lastAt !== undefined ? { lastAt } : {}),
    };
  }

  /** Forgets everything (tests). */
  reset(): void {
    this.#keys.clear();
    this.#versions.clear();
    this.#audit.clear();
  }

  /** The clock the store uses when a caller omits a timestamp. */
  now(): string {
    return this.#now();
  }

  /** A fresh audit id. */
  auditId(): string {
    return randomUUID();
  }
}
