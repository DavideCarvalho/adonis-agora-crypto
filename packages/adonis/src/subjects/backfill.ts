import { isSubjectCiphertext } from './ciphertext.js';
import { SubjectKeyError } from './errors.js';
import {
  columnAad,
  type EncryptedColumnOptions,
  encryptedColumnsOf,
  type LucidModelLike,
  subjectKeysOf,
} from './lucid.js';

/** The slice of a Lucid model the backfill needs (structural: no Lucid import). */
export interface BackfillModel extends LucidModelLike {
  query(options?: { client?: unknown }): BackfillQuery;
  $createFromAdapterResult(row: Record<string, unknown>): object | null;
}

interface BackfillQuery {
  select(...columns: string[]): BackfillQuery;
  where(column: string, operator: string, value: unknown): BackfillQuery;
  where(column: string, value: unknown): BackfillQuery;
  orderBy(column: string, direction: 'asc' | 'desc'): BackfillQuery;
  limit(count: number): BackfillQuery;
  pojo<T>(): PromiseLike<T[]>;
  update(values: Record<string, unknown>): PromiseLike<unknown>;
}

export interface BackfillOptions {
  /** Rows per batch (one SELECT each). Default `500`. */
  batchSize?: number;
  /** Resume after this primary key (exclusive): the `cursor` a previous run reported. */
  after?: string | number;
  /**
   * Also re-encrypt values whose data key is not the subject's current one (after
   * `subjects.rotateDataKey`). Default `false`: only plaintext and values sealed for another
   * subject are written.
   */
  rotate?: boolean;
  /** Count what would change, write nothing. */
  dryRun?: boolean;
  /** Only these attributes (default: every encrypted column of the model). */
  columns?: string[];
  /** A Lucid query client or transaction (default: the model's connection). */
  client?: unknown;
  /** Called after each batch, with the running totals and the cursor to resume from. */
  onBatch?: (progress: BackfillResult) => void | Promise<void>;
}

export interface BackfillResult {
  /** Rows read. */
  rows: number;
  /** Plaintext values encrypted. */
  encrypted: number;
  /** Ciphertext re-encrypted (another subject, or a retired data key with `rotate`). */
  reencrypted: number;
  /** Values already right (or null). */
  unchanged: number;
  /** Values that changed under the backfill (a concurrent write won; nothing was overwritten). */
  conflicts: number;
  /** The last primary key processed: pass it as `after` to resume. */
  cursor?: string | number;
}

function affected(result: unknown): number {
  if (typeof result === 'number') return result;
  if (Array.isArray(result)) {
    const first = result[0] as unknown;
    if (typeof first === 'number') return first;
    if (first && typeof first === 'object' && 'affectedRows' in first) {
      return Number((first as { affectedRows: number }).affectedRows);
    }
  }
  return 0;
}

/**
 * Encrypts an existing table in place, in batches by primary key, never loading more than one batch.
 * Plaintext values are sealed; ciphertext is left alone unless it belongs to another subject than
 * its row's (or, with `rotate`, uses a retired data key). Idempotent and resumable: a rerun skips
 * what is already encrypted, and `after` restarts from a cursor. Each update is guarded by the
 * value it read, so a concurrent write is never overwritten. `updated_at` is not touched (the
 * writes go through the query builder, not `model.save()`).
 */
