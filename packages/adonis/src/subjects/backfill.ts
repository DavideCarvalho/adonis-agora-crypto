import { isSubjectCiphertext, readSubjectCiphertext } from './ciphertext.js';
import { SubjectKeyError } from './errors.js';
import {
  columnAad,
  type EncryptedColumnOptions,
  encryptedColumnsOf,
  type LucidModelLike,
  subjectKeysOf,
  subjectOf,
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
   * `subjects.rotateDataKey`). Default `false`.
   */
  rotate?: boolean;
  /** Count what would change, write nothing. */
  dryRun?: boolean;
  /** Only these attributes (default: every encrypted column of the model). */
  columns?: string[];
  /** A Lucid query client or transaction (default: the model's connection). */
  client?: unknown;
  /**
   * A value that cannot be processed (`invalid`: does not open, not JSON, no subject…; or
   * `forgotten`): `throw` (default) stops the run; `skip` leaves it as it is, counts it in `failed`
   * and lists it in `failures`. An unreachable crypto server or a refused token always stops it.
   */
  onError?: 'throw' | 'skip';
  /**
   * Re-seal values sealed for another subject than their row's (e.g. after a query-builder update
   * of the subject column) for the row's subject. Default `false`: they are counted in `moved` and
   * left alone, for a person to look at. Only possible with row binding, which proves the value
   * belongs to the row.
   */
  adoptMoved?: boolean;
  /** Called after each batch, with the running totals and the cursor to resume from. */
  onBatch?: (progress: BackfillResult) => void | Promise<void>;
}

export interface BackfillFailure {
  /** Primary key of the row. */
  id: string | number;
  attribute: string;
  code: string;
  /** Never contains the value. */
  message: string;
}

export interface BackfillResult {
  /** Rows read. */
  rows: number;
  /** Plaintext values encrypted. */
  encrypted: number;
  /** Values re-encrypted under the subject's current data key (`rotate`). */
  reencrypted: number;
  /** Values sealed for another subject than their row's (left alone unless `adoptMoved`). */
  moved: number;
  /** Of those, the ones re-sealed for the row's subject (`adoptMoved`). */
  adopted: number;
  /** Values already right (or null). */
  unchanged: number;
  /** Values that changed under the backfill (a concurrent write won; nothing was overwritten). */
  conflicts: number;
  /** Values skipped with `onError: 'skip'`. */
  failed: number;
  /** The first 100 skipped values. */
  failures: BackfillFailure[];
  /** The last primary key processed: pass it as `after` to resume. */
  cursor?: string | number;
}

type Outcome = 'encrypted' | 'reencrypted' | 'moved' | 'adopted' | 'unchanged' | 'conflicts';

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
 * Plaintext values are sealed; a value sealed for another subject than its row's is re-sealed (and
 * counted as `moved`) only when row binding proves it belongs to that row; with `rotate`, values
 * under a retired data key are re-encrypted. Idempotent and resumable: a rerun skips what is
 * already encrypted, and `after` restarts from a cursor. Each update is guarded by the value it
 * read, so a concurrent write is never overwritten. `updated_at` is not touched (the writes go
 * through the query builder, not `model.save()`).
 */
