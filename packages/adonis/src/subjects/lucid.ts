import { getRuntime } from '../services/accessor.js';
import { isSubjectCiphertext, readSubjectCiphertext } from './ciphertext.js';
import { SubjectKeyError } from './errors.js';
import type { SubjectId, SubjectKeys, SubjectRef } from './subject_keys.js';

/**
 * Lucid's model surface this module touches, typed structurally so `@adonisjs/lucid` stays an
 * optional peer (nothing here imports it).
 */
interface LucidColumn {
  columnName: string;
  meta?: unknown;
}
interface LucidModelInstance {
  $attributes: Record<string, unknown>;
  $original: Record<string, unknown>;
  $extras?: Record<string, unknown>;
  $isPersisted: boolean;
  $dirty: Record<string, unknown>;
  $primaryKeyValue?: unknown;
  constructor: Function;
}
export interface LucidModelLike {
  name: string;
  table: string;
  primaryKey: string;
  boot(): void;
  $addColumn(name: string, options: Record<string, unknown>): LucidColumn;
  $getColumn(name: string): LucidColumn | undefined;
  $columnsDefinitions: Map<string, LucidColumn>;
  before(event: 'save', handler: (model: never) => unknown): void;
  after(event: 'find' | 'fetch' | 'save', handler: (value: never) => unknown): void;
}

export interface EncryptedColumnOptions<Model = unknown> {
  /**
   * Whose key seals the value, e.g. `(note) => note.researcherId`. Required. It may return a typed
   * subject (`{ type: 'researcher', id }`); see also `namespace`.
   */
  subject: (model: Model) => SubjectRef | null | undefined;
  /**
   * The subject type: the id `subject` returns becomes `{ type: namespace, id }`, so researcher 7
   * and project 7 get different keys (`subject_researcher_7`, `subject_project_7`).
   */
  namespace?: string;
  /** A JSON value (object, array, number, …) stored as ciphertext text. Default `false` (a string). */
  json?: boolean;
  /**
   * Accept values that are still plaintext (no `agora:` prefix) on read, while a backfill encrypts
   * the table. A function decides per row (`(note) => note.createdAt < cutoff`). Writes always
   * encrypt. Default `false`: plaintext on read is undecryptable.
   */
  legacyPlaintext?: boolean | ((model: Model) => boolean);
  /** Called on every plaintext value read through `legacyPlaintext` (log it, count it). */
  onLegacyRead?: (model: Model, attribute: string) => void;
  /**
   * What a value that cannot be opened becomes: `throw` (default) fails the query; `null` sets the
   * attribute to `null` and lists it in `model.$extras.agoraUndecryptable` (a listing that may hold
   * rows of forgotten subjects). Applies to `forgotten` and `invalid` failures only: an unreachable
   * crypto server (`unavailable`) or a refused token (`denied`) always throws.
   */
  onUndecryptable?: 'throw' | 'null';
  /**
   * What binds a ciphertext to its row (into the AAD, next to table and column): the primary key by
   * default, so a value copied to another row does not open. The key must be known before the
   * insert (a UUID, or set it yourself); with an auto-increment id use another stable unique column,
   * or `false` to bind table and column only (the subject column must then be selected to read).
   */
  row?: ((model: Model) => string | number | null | undefined) | false;
  /** The subject keys to use. Default: the app's (`crypto.subjects`). */
  using?: SubjectKeys | (() => SubjectKeys);
  /** Passed through to Lucid's `@column`. */
  columnName?: string;
  serializeAs?: string | null;
  serialize?: (value: unknown, attribute: string, model: Model) => unknown;
}

const META = Symbol.for('adonis-agora.crypto.encrypted');

interface EncryptedMeta {
  [META]: EncryptedColumnOptions;
}

/** Where `onUndecryptable: 'null'` lists the attributes it nulled. */
export const UNDECRYPTABLE_EXTRA = 'agoraUndecryptable';

/**
 * A value read from the database that has not been opened (the model hooks did not run, e.g.
 * `Model.$createFromAdapterResult`). It refuses to be used as data: reading it as a string or
 * serializing it throws, so a stored value can never be mistaken for the decrypted one.
 */
export class SealedValue {
  readonly #ciphertext: string;

  constructor(ciphertext: string) {
    this.#ciphertext = ciphertext;
  }

  get ciphertext(): string {
    return this.#ciphertext;
  }

