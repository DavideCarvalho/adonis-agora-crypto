import { getRuntime } from '../services/accessor.js';
import { isSubjectCiphertext, readSubjectCiphertext } from './ciphertext.js';
import { SubjectKeyError } from './errors.js';
import type { SubjectId, SubjectKeys } from './subject_keys.js';

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
  /** Whose key seals the value, e.g. `(note) => note.researcherId`. Required. */
  subject: (model: Model) => SubjectId | null | undefined;
  /** A JSON value (object, array, number, …) stored as ciphertext text. Default `false` (a string). */
  json?: boolean;
  /**
   * Accept values that are still plaintext (no `agora:se1:` prefix) on read, as they are, while a
   * backfill encrypts the table. Writes always encrypt. Default `false`: plaintext on read throws.
   */
  legacyPlaintext?: boolean;
  /**
   * What binds a ciphertext to its row (into the AAD, next to table and column): the primary key by
   * default, so a value copied to another row does not open. The key must be known before the
   * insert (a UUID, or set it yourself); with an auto-increment id use another stable unique column,
   * or `false` to bind table and column only.
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

/**
 * A value read from the database that has not been decrypted (the model hooks did not run, e.g.
 * `Model.$createFromAdapterResult`). It refuses to be used as data: reading it as a string or
 * serializing it throws, so ciphertext can never be mistaken for the value.
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

/** Ciphertext computed in `before:save`, handed to the synchronous `prepare` by identity. */
const pending = new WeakMap<object, Map<string, { value: unknown; ciphertext: string }>>();
/** The subject key each attribute was last sealed with (to re-seal when the subject changes). */
const sealedWith = new WeakMap<object, Map<string, string>>();
/** A marker that makes an attribute dirty so Lucid writes it. */
const FORCE_WRITE = Symbol('crypto.force-write');

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

/** The AAD of one column of one row: `["agora:col", table, column, row]`. */
export function columnAad(table: string, column: string, row: unknown): string {
  return JSON.stringify([
    'agora:col',
    table,
    column,
    row === undefined || row === null ? null : String(row),
  ]);
}

function rowOf(
  model: LucidModelInstance,
  options: EncryptedColumnOptions,
  attribute: string,
  forWrite: boolean,
): string | null | undefined {
  if (options.row === false) return null;
  const value = options.row ? options.row(model) : model.$primaryKeyValue;
  if (value === null || value === undefined || value === '') {
    if (!forWrite) return undefined;
    const Model = model.constructor as unknown as LucidModelLike;
    throw new SubjectKeyError(
      'invalid',
      `crypto: ${Model.name}.${attribute} binds its ciphertext to the row, but the row has no id yet. Assign the primary key before saving (a UUID), point \`row\` at a stable unique column, or set \`row: false\``,
    );
  }
  return String(value);
}

