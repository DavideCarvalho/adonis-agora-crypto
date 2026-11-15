import { describe, expect, it } from 'vitest';
import {
  generateKeyPair as kitGenerateKeyPair,
  openWith as kitOpenWith,
  sealTo as kitSealTo,
} from '../../adonis/src/crypto-kit/index.js';
import { generateKeyPair, jwkThumbprint, openWith, publicJwk, sealTo } from '../src/browser.js';
import { openBrowserIdentity, sealBrowserIdentity } from '../src/identity.js';

describe('browser X25519, byte-compatible with the kit', () => {
  it('computes the same kid as the kit', () => {
    const pair = generateKeyPair();
    expect(pair.publicKey.kid).toBe(jwkThumbprint({ crv: 'X25519', x: pair.publicKey.x }));
    expect(pair.publicKey).toMatchObject({ kty: 'OKP', crv: 'X25519', use: 'enc', alg: 'ECDH-ES' });
    expect(publicJwk(pair.privateKey)).toEqual(pair.publicKey);
    expect(pair.privateKey.kid).toBe(pair.publicKey.kid);
  });

  it('seals in the browser and the kit opens it', () => {
    const pair = generateKeyPair();
    const sealed = sealTo(pair.publicKey, 'laudo do paciente', { aad: 'grant:7' });
    expect(sealed.startsWith(`agora:pk1:${pair.publicKey.kid}:`)).toBe(true);
    expect(sealed).not.toContain('paciente');
    expect(kitOpenWith(pair.privateKey, sealed, { aad: 'grant:7' })).toBe('laudo do paciente');
  });

  it('seals with the kit and the browser opens it', () => {
    const pair = generateKeyPair();
    const sealed = kitSealTo(pair.publicKey, 'shared from the server', { aad: 'grant:9' });
    expect(openWith(pair.privateKey, sealed, { aad: 'grant:9' })).toBe('shared from the server');
  });

  it('refuses a tampered value, a wrong aad and another key', () => {
    const pair = generateKeyPair();
    const other = kitGenerateKeyPair('x25519');
    const sealed = sealTo(pair.publicKey, 'secret', { aad: 'a' });
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(() => openWith(pair.privateKey, tampered, { aad: 'a' })).toThrow();
    expect(() => openWith(pair.privateKey, sealed, { aad: 'b' })).toThrow();
    expect(() => openWith(other.privateKey, sealed, { aad: 'a' })).toThrow(/kid/);
  });

  it('works the other way round: kit seals to a browser key, kit opens a browser seal', () => {
    const browser = generateKeyPair();
    const sealedByKit = kitSealTo(browser.publicKey, 'hello');
    expect(openWith(browser.privateKey, sealedByKit)).toBe('hello');
    const sealedByBrowser = sealTo(browser.publicKey, 'hi');
    expect(kitOpenWith(browser.privateKey, sealedByBrowser)).toBe('hi');
  });
});

describe('browser identity', () => {
  it('seals the private key with a passphrase and opens it back', async () => {
    const identity = generateKeyPair();
    const sealed = await sealBrowserIdentity(identity, 'a long passphrase', { iterations: 1000 });
    expect(sealed).not.toContain(identity.privateKey.d);
    const opened = await openBrowserIdentity(sealed, 'a long passphrase');
    expect(opened.privateKey).toEqual(identity.privateKey);
    expect(opened.publicKey).toEqual(identity.publicKey);
  });

  it('refuses a wrong passphrase, a short passphrase and a corrupted document', async () => {
    const identity = generateKeyPair();
    const sealed = await sealBrowserIdentity(identity, 'a long passphrase', { iterations: 1000 });
    await expect(openBrowserIdentity(sealed, 'another passphrase')).rejects.toThrow(/passphrase/);
    await expect(sealBrowserIdentity(identity, 'short')).rejects.toThrow(/8 characters/);
    await expect(openBrowserIdentity('not json', 'a long passphrase')).rejects.toThrow(/readable/);
  });
});
