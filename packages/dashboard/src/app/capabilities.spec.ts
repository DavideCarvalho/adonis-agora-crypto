import { describe, expect, it } from 'vitest';
import { mayManageKeys, testDeniedReason } from './capabilities';

describe('the page follows the canonical console matcher', () => {
  it.each([
    'crypto:*:manage',
    '*:keys:manage',
    'crypto:console:w*',
    'crypto:*:write',
    'crypto:k*',
    '*:console:*',
  ])('%s offers no key change and no key test', (grant) => {
    expect(mayManageKeys([grant])).toBe(false);
    expect(testDeniedReason([grant], 'orders', 'aes256-gcm')).toBeDefined();
  });

  it.each([
    [['crypto:console:*'], true],
    [['crypto:console:write'], true],
    [['crypto:keys:manage'], true],
    [['crypto:keys:manage:sub_*'], true],
    [['crypto:console:read'], false],
  ])('%j manages keys: %s', (grant, expected) => {
    expect(mayManageKeys(grant)).toBe(expected);
  });

  it('a key-pattern grant covers a test with a literal operation only', () => {
    expect(
      testDeniedReason(['crypto:encrypt:ord*', 'crypto:decrypt:ord*'], 'orders', 'aes256-gcm'),
    ).toBeUndefined();
    expect(testDeniedReason(['crypto:encrypt:ord*'], 'orders', 'aes256-gcm')).toMatch(
      /crypto:decrypt:orders/,
    );
    expect(testDeniedReason(['crypto:console:read'], 'orders', 'aes256-gcm')).toBeDefined();
  });
});
