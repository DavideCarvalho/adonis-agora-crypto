import { SUBJECT_CIPHERTEXT_PREFIX } from './ciphertext.js';
import type { SubjectKeys } from './subject_keys.js';

export type CheckDialect = 'postgres' | 'mysql' | 'sqlite';

export interface EncryptedColumnCheckOptions {
  /** The encrypted column. */
  column: string;
  /**
   * The column that holds the subject id (`researcher_id`). With it, the database also refuses a
   * value sealed for another subject than the row's (a query-builder update of the subject column
   * that left the encrypted values behind), and a value on a row with no subject.
   */
  subjectColumn?: string;
  /** The column's `namespace` (subject type), when it has one. */
  namespace?: string;
  /**
   * The key prefix (`subjects.prefix`). Default `subject_`. Ignored when `using` is given (its
   * prefix is used).
   */
  prefix?: string;
  /**
   * The app's subject keys: its prefix is used, and a custom `keyName` (which SQL cannot reproduce)
   * is refused instead of producing a check that does not match.
   */
  using?: SubjectKeys;
  dialect?: CheckDialect;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const LITERAL = /^[a-z0-9_-]*$/;
const NAMESPACE = /^[a-z][a-z0-9-]{0,30}$/;

function identifier(name: string, dialect: CheckDialect): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`crypto: invalid SQL identifier ${JSON.stringify(name)}`);
  }
  return dialect === 'mysql' ? `\`${name}\`` : `"${name}"`;
}

/** `schema.table` or `table`, each part quoted (never rely on search_path). */
function tableName(name: string, schema: string | undefined, dialect: CheckDialect): string {
  const [first, second, ...rest] = name.split('.');
  if (rest.length > 0 || first === undefined) {
    throw new Error(`crypto: invalid table ${JSON.stringify(name)}`);
  }
  if (second !== undefined) {
    if (schema !== undefined)
      throw new Error('crypto: give the schema once (`schema` or `schema.table`)');
    return `${identifier(first, dialect)}.${identifier(second, dialect)}`;
  }
  return schema !== undefined
    ? `${identifier(schema, dialect)}.${identifier(first, dialect)}`
    : identifier(first, dialect);
}

/** `true` when `head` is exactly the start of `column` (case-sensitive in every dialect). */
function startsWith(column: string, head: string, dialect: CheckDialect): string {
  if (dialect === 'mysql') {
    return `BINARY SUBSTRING(${column}, 1, CHAR_LENGTH(${head})) = BINARY ${head}`;
  }
  return `substr(${column}, 1, length(${head})) = ${head}`;
}

/**
 * The SQL condition that keeps an encrypted column honest: `NULL`, or a value that starts with
 * `agora:se1:` exactly (case-sensitive) and — with `subjectColumn` — one sealed for the row's own,
 * non-null subject. Put it in a CHECK constraint so a query-builder or raw write can never store
 * plaintext.
 *
 * ```ts
 * // CREATE TABLE (SQLite included):
 * `CHECK ${encryptedColumnCheck({ column: 'body', subjectColumn: 'researcher_id', namespace: 'researcher', dialect: 'sqlite' })}`
 * ```
 */
export function encryptedColumnCheck(options: EncryptedColumnCheckOptions): string {
  const dialect = options.dialect ?? 'postgres';
  const column = identifier(options.column, dialect);
  const exact = startsWith(column, `'${SUBJECT_CIPHERTEXT_PREFIX}'`, dialect);
  if (options.subjectColumn === undefined) {
    return `(${column} IS NULL OR (${exact}))`;
  }
  let prefix = options.prefix ?? 'subject_';
  if (options.using) {
    if (options.using.hasCustomKeyName) {
      throw new Error(
        'crypto: these subject keys use a custom `keyName`, which a CHECK cannot reproduce; use the check without `subjectColumn`',
      );
    }
    prefix = options.using.prefix;
    if (options.using.requiresType && options.namespace === undefined) {
      throw new Error('crypto: these subject keys require a type: pass the column `namespace`');
    }
  }
  if (options.namespace !== undefined && !NAMESPACE.test(options.namespace)) {
    throw new Error('crypto: a namespace is lowercase letters, digits and "-"');
  }
  if (!LITERAL.test(prefix)) {
    throw new Error('crypto: the prefix is lowercase letters, digits, "_" and "-"');
  }
  const namespace = options.namespace !== undefined ? `${options.namespace}_` : '';
  const subject = identifier(options.subjectColumn, dialect);
  const literal = `'${SUBJECT_CIPHERTEXT_PREFIX}${prefix}${namespace}'`;
  const head =
    dialect === 'mysql'
      ? `CONCAT(${literal}, CAST(${subject} AS CHAR), ':')`
      : `(${literal} || CAST(${subject} AS TEXT) || ':')`;
  return `(${column} IS NULL OR (${exact} AND ${subject} IS NOT NULL AND ${startsWith(column, head, dialect)}))`;
}

/**
 * `ALTER TABLE … ADD CONSTRAINT … CHECK (…)` for Postgres and MySQL (SQLite cannot add a constraint
 * to an existing table: put {@link encryptedColumnCheck} in the CREATE TABLE instead). `table` may
 * be `schema.table`, or pass `schema`. `notValid` (Postgres) enforces it on new writes while old
 * plaintext rows still exist; run `ALTER TABLE … VALIDATE CONSTRAINT …` once the backfill is done.
 */
export function addEncryptedColumnCheck(
  options: EncryptedColumnCheckOptions & {
    table: string;
    schema?: string;
    name?: string;
    notValid?: boolean;
  },
): string {
  const dialect = options.dialect ?? 'postgres';
  if (dialect === 'sqlite') {
    throw new Error(
      'crypto: SQLite cannot add a CHECK to an existing table; use encryptedColumnCheck() in CREATE TABLE',
    );
  }
  const bare = options.table.split('.').pop() ?? options.table;
  const name = options.name ?? `${bare}_${options.column}_encrypted`;
  const notValid = options.notValid === true && dialect === 'postgres' ? ' NOT VALID' : '';
  return `ALTER TABLE ${tableName(options.table, options.schema, dialect)} ADD CONSTRAINT ${identifier(name, dialect)} CHECK ${encryptedColumnCheck({ ...options, dialect })}${notValid}`;
}
