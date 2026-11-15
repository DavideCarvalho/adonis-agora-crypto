import { describe, expect, it } from 'vitest';
import { exactTime, plural, resultTone, shortKid, versionTone } from './format';

describe('format', () => {
  it('shortens a kid for a table cell', () => {
    expect(shortKid(undefined)).toBe('—');
    expect(shortKid('abc')).toBe('abc');
    expect(shortKid('abcdefghijklmnopqrst')).toBe('abcdefghijklmn…');
  });

  it('maps version status and audit result to badge tones', () => {
    expect(versionTone('latest')).toBe('good');
    expect(versionTone('decryptable')).toBe('info');
    expect(versionTone('retired')).toBe('outline');
    expect(resultTone('ok')).toBe('good');
    expect(resultTone('denied')).toBe('warn');
    expect(resultTone('error')).toBe('destructive');
  });

  it('pluralizes counters and tolerates an absent timestamp', () => {
    expect(plural(1, 'key')).toBe('1 key');
    expect(plural(3, 'key')).toBe('3 keys');
    expect(plural(2, 'version')).toBe('2 versions');
    expect(exactTime(undefined)).toBe('—');
  });
});
