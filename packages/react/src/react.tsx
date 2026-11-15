import { createContext, createElement, type ReactNode, useContext, useMemo, useState } from 'react';
import { type BrowserKeyPair, openWith, type SealOptions, sealTo } from './browser.js';
import { openBrowserIdentity, sealBrowserIdentity } from './identity.js';

export interface CryptoContextValue {
  /** The unlocked identity, or `null` while the app has not unlocked one. */
  identity: BrowserKeyPair | null;
  publicKey: BrowserKeyPair['publicKey'] | null;
  /** Seals a payload to a recipient's public key (`agora:pk1:…`). */
  sealTo(recipient: BrowserKeyPair['publicKey'], value: string, options?: SealOptions): string;
  /** Opens a share with the unlocked identity. Throws when the `kid` is not this identity's. */
  openWith(sealed: string, options?: SealOptions): string;
  /** Unlocks a stored, passphrase-sealed identity. */
  unlock(sealed: string, passphrase: string): Promise<void>;
  /** Generates a new identity and seals it with the passphrase (call the app to register it). */
  create(passphrase: string): Promise<{ identity: BrowserKeyPair; sealed: string }>;
  lock(): void;
}

const CryptoContext = createContext<CryptoContextValue | null>(null);

/**
 * Makes a browser identity available to the React tree:
 *
 * ```tsx
 * <CryptoProvider>
 *   <ShareExamButton publicKey={doctor.publicKey} />
 * </CryptoProvider>
 * ```
 *
 * Nothing is stored or unlocked for you: the app decides how the user unlocks (a passphrase
 * prompt, a session-derived secret) and calls `unlock`/`create` with the sealed document from its
 * own storage (`sealBrowserIdentity`).
 */
export function CryptoProvider({
  identity: initialIdentity,
  children,
}: {
  /** An already-unlocked identity (tests, SSR, a native shell that holds the key). */
  identity?: BrowserKeyPair | null;
  children: ReactNode;
}) {
  const [identity, setIdentity] = useState<BrowserKeyPair | null>(initialIdentity ?? null);

  const value = useMemo<CryptoContextValue>(
    () => ({
      identity,
      publicKey: identity?.publicKey ?? null,
      sealTo: (recipient, payload, options) => sealTo(recipient, payload, options),
      openWith: (sealed, options) => {
        if (!identity) throw new Error('crypto: unlock an identity before opening a share');
        return openWith(identity.privateKey, sealed, options);
      },
      async unlock(sealed, passphrase) {
        setIdentity(await openBrowserIdentity(sealed, passphrase));
      },
      async create(passphrase) {
        const next = (await import('./browser.js')).generateKeyPair();
        const sealed = await sealBrowserIdentity(next, passphrase);
        setIdentity(next);
        return { identity: next, sealed };
      },
      lock() {
        setIdentity(null);
      },
    }),
    [identity],
  );

  return createElement(CryptoContext.Provider, { value }, children);
}

/** The crypto context; throws outside a {@link CryptoProvider}. */
export function useCrypto(): CryptoContextValue {
  const value = useContext(CryptoContext);
  if (!value) throw new Error('crypto: useCrypto must be inside a <CryptoProvider>');
  return value;
}

/** `sealTo` bound to the context, ready for a share button. */
export function useSealTo(): CryptoContextValue['sealTo'] {
  return useCrypto().sealTo;
}

/** `openWith` bound to the unlocked identity. */
export function useOpenWith(): CryptoContextValue['openWith'] {
  return useCrypto().openWith;
}

/** The unlocked public key (or `null`), for rendering "share with me" codes. */
export function usePublicKey(): BrowserKeyPair['publicKey'] | null {
  return useCrypto().publicKey;
}
