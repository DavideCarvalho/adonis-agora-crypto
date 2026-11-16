import { describe, expect, it } from 'vitest';
import { addEncryptedColumnCheck, encryptedColumnCheck } from '../../src/subjects/migration.js';
import { MemoryDataKeyStore } from '../../src/subjects/store.js';
import { SubjectKeys } from '../../src/subjects/subject_keys.js';

const keys = (options: Partial<ConstructorParameters<typeof SubjectKeys>[0]> = {}) =>
  new SubjectKeys({ operations: {} as never, store: new MemoryDataKeyStore(), ...options });

describe('CHECK helpers', () => {
  it('requires a non-null subject and an exact-case prefix', () => {
    const sql = encryptedColumnCheck({ column: 'body', subjectColumn: 'researcher_id' });
    expect(sql).toContain('"researcher_id" IS NOT NULL');
    expect(sql).toContain(`substr("body", 1, length('agora:se1:')) = 'agora:se1:'`);
    expect(sql).not.toMatch(/LIKE/);
    const mysql = encryptedColumnCheck({ column: 'body', subjectColumn: 'r', dialect: 'mysql' });
    expect(mysql).toContain('BINARY');
  });

  it('qualifies the table with its schema, never relying on search_path', () => {
    expect(
      addEncryptedColumnCheck({ table: 'research.notes', column: 'body', notValid: true }),
    ).toMatch(
      /^ALTER TABLE "research"\."notes" ADD CONSTRAINT "notes_body_encrypted" CHECK .* NOT VALID$/,
    );
    expect(addEncryptedColumnCheck({ table: 'notes', schema: 'research', column: 'body' })).toMatch(
      /^ALTER TABLE "research"\."notes"/,
    );
    expect(() =>
      addEncryptedColumnCheck({ table: 'a.notes', schema: 'b', column: 'body' }),
    ).toThrow();
    expect(() => addEncryptedColumnCheck({ table: 'notes;drop', column: 'body' })).toThrow();
  });

  it('follows the subject keys it is given, or refuses what SQL cannot reproduce', () => {
    const sql = encryptedColumnCheck({
      column: 'body',
      subjectColumn: 'researcher_id',
      namespace: 'researcher',
      using: keys({ prefix: 'k_' }),
    });
    expect(sql).toContain(`'agora:se1:k_researcher_'`);
    expect(() =>
      encryptedColumnCheck({ column: 'body', subjectColumn: 'r', using: keys() }),
    ).toThrow(/namespace/);
    expect(() =>
      encryptedColumnCheck({
        column: 'body',
        subjectColumn: 'r',
        namespace: 'researcher',
        using: keys({ keyName: (id) => `custom_${id}` }),
      }),
    ).toThrow(/custom `keyName`/);
  });
});