  #refuse(): never {
    throw new SubjectKeyError(
      'sealed',
      'crypto: this encrypted attribute was not decrypted (load the model through a query so its hooks run)',
    );
  }

  toString(): string {
    return this.#refuse();
  }

  toJSON(): never {
    return this.#refuse();
  }

  [Symbol.toPrimitive](): never {
    return this.#refuse();
  }
}

/** A stored value without the `agora:se1:` prefix, waiting for `after:find` to judge it. */
class RawValue extends SealedValue {
  constructor(readonly raw: unknown) {
    super('');
  }
}

/** Ciphertext computed in `before:save`, handed to the synchronous `prepare` by identity. */
interface Pending {
  value: unknown;
  ciphertext: string;
  /** Subject key + AAD it was sealed for: `prepare` refuses it if the row changed since. */
  binding: string;
  used: boolean;
}
const pending = new WeakMap<object, Map<string, Pending>>();
/** The binding (subject key + AAD) each attribute was last sealed or opened with. */
const sealedWith = new WeakMap<object, Map<string, string>>();
/** A marker that makes an attribute dirty so Lucid writes it. */
const FORCE_WRITE = Symbol('crypto.force-write');

let legacyReads = 0;
const legacyColumns = new Set<string>();

/** How many plaintext values `legacyPlaintext` let through in this process. */
export function legacyPlaintextReads(): number {
  return legacyReads;
}

/** The encrypted columns declared with `legacyPlaintext` in this process (`Model.attribute`). */
export function legacyPlaintextColumns(): string[] {
  return [...legacyColumns].sort();
}

function optionsOf(column: LucidColumn | undefined): EncryptedColumnOptions | undefined {
  const meta = column?.meta as Partial<EncryptedMeta> | undefined;
  return meta?.[META];
}

function encryptedColumns(
  Model: LucidModelLike,
): Array<[string, LucidColumn, EncryptedColumnOptions]> {
  const found: Array<[string, LucidColumn, EncryptedColumnOptions]> = [];
  for (const [attribute, column] of Model.$columnsDefinitions) {
    const options = optionsOf(column);
    if (options) found.push([attribute, column, options]);
  }
  return found;
}

function subjectKeysOf(options: EncryptedColumnOptions): SubjectKeys {
  if (options.using) return typeof options.using === 'function' ? options.using() : options.using;
  const subjects = getRuntime().subjects;
  if (!subjects) {
    throw new SubjectKeyError(
      'invalid',
      'crypto: encrypted columns need `subjects` in config/crypto.ts (or pass `using` to the column)',
    );
  }
  return subjects;
}

/** The subject of a row (namespaced when the column says so), or `undefined` when it has none. */
export function subjectOf(options: EncryptedColumnOptions, model: unknown): SubjectRef | undefined {
  const value = options.subject(model as never);
  if (value === null || value === undefined || value === '') return undefined;
  if (options.namespace === undefined) return value;
  if (typeof value === 'object') {
    throw new SubjectKeyError(
      'invalid',
      'crypto: with `namespace`, `subject` returns the bare id (the type comes from the namespace)',
    );
  }
  return { type: options.namespace, id: value as SubjectId };
}

/** The AAD of one column of one row: `["agora:col", table, column, row]`. */
export function columnAad(table: string, column: string, row: unknown): string {
  return JSON.stringify([
    'agora:col',
    table,
    column,
    row === undefined || row === null ? null : String(row),
  ]);
}

/** The row id a column binds to: `null` with `row: false`, `undefined` when it is not known. */
function rowIdOf(
  options: EncryptedColumnOptions,
  view: unknown,
  primaryKey: unknown,
): string | null | undefined {
  if (options.row === false) return null;
  const value = options.row ? options.row(view as never) : primaryKey;
  if (value === null || value === undefined || value === '') return undefined;
  return String(value);
}

/** Subject key + AAD of one column for one view of a row (`undefined` parts when unknown). */
function bindingOf(
  Model: LucidModelLike,
  column: LucidColumn,
  options: EncryptedColumnOptions,
  view: unknown,
  primaryKey: unknown,
): { key?: string; subject?: SubjectRef; aad?: string; signature: string } {
  const subjects = subjectKeysOf(options);
  const subject = subjectOf(options, view);
  const key = subject !== undefined ? subjects.keyName(subject) : undefined;
  const row = rowIdOf(options, view, primaryKey);
  const aad = row === undefined ? undefined : columnAad(Model.table, column.columnName, row);
  return {
    ...(key !== undefined ? { key } : {}),
    ...(subject !== undefined ? { subject } : {}),
    ...(aad !== undefined ? { aad } : {}),
    signature: `${key ?? ''}\u0000${aad ?? ''}`,
  };
}

