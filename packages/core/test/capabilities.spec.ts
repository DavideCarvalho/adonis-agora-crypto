import { describe, expect, it } from 'vitest';
import {
  CryptoError,
  capabilityAllows,
  cryptoScope,
  isValidKeyName,
  missingCapability,
  statusForErrorCode,
} from '../src/index.js';

describe('capabilities', () => {
  it('matches a key-scoped capability exactly', () => {
    expect(capabilityAllows(['crypto:encrypt:orders'], 'crypto:encrypt:orders')).toBe(true);
    expect(capabilityAllows(['crypto:encrypt:orders'], 'crypto:encrypt:invoices')).toBe(false);
    expect(capabilityAllows(['crypto:encrypt:orders'], 'crypto:decrypt:orders')).toBe(false);
  });

  it('treats a `*` segment as the rest of the capability', () => {
    expect(capabilityAllows(['crypto:*'], 'crypto:decrypt:orders')).toBe(true);
    expect(capabilityAllows(['crypto:*'], 'crypto:keys:manage')).toBe(true);
    expect(capabilityAllows(['crypto:encrypt:*'], 'crypto:encrypt:orders')).toBe(true);
    expect(capabilityAllows(['crypto:encrypt:*'], 'crypto:decrypt:orders')).toBe(false);
    expect(capabilityAllows(['crypto:keys:*'], 'crypto:keys:read')).toBe(true);
    expect(capabilityAllows(['crypto:*:orders'], 'crypto:sign:orders')).toBe(true);
    expect(capabilityAllows(['crypto:*:orders'], 'crypto:sign:invoices')).toBe(false);
  });

  it('matches a key-name prefix with `prefix*`, one segment only', () => {
    expect(capabilityAllows(['crypto:decrypt:subject_*'], 'crypto:decrypt:subject_42')).toBe(true);
    expect(capabilityAllows(['crypto:decrypt:subject_*'], 'crypto:decrypt:orders')).toBe(false);
    expect(capabilityAllows(['crypto:decrypt:subject_*'], 'crypto:decrypt:subject_')).toBe(false);
    expect(capabilityAllows(['crypto:decrypt:subject_*'], 'crypto:encrypt:subject_1')).toBe(false);
    expect(capabilityAllows(['crypto:decrypt:subject_*'], 'crypto:decrypt:subject_1:x')).toBe(
      false,
    );
    expect(capabilityAllows(['crypto:keys:manage:subject_*'], 'crypto:keys:manage')).toBe(false);
    expect(capabilityAllows(['crypto:keys:manage:subject_*'], 'crypto:keys:manage:subject_9')).toBe(
      true,
    );
  });

  it('applies a prefix only to the key-name segment', () => {
    expect(capabilityAllows(['crypto:d*:orders'], 'crypto:decrypt:orders')).toBe(false);
    expect(capabilityAllows(['c*:encrypt:x'], 'crypto:encrypt:x')).toBe(false);
    expect(capabilityAllows(['crypto:keys:m*'], 'crypto:keys:manage')).toBe(false);
    expect(capabilityAllows(['crypto:k*:manage:x'], 'crypto:keys:manage:x')).toBe(false);
    expect(capabilityAllows(['crypto:keys:read:sub*'], 'crypto:keys:read:subject_1')).toBe(true);
    expect(capabilityAllows(['crypto:encrypt:sub*'], 'crypto:encrypt:subject_1')).toBe(true);
  });

  it('never implies an operation from another product or an empty grant', () => {
    expect(capabilityAllows([], 'crypto:encrypt:orders')).toBe(false);
    expect(capabilityAllows(['config:read'], 'crypto:encrypt:orders')).toBe(false);
    expect(capabilityAllows(['crypto:encrypt'], 'crypto:encrypt:orders')).toBe(false);
    expect(capabilityAllows(['crypto:encrypt:orders:extra'], 'crypto:encrypt:orders')).toBe(false);
  });

  it('reports the first missing capability', () => {
    expect(
      missingCapability(['crypto:keys:read'], ['crypto:keys:read', 'crypto:encrypt:orders']),
    ).toBe('crypto:encrypt:orders');
    expect(missingCapability(['crypto:*'], ['crypto:keys:read'])).toBeUndefined();
  });

  it('builds the scope of an operation', () => {
    expect(cryptoScope('encrypt', 'orders')).toBe('crypto:encrypt:orders');
    expect(cryptoScope('datakey', 'root')).toBe('crypto:datakey:root');
  });
});

describe('key names', () => {
  it('accepts flat lowercase names and refuses anything that would break a capability', () => {
    expect(isValidKeyName('orders')).toBe(true);
    expect(isValidKeyName('orders-v2_key')).toBe(true);
    expect(isValidKeyName('Orders')).toBe(false);
    expect(isValidKeyName('orders:eu')).toBe(false);
    expect(isValidKeyName('')).toBe(false);
    expect(isValidKeyName('1orders')).toBe(false);
    expect(isValidKeyName(`a${'b'.repeat(63)}`)).toBe(false);
  });
});

describe('errors', () => {
  it('carries a wire code and its status', () => {
    const error = new CryptoError('forbidden', 'crypto: nope');
    expect(error.code).toBe('forbidden');
    expect(error.status).toBe(403);
    expect(statusForErrorCode('not_found')).toBe(404);
    expect(statusForErrorCode('unreadable')).toBe(500);
  });
});
