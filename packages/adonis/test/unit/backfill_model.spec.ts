import { describe, expect, it } from 'vitest';
import { resolveBackfillModel } from '../../commands/subjects.js';

class Note {
  static query() {}
}
class Memo {
  static query() {}
}

describe('resolveBackfillModel', () => {
  it('uses the default export', () => {
    expect(resolveBackfillModel({ default: Note, Memo }, '#models/note')).toBe(Note);
  });

  it('uses the only model a module exports by name', () => {
    expect(resolveBackfillModel({ Note, helper: () => 1, LIMIT: 3 }, '#models/note')).toBe(Note);
  });

  it('uses the export the caller names', () => {
    expect(resolveBackfillModel({ Note, Memo }, '#models/note', 'Memo')).toBe(Memo);
  });

  it('asks for --export when several models are exported', () => {
    expect(() => resolveBackfillModel({ Note, Memo }, '#models/note')).toThrow(
      /several models \(Note, Memo\); pick one with --export/,
    );
  });

  it('refuses a module without a model', () => {
    expect(() => resolveBackfillModel({ helper: () => 1 }, '#models/note')).toThrow(/no model/);
    expect(() => resolveBackfillModel({ Note }, '#models/note', 'Nope')).toThrow(
      /no model exported as "Nope"/,
    );
  });
});