function encode(Model: LucidModelLike, attribute: string, value: unknown, json: boolean): string {
  if (json) {
    const text = JSON.stringify(value);
    if (text === undefined) {
      throw new SubjectKeyError(
        'invalid',
        `crypto: ${Model.name}.${attribute} is not JSON-serializable`,
      );
    }
    return text;
  }
  if (typeof value !== 'string') {
    throw new SubjectKeyError(
      'invalid',
      `crypto: ${Model.name}.${attribute} must be a string (use \`json: true\` for other values)`,
    );
  }
  return value;
}

function decode(Model: LucidModelLike, attribute: string, text: string, json: boolean): unknown {
  if (!json) return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new SubjectKeyError('invalid', `crypto: ${Model.name}.${attribute} is not valid JSON`);
  }
}

const clone = (value: unknown) =>
  value !== null && typeof value === 'object' ? structuredClone(value) : value;

/** The row as it was loaded (`$original`), for the subject and row functions. */
function originalView(model: LucidModelInstance): Record<string, unknown> {
  return { ...model.$original };
}

function remember(model: LucidModelInstance, attribute: string, signature: string): void {
  let bindings = sealedWith.get(model);
  if (!bindings) {
    bindings = new Map();
    sealedWith.set(model, bindings);
  }
  bindings.set(attribute, signature);
}

/**
 * `before:save`: seals every encrypted attribute that changed, or whose binding (subject or row)
 * changed. Refuses to move a row to another subject or row id while one of its encrypted columns is
 * not loaded: that value would stay sealed for the old owner.
 */
async function sealHook(model: LucidModelInstance): Promise<void> {
  const Model = model.constructor as unknown as LucidModelLike;
  const columns = encryptedColumns(Model);
  if (columns.length === 0) return;
  const dirty = model.$isPersisted ? model.$dirty : model.$attributes;
  const before = model.$isPersisted ? originalView(model) : undefined;
  const beforeKey = model.$isPersisted ? model.$original[Model.primaryKey] : undefined;
  const stash = new Map<string, Pending>();
  pending.set(model, stash);

  const plan = columns.map(([attribute, column, options]) => {
    const now = bindingOf(Model, column, options, model, model.$primaryKeyValue);
    const was = before ? bindingOf(Model, column, options, before, beforeKey) : undefined;
    return { attribute, column, options, now, was };
  });

  for (const { attribute, now, was } of plan) {
    if (!was || was.signature === now.signature) continue;
    const value = model.$attributes[attribute];
    if (!(attribute in model.$attributes) || value instanceof SealedValue) {
      throw new SubjectKeyError(
        'invalid',
        `crypto: ${Model.name}.${attribute} is not loaded, but the row's subject or id changed: load every encrypted column before moving a row (it would stay sealed for the old owner)`,
      );
    }
  }

  await Promise.all(
    plan.map(async ({ attribute, options, now, was }) => {
      const value = model.$attributes[attribute];
      if (value === null || value === undefined || value instanceof SealedValue) return;
      if (now.subject === undefined || now.key === undefined) {
        throw new SubjectKeyError(
          'invalid',
          `crypto: ${Model.name}.${attribute} needs a subject (its \`subject\` returned nothing)`,
        );
      }
      if (now.aad === undefined) {
        throw new SubjectKeyError(
          'invalid',
          `crypto: ${Model.name}.${attribute} binds its ciphertext to the row, but the row has no id yet. Assign the primary key before saving (a UUID), point \`row\` at a stable unique column, or set \`row: false\``,
        );
      }
      const changed = attribute in dirty;
      const known = sealedWith.get(model)?.get(attribute);
      const moved =
        known !== now.signature || (was !== undefined && was.signature !== now.signature);
      if (!changed && !moved) return;
      const subjects = subjectKeysOf(options);
      const ciphertext = await subjects.encrypt(
        now.subject,
        encode(Model, attribute, value, options.json === true),
        { aad: now.aad },
      );
      stash.set(attribute, { value, ciphertext, binding: now.signature, used: false });
      // Not dirty but sealed for another binding: make Lucid write it.
      if (!changed) model.$original[attribute] = FORCE_WRITE;
    }),
  );
}