export async function backfillEncryptedColumns(
  Model: BackfillModel,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const all = encryptedColumnsOf(Model);
  if (options.columns) {
    const unknown = options.columns.filter((name) => !all.some((c) => c.attribute === name));
    if (unknown.length > 0) {
      throw new SubjectKeyError(
        'invalid',
        `crypto: ${Model.name} has no encrypted column ${unknown.join(', ')}`,
      );
    }
  }
  const columns = options.columns
    ? all.filter((column) => options.columns!.includes(column.attribute))
    : all;
  if (columns.length === 0) {
    throw new SubjectKeyError('invalid', `crypto: ${Model.name} has no encrypted columns to fill`);
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
    moved: 0,
    adopted: 0,
    unchanged: 0,
    conflicts: 0,
    failed: 0,
    failures: [],
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
        try {
          const outcome = await fillOne(Model, model, row, pk, column, options, query);
          result[outcome] += 1;
          if (outcome === 'adopted') result.moved += 1;
        } catch (error) {
          if (
            options.onError !== 'skip' ||
            !(error instanceof SubjectKeyError) ||
            (error.code !== 'invalid' && error.code !== 'forgotten')
          ) {
            throw error;
          }
          result.failed += 1;
          if (result.failures.length < 100) {
            result.failures.push({
              id: pk as string | number,
              attribute: column.attribute,
              code: error.code,
              message: error.message,
            });
          }
        }
      }
      cursor = pk as string | number;
    }
    if (cursor !== undefined) result.cursor = cursor;
    await options.onBatch?.({ ...result, failures: [...result.failures] });
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
): Promise<Outcome> {
  const raw = row[column.columnName];
  if (raw === null || raw === undefined) return 'unchanged';
  const where = `${Model.name}.${column.attribute} of ${String(pk)}`;
  if (typeof raw !== 'string') {
    // A json/jsonb (or numeric) column: ciphertext cannot be stored there, and the guarded update
    // needs the stored text.
    throw new SubjectKeyError(
      'invalid',
      `crypto: ${where} is not stored as text; change the column type to text first`,
    );
  }
  const subjects = subjectKeysOf(column.options);
  const subject = subjectOf(column.options, model);
  if (subject === undefined)
    throw new SubjectKeyError('invalid', `crypto: ${where} has no subject`);
  const expected = subjects.keyName(subject);
  const rowBound = column.options.row !== false;
  const rowId = !rowBound ? null : column.options.row ? column.options.row(model as never) : pk;
  if (rowId === undefined || rowId === null || rowId === '') {
    if (rowBound) throw new SubjectKeyError('invalid', `crypto: ${where} has no row binding`);
  }
  const aad = columnAad(Model.table, column.columnName, rowId === null ? null : String(rowId));

  let plaintext: string;
  let outcome: Outcome;
  if (isSubjectCiphertext(raw)) {
    const parsed = readSubjectCiphertext(raw);
    if (!parsed) throw new SubjectKeyError('invalid', `crypto: ${where} is malformed`);
    if (parsed.key !== expected) {
      if (!options.adoptMoved) return 'moved';
      if (!rowBound) {
        // Without row binding nothing proves the value belongs to this row: refuse to adopt it.
        throw new SubjectKeyError(
          'invalid',
          `crypto: ${where} is sealed for another subject and the column has no row binding; fix it by hand`,
        );
      }
      // Opening checks the row binding: a value moved here from another row fails.
      plaintext = await subjects.decrypt(raw, { aad, anySubject: true });
      outcome = 'adopted';
    } else if (options.rotate && (await subjects.needsReencrypt(raw, subject))) {
      plaintext = await subjects.decrypt(raw, { aad, subject });
      outcome = 'reencrypted';
    } else {
      return 'unchanged';
    }
  } else if ((raw as string).toLowerCase().startsWith('agora:')) {
    throw new SubjectKeyError(
      'invalid',
      `crypto: ${where} holds another kind of agora ciphertext; it is not plaintext`,
    );
  } else {
    if (column.options.json) {
      try {
        JSON.parse(raw);
      } catch {
        throw new SubjectKeyError('invalid', `crypto: ${where} is not valid JSON`);
      }
    }
    plaintext = raw;
    outcome = 'encrypted';
  }
  if (options.dryRun) return outcome;
  const ciphertext = await subjects.encrypt(subject, plaintext, { aad });
  const pkColumn = Model.$getColumn(Model.primaryKey)?.columnName ?? Model.primaryKey;
  const count = affected(
    await query()
      .where(pkColumn, pk)
      .where(column.columnName, raw)
      .update({ [column.columnName]: ciphertext }),
  );
  return count > 0 ? outcome : 'conflicts';
}
