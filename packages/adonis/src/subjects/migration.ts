import { SUBJECT_CIPHERTEXT_PREFIX } from './ciphertext.js';

export type CheckDialect = 'postgres' | 'mysql' | 'sqlite';

export interface EncryptedColumnCheckOptions {
  /** The encrypted column. */
  column: string;
  /**
   * The column that holds the subject id (`researcher_id`). With it, the database also refuses a
   * value sealed for another subject than the row's — e.g. a query-builder update of the subject
   * column that left the encrypted values behind.
   */
  subjectColumn?: string;
  /** The key prefix (`subjects.prefix`). Default `subject_`. */
  prefix?: string;
  /** The column's `namespace` (subject type), when it has one. */
  namespace?: string;
  dialect?: CheckDialect;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const LITERAL = /^[a-z0-9_-]*$/;

function identifier(name: string, dialect: CheckDialect): string {
  if (!IDENTIFIER.test(name))
    throw new Error(`crypto: invalid SQL identifier ${JSON.stringify(name)}`);
  return dialect === 'mysql' ? `\`${name}\`` : `"${name}"`;
}

/** A LIKE pattern for a literal (escape `!`, `%`, `_` with `!`). */
const likeLiteral = (text: string) => text.replace(/[!%_]/g, (char) => `!${char}`);

/**
 * The SQL condition that keeps an encrypted column honest: `NULL` or an `agora:se1:` value (and,
 * with `subjectColumn`, one sealed for the row's own subject). Put it in a CHECK constraint so a
 * query-builder write (`Model.query().update`, `db.from().insert`) can never store plaintext.
 *
 * ```ts
 * table.text('body').nullable()
 * // in CREATE TABLE (SQLite included):
 * this.schema.raw(`ALTER TABLE notes ADD CONSTRAINT notes_body_encrypted CHECK ${encryptedColumnCheck({ column: 'body', subjectColumn: 'researcher_id', dialect: 'postgres' })}`)
 * ```
 */
export function encryptedColumnCheck(options: EncryptedColumnCheckOptions): string {
  const dialect = options.dialect ?? 'postgres';
  const column = identifier(options.column, dialect);
  if (options.subjectColumn === undefined) {
    return `(${column} IS NULL OR ${column} LIKE '${likeLiteral(SUBJECT_CIPHERTEXT_PREFIX)}%' ESCAPE '!')`;
  }
  const prefix = options.prefix ?? 'subject_';
  const namespace = options.namespace !== undefined ? `${options.namespace}_` : '';
  if (!LITERAL.test(prefix) || !LITERAL.test(namespace)) {
    throw new Error('crypto: prefix and namespace are lowercase letters, digits, "_" and "-"');
  }
  const subject = identifier(options.subjectColumn, dialect);
  const head = `'${likeLiteral(`${SUBJECT_CIPHERTEXT_PREFIX}${prefix}${namespace}`)}'`;
  // The subject id is escaped too (a `_` in it is a literal, not a wildcard).
  const id = `REPLACE(REPLACE(REPLACE(CAST(${subject} AS ${dialect === 'mysql' ? 'CHAR' : 'TEXT'}), '!', '!!'), '%', '!%'), '_', '!_')`;
  const pattern = dialect === 'mysql' ? `CONCAT(${head}, ${id}, ':%')` : `${head} || ${id} || ':%'`;
  return `(${column} IS NULL OR ${column} LIKE ${pattern} ESCAPE '!')`;
}

/**
 * `ALTER TABLE … ADD CONSTRAINT … CHECK (…)` for Postgres and MySQL (SQLite cannot add a constraint
 * to an existing table: put {@link encryptedColumnCheck} in the CREATE TABLE instead).
 * `notValid` (Postgres) enforces it on new writes while old plaintext rows still exist; run
 * `ALTER TABLE … VALIDATE CONSTRAINT …` once the backfill is done.
 */
export function addEncryptedColumnCheck(
  options: EncryptedColumnCheckOptions & { table: string; name?: string; notValid?: boolean },
): string {
  const dialect = options.dialect ?? 'postgres';
  if (dialect === 'sqlite') {
    throw new Error(
      'crypto: SQLite cannot add a CHECK to an existing table; use encryptedColumnCheck() in CREATE TABLE',
    );
  }
  const name = options.name ?? `${options.table}_${options.column}_encrypted`;
  const notValid = options.notValid === true && dialect === 'postgres' ? ' NOT VALID' : '';
  return `ALTER TABLE ${identifier(options.table, dialect)} ADD CONSTRAINT ${identifier(name, dialect)} CHECK ${encryptedColumnCheck({ ...options, dialect })}${notValid}`;
}