/** `after:save`: remembers the binding each written attribute is sealed with. */
function afterSaveHook(model: LucidModelInstance): void {
  const stash = pending.get(model);
  pending.delete(model);
  if (!stash) return;
  for (const [attribute, entry] of stash) {
    if (entry.used) remember(model, attribute, entry.binding);
  }
}

function undecryptable(model: LucidModelInstance, attribute: string): void {
  model.$attributes[attribute] = null;
  model.$original[attribute] = null;
  if (model.$extras) {
    const list = (model.$extras[UNDECRYPTABLE_EXTRA] as string[] | undefined) ?? [];
    list.push(attribute);
    model.$extras[UNDECRYPTABLE_EXTRA] = list;
  }
}

/** `after:find` / `after:fetch`: opens every sealed attribute of the loaded rows. */
async function openHook(result: LucidModelInstance | LucidModelInstance[]): Promise<void> {
  const models = Array.isArray(result) ? result : [result];
  const work: Promise<void>[] = [];
  for (const model of models) {
    if (!model || typeof model !== 'object' || !('$attributes' in model)) continue;
    const Model = model.constructor as unknown as LucidModelLike;
    for (const [attribute, column, options] of encryptedColumns(Model)) {
      const value = model.$attributes[attribute];
      if (!(value instanceof SealedValue)) continue;
      work.push(
        openOne(model, Model, attribute, column, options, value).catch((error: unknown) => {
          const code = error instanceof SubjectKeyError ? error.code : undefined;
          if (options.onUndecryptable === 'null' && (code === 'forgotten' || code === 'invalid')) {
            undecryptable(model, attribute);
            return;
          }
          throw error;
        }),
      );
    }
  }
  await Promise.all(work);
}

async function openOne(
  model: LucidModelInstance,
  Model: LucidModelLike,
  attribute: string,
  column: LucidColumn,
  options: EncryptedColumnOptions,
  sealed: SealedValue,
): Promise<void> {
  if (sealed instanceof RawValue) {
    openRaw(model, Model, attribute, options, sealed.raw);
    return;
  }
  const subjects = subjectKeysOf(options);
  const parsed = readSubjectCiphertext(sealed.ciphertext);
  if (!parsed) {
    throw new SubjectKeyError(
      'invalid',
      `crypto: ${Model.name}.${attribute} holds a malformed agora:se1 ciphertext`,
    );
  }
  const binding = bindingOf(Model, column, options, model, model.$primaryKeyValue);
  if (binding.key !== undefined && binding.key !== parsed.key) {
    throw new SubjectKeyError(
      'invalid',
      `crypto: ${Model.name}.${attribute} is sealed for another subject than its row's`,
    );
  }
  if (binding.aad === undefined) {
    throw new SubjectKeyError(
      'invalid',
      `crypto: ${Model.name}.${attribute} is bound to its row; select the primary key (or the \`row\` column) with it`,
    );
  }
  if (binding.subject === undefined && options.row === false) {
    // Nothing but the subject ties the value to its owner here: it has to be checked.
    throw new SubjectKeyError(
      'invalid',
      `crypto: ${Model.name}.${attribute} has no row binding; select the subject column with it`,
    );
  }
  const text = await subjects.decrypt(sealed.ciphertext, {
    aad: binding.aad,
    ...(binding.subject !== undefined ? { subject: binding.subject } : { anySubject: true }),
  });
  const value = decode(Model, attribute, text, options.json === true);
  model.$attributes[attribute] = value;
  model.$original[attribute] = clone(value);
  remember(model, attribute, `${parsed.key}\u0000${binding.aad}`);
}

/** A stored value without the subject prefix: plaintext through `legacyPlaintext`, or refused. */
function openRaw(
  model: LucidModelInstance,
  Model: LucidModelLike,
  attribute: string,
  options: EncryptedColumnOptions,
  raw: unknown,
): void {
  if (typeof raw === 'string' && raw.startsWith('agora:')) {
    throw new SubjectKeyError(
      'invalid',
      `crypto: ${Model.name}.${attribute} holds another kind of agora ciphertext, not a subject value`,
    );
  }
  const legacy =
    typeof options.legacyPlaintext === 'function'
      ? options.legacyPlaintext(model as never) === true
      : options.legacyPlaintext === true;
  if (!legacy) {
    throw new SubjectKeyError(
      'invalid',
      `crypto: ${Model.name}.${attribute} is not encrypted in the database (turn on \`legacyPlaintext\` while a backfill runs)`,
    );
  }
  let value: unknown;
  if (options.json) {
    value = typeof raw === 'string' ? decode(Model, attribute, raw, true) : raw;
  } else {
    if (typeof raw !== 'string') {
      throw new SubjectKeyError(
        'invalid',
        `crypto: ${Model.name}.${attribute} holds a non-string plaintext`,
      );
    }
    value = raw;
  }
  legacyReads += 1;
  options.onLegacyRead?.(model as never, attribute);
  model.$attributes[attribute] = value;
  model.$original[attribute] = clone(value);
  // No binding remembered: the next save of this row encrypts the value.
}