export async function backfillEncryptedColumns(
  Model: BackfillModel,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const all = encryptedColumnsOf(Model);
  const columns = options.columns
    ? all.filter((column) => options.columns!.includes(column.attribute))
    : all;
  if (columns.length === 0) {
    throw new SubjectKeyError('invalid', `crypto: ${Model.name} has no encrypted columns to fill`);
  }
  if (options.columns) {
    const unknown = options.columns.filter((name) => !all.some((c) => c.attribute === name));
    if (unknown.length > 0) {
      throw new SubjectKeyError(
        'invalid',
        `crypto: ${Model.name} has no encrypted column ${unknown.join(', ')}`,
      );
    }
  }
  const primaryKey = Model.primaryKey;
  const pkColumn = Model.$getColumn(primaryKey)?.columnName ?? primaryKey;
  const batchSize = Math.max(1, Math.min(10_000, Math.floor(options.batchSize ?? 500)));
  const query = () => Model.query(options.client !== undefined ? { client: options.client } : {});
  const encryptedNames = new Set(all.map((column) => column.columnName));
  const result: BackfillResult = {
    rows: 0,
    encrypted: 0,
    reencrypted: 0,
    unchanged: 0,
    conflicts: 0,
  };
  let cursor = options.after;

  for (;;) {
    let select = query().select('*');
    if (cursor !== undefined) select = select.where(pkColumn, '>', cursor);
    const rows = await select
      .orderBy(pkColumn, 'asc')
      .limit(batchSize)
      .pojo<Record<string, unknown>>();
    if (rows.length === 0) break;
    for (const row of rows) {
      result.rows += 1;
      const pk = row[pkColumn];
      if (pk === null || pk === undefined) {
        throw new SubjectKeyError('invalid', `crypto: a ${Model.table} row has no ${pkColumn}`);
      }
      // The model without its encrypted columns: what `subject` and `row` read.
      const plain: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(row)) {
        if (!encryptedNames.has(name)) plain[name] = value;
      }
      const model = Model.$createFromAdapterResult(plain);
      if (!model) throw new SubjectKeyError('invalid', `crypto: could not hydrate a ${Model.name}`);
      for (const column of columns) {
        const outcome = await fillOne(Model, model, row, pk, column, options, query);
        result[outcome] += 1;
      }
      cursor = pk as string | number;
    }
    if (cursor !== undefined) result.cursor = cursor;
    await options.onBatch?.({ ...result });
    if (rows.length < batchSize) break;
  }
  return result;
}

async function fillOne(
  Model: BackfillModel,
  model: object,
  row: Record<string, unknown>,
  pk: unknown,
  column: { attribute: string; columnName: string; options: EncryptedColumnOptions },
  options: BackfillOptions,
  query: () => BackfillQuery,
): Promise<'encrypted' | 'reencrypted' | 'unchanged' | 'conflicts'> {
  const raw = row[column.columnName];
  if (raw === null || raw === undefined) return 'unchanged';
  const subjects = subjectKeysOf(column.options);
  const subject = column.options.subject(model as never);
  if (subject === null || subject === undefined || subject === '') {
    throw new SubjectKeyError(
      'invalid',
      `crypto: ${Model.name}.${column.attribute} of ${String(pk)} has no subject`,
    );
  }
  const rowId =
    column.options.row === false
      ? null
      : column.options.row
        ? column.options.row(model as never)
        : pk;
  if (rowId === undefined || rowId === '' || (column.options.row !== false && rowId === null)) {
    throw new SubjectKeyError(
      'invalid',
      `crypto: ${Model.name}.${column.attribute} of ${String(pk)} has no row binding`,
    );
  }
  const aad = columnAad(Model.table, column.columnName, rowId === null ? null : String(rowId));

  let plaintext: string;
  let outcome: 'encrypted' | 'reencrypted';
  if (isSubjectCiphertext(raw)) {
    const expected = subjects.keyName(subject);
    const stale = options.rotate
      ? await subjects.needsReencrypt(raw, subject)
      : !raw.startsWith(`agora:se1:${expected}:`);
    if (!stale) return 'unchanged';
    // Opening checks the row binding; a value moved here from another row fails loudly.
    plaintext = await subjects.decrypt(raw, { aad });
    outcome = 'reencrypted';
  } else if (column.options.json) {
    if (typeof raw === 'string') {
      try {
        JSON.parse(raw);
      } catch {
        throw new SubjectKeyError(
          'invalid',
          `crypto: ${Model.name}.${column.attribute} of ${String(pk)} is not valid JSON`,
        );
      }
      plaintext = raw;
    } else {
      plaintext = JSON.stringify(raw);
    }
    outcome = 'encrypted';
  } else {
    if (typeof raw !== 'string') {
      throw new SubjectKeyError(
        'invalid',
        `crypto: ${Model.name}.${column.attribute} of ${String(pk)} is not a string`,
      );
    }
    plaintext = raw;
    outcome = 'encrypted';
  }
  if (options.dryRun) return outcome;
  const ciphertext = await subjects.encrypt(subject, plaintext, { aad });
  const pkColumn = Model.$getColumn(Model.primaryKey)?.columnName ?? Model.primaryKey;
  let update = query().where(pkColumn, pk);
  if (typeof raw === 'string') update = update.where(column.columnName, raw);
  const count = affected(await update.update({ [column.columnName]: ciphertext }));
  return count > 0 ? outcome : 'conflicts';
}