function aadFor(
  model: LucidModelInstance,
  attribute: string,
  column: LucidColumn,
  options: EncryptedColumnOptions,
  forWrite: boolean,
): string | undefined {
  const Model = model.constructor as unknown as LucidModelLike;
  const row = rowOf(model, options, attribute, forWrite);
  if (row === undefined) return undefined;
  return columnAad(Model.table, column.columnName, row);
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

/** `before:save`: seals every encrypted attribute that changed (or whose subject changed). */
async function sealHook(model: LucidModelInstance): Promise<void> {
  const Model = model.constructor as unknown as LucidModelLike;
  const columns = encryptedColumns(Model);
  if (columns.length === 0) return;
  const dirty = model.$isPersisted ? model.$dirty : model.$attributes;
  const stash = new Map<string, { value: unknown; ciphertext: string }>();
  pending.set(model, stash);
  await Promise.all(
    columns.map(async ([attribute, column, options]) => {
      const value = model.$attributes[attribute];
      if (value === null || value === undefined || value instanceof SealedValue) return;
      const subjects = subjectKeysOf(options);
      const subject = options.subject(model as never);
      if (subject === null || subject === undefined || subject === '') {
        throw new SubjectKeyError(
          'invalid',
          `crypto: ${Model.name}.${attribute} needs a subject (its \`subject\` returned ${String(subject)})`,
        );
      }
      const key = subjects.keyName(subject);
      const changed = attribute in dirty;
      const moved = sealedWith.get(model)?.get(attribute) !== key;
      if (!changed && !moved) return;
      const ciphertext = await subjects.encrypt(
        subject,
        encode(Model, attribute, value, options.json === true),
        { aad: aadFor(model, attribute, column, options, true) },
      );
      stash.set(attribute, { value, ciphertext });
      // Not dirty but sealed for another subject: make Lucid write it.
      if (!changed) model.$original[attribute] = FORCE_WRITE;
    }),
  );
}

/** `after:save`: remembers which subject key each attribute is sealed with. */
function afterSaveHook(model: LucidModelInstance): void {
  const stash = pending.get(model);
  pending.delete(model);
  if (!stash) return;
  for (const [attribute, entry] of stash) {
    const parsed = readSubjectCiphertext(entry.ciphertext);
    if (parsed) remember(model, attribute, parsed.key);
  }
}

function remember(model: LucidModelInstance, attribute: string, key: string): void {
  let keys = sealedWith.get(model);
  if (!keys) {
    keys = new Map();
    sealedWith.set(model, keys);
  }
  keys.set(attribute, key);
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
      work.push(openOne(model, Model, attribute, column, options, value));
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
  const subjects = subjectKeysOf(options);
  const parsed = readSubjectCiphertext(sealed.ciphertext);
  if (!parsed) {
    throw new SubjectKeyError(
      'invalid',
      `crypto: ${Model.name}.${attribute} holds a malformed agora:se1 ciphertext`,
    );
  }
  const subject = options.subject(model as never);
  if (subject !== null && subject !== undefined && subject !== '') {
    if (subjects.keyName(subject) !== parsed.key) {
      throw new SubjectKeyError(
        'invalid',
        `crypto: ${Model.name}.${attribute} is sealed for another subject than its row's`,
      );
    }
  }
  const aad = aadFor(model, attribute, column, options, false);
  if (aad === undefined) {
    throw new SubjectKeyError(
      'invalid',
      `crypto: ${Model.name}.${attribute} is bound to its row; select the primary key (or the \`row\` column) with it`,
    );
  }
  const text = await subjects.decrypt(sealed.ciphertext, { aad });
  const value = decode(Model, attribute, text, options.json === true);
  model.$attributes[attribute] = value;
  model.$original[attribute] = clone(value);
  remember(model, attribute, parsed.key);
}

/**
 * The synchronous half Lucid calls when it writes: only the ciphertext `before:save` computed for
 * this exact value may reach the database. Anything else (a `saveQuietly`, a value changed after
 * the hook ran) throws instead of writing plaintext.
 */
function prepareFor(attribute: string) {
  return (value: unknown, _attribute: string, model: LucidModelInstance) => {
    if (value === null || value === undefined) return value;
    if (value instanceof SealedValue) return value.ciphertext;
    const entry = pending.get(model)?.get(attribute);
    if (entry && entry.value === value) return entry.ciphertext;
    const Model = model?.constructor as unknown as LucidModelLike | undefined;
    throw new SubjectKeyError(
      'invalid',
      `crypto: ${Model?.name ?? 'model'}.${attribute} would be written without encryption; save it with model.save() (saveQuietly and hook-less writes cannot encrypt)`,
    );
  };
}

/** The synchronous half Lucid calls when it reads: keeps ciphertext sealed for `after:find`. */
function consumeFor(attribute: string, options: EncryptedColumnOptions) {
  return (value: unknown, _attribute: string, model: LucidModelInstance) => {
    if (value === null || value === undefined) return value;
    if (isSubjectCiphertext(value)) return new SealedValue(value);
    const Model = model?.constructor as unknown as LucidModelLike | undefined;
    if (!options.legacyPlaintext) {
      throw new SubjectKeyError(
        'invalid',
        `crypto: ${Model?.name ?? 'model'}.${attribute} is not encrypted in the database (turn on \`legacyPlaintext\` while a backfill runs)`,
      );
    }
    if (!options.json) {
      if (typeof value !== 'string') {
        throw new SubjectKeyError(
          'invalid',
          `crypto: ${Model?.name ?? 'model'}.${attribute} holds a non-string plaintext`,
        );
      }
      return value;
    }
    return typeof value === 'string'
      ? decode(Model as LucidModelLike, attribute, value, true)
      : value;
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
 *   @encrypted({ subject: (note: Note) => note.researcherId }) declare body: string
 *   @encrypted({ subject: (note: Note) => note.researcherId, json: true }) declare answers: Answers
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
      prepare: prepareFor(property),
      consume: consumeFor(property, options as EncryptedColumnOptions),
      meta: { [META]: options },
    });
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