/**
 * The synchronous half Lucid calls when it writes: only the ciphertext `before:save` computed for
 * this exact value, for the row's current subject and id, may reach the database, once. Anything
 * else (a `saveQuietly`, a value or a row changed after the hook ran) throws instead of writing.
 */
function prepareFor(attribute: string, options: EncryptedColumnOptions) {
  return (value: unknown, _attribute: string, model: LucidModelInstance) => {
    if (value === null || value === undefined) return value;
    const Model = model?.constructor as unknown as LucidModelLike | undefined;
    if (value instanceof RawValue) {
      throw new SubjectKeyError(
        'invalid',
        `crypto: ${Model?.name ?? 'model'}.${attribute} was never opened; it cannot be written back`,
      );
    }
    if (value instanceof SealedValue) return value.ciphertext;
    const entry = pending.get(model)?.get(attribute);
    const column = Model?.$getColumn(attribute);
    if (entry && !entry.used && entry.value === value && Model && column) {
      const now = bindingOf(Model, column, options, model, model.$primaryKeyValue);
      if (now.signature === entry.binding) {
        entry.used = true;
        return entry.ciphertext;
      }
    }
    throw new SubjectKeyError(
      'invalid',
      `crypto: ${Model?.name ?? 'model'}.${attribute} would be written without a matching encryption; save it with model.save() (saveQuietly and hook-less writes cannot encrypt)`,
    );
  };
}

/** The synchronous half Lucid calls when it reads: keeps every stored value closed for `after:find`. */
function consumeFor() {
  return (value: unknown) => {
    if (value === null || value === undefined) return value;
    if (isSubjectCiphertext(value)) return new SealedValue(value);
    return new RawValue(value);
  };
}

/** Registers the hooks once per model class (the same functions, so a subclass does not double them). */
function installHooks(Model: LucidModelLike): void {
  Model.before('save', sealHook as never);
  Model.after('save', afterSaveHook as never);
  Model.after('find', openHook as never);
  Model.after('fetch', openHook as never);
}

/**
 * An encrypted Lucid column: the value is sealed with the subject's data key before it is written
 * and opened after the model is loaded, so the app reads and writes plaintext.
 *
 * ```ts
 * import { encrypted } from '@adonis-agora/crypto'
 *
 * export default class Note extends BaseModel {
 *   @column({ isPrimary: true }) declare id: string
 *   @column() declare researcherId: number
 *   @encrypted({ subject: (note: Note) => note.researcherId, namespace: 'researcher' })
 *   declare body: string
 * }
 * ```
 *
 * The database column must be text (`text`, not `json`/`jsonb`).
 */
export function encrypted<Model = unknown>(options: EncryptedColumnOptions<Model>) {
  if (typeof options?.subject !== 'function') {
    throw new Error('crypto: @encrypted needs `subject: (model) => id`');
  }
  return function decorateAsEncrypted(target: object, property: string): void {
    const Model = target.constructor as unknown as LucidModelLike;
    Model.boot();
    Model.$addColumn(property, {
      ...(options.columnName !== undefined ? { columnName: options.columnName } : {}),
      ...(options.serializeAs !== undefined ? { serializeAs: options.serializeAs } : {}),
      ...(options.serialize !== undefined ? { serialize: options.serialize } : {}),
      prepare: prepareFor(property, options as EncryptedColumnOptions),
      consume: consumeFor(),
      meta: { [META]: options },
    });
    if (options.legacyPlaintext) legacyColumns.add(`${Model.name}.${property}`);
    installHooks(Model);
  };
}

/** The encrypted columns of a model: attribute, column name and options (used by the backfill). */
export function encryptedColumnsOf(
  Model: LucidModelLike,
): Array<{ attribute: string; columnName: string; options: EncryptedColumnOptions }> {
  return encryptedColumns(Model).map(([attribute, column, options]) => ({
    attribute,
    columnName: column.columnName,
    options,
  }));
}

export { subjectKeysOf };
