import type {
  CreateKeyInput,
  CryptoAuditRecord,
  CryptoKeyView,
  CryptoOverview,
  DataKeyInput,
  DataKeyResult,
  DecryptInput,
  DecryptResult,
  EncryptInput,
  EncryptResult,
  ExportKeyResult,
  HmacInput,
  HmacResult,
  KeyPolicyInput,
  OffsetPage,
  PublicKeyResult,
  RewrapInput,
  RewrapResult,
  SignInput,
  SignResult,
  VerifyInput,
  VerifyResult,
  Whoami,
} from '@adonis-agora/crypto-core';
import type { AuditListQuery } from '../src/crypto/service.js';
import type { OperationListQuery } from '../src/operations.js';
import type { CryptoStatus } from '../src/runtime.js';
import { getRuntime, hasRuntime } from '../src/services/accessor.js';
import type { SubjectId, SubjectKeys } from '../src/subjects/subject_keys.js';

/**
 * `import crypto from '@adonis-agora/crypto/services/main'` — every crypto operation of this app.
 *
 * ```ts
 * import crypto from '@adonis-agora/crypto/services/main'
 *
 * const { ciphertext, version } = await crypto.encrypt({ key: 'pii', plaintext: email })
 * const { plaintext } = await crypto.decrypt({ key: 'pii', ciphertext })
 * const signature = await crypto.sign({ key: 'webhook-signing', message: body })
 * ```
 *
 * On a standalone app or a control plane the call runs in process; on a tenant it goes to the
 * central server over HTTP. Same calls either way.
 */
const crypto = {
  /** Whether the crypto runtime is booted (safe to call from anywhere). */
  get ready(): boolean {
    return hasRuntime();
  },

  get topology(): 'standalone' | 'control-plane' | 'tenant' | undefined {
    return hasRuntime() ? getRuntime().topology : undefined;
  },

  /** The app name on a server, the partition on a tenant. */
  get partition(): string | undefined {
    return hasRuntime() ? getRuntime().partition : undefined;
  },

  encrypt(input: EncryptInput): Promise<EncryptResult> {
    return getRuntime().operations.encrypt(input);
  },

  decrypt(input: DecryptInput): Promise<DecryptResult> {
    return getRuntime().operations.decrypt(input);
  },

  /** Re-encrypts with the latest version without returning the plaintext. */
  rewrap(input: RewrapInput): Promise<RewrapResult> {
    return getRuntime().operations.rewrap(input);
  },

  /** A fresh data key: plaintext plus wrapped, or wrapped only. */
  generateDataKey(input: DataKeyInput): Promise<DataKeyResult> {
    return getRuntime().operations.generateDataKey(input);
  },

  sign(input: SignInput): Promise<SignResult> {
    return getRuntime().operations.sign(input);
  },

  verify(input: VerifyInput): Promise<VerifyResult> {
    return getRuntime().operations.verify(input);
  },

  hmac(input: HmacInput): Promise<HmacResult> {
    return getRuntime().operations.hmac(input);
  },

  keys: {
    list(query: OperationListQuery = {}): Promise<OffsetPage<CryptoKeyView>> {
      return getRuntime().operations.listKeys(query);
    },

    get(name: string): Promise<CryptoKeyView> {
      return getRuntime().operations.getKey(name);
    },

    create(input: CreateKeyInput): Promise<CryptoKeyView> {
      return getRuntime().operations.createKey(input);
    },

    rotate(name: string): Promise<CryptoKeyView> {
      return getRuntime().operations.rotateKey(name);
    },

    updatePolicy(name: string, input: KeyPolicyInput): Promise<CryptoKeyView> {
      return getRuntime().operations.updateKeyPolicy(name, input);
    },

    delete(name: string): Promise<{ key: string; deleted: boolean }> {
      return getRuntime().operations.deleteKey(name);
    },

    export(name: string, version?: number): Promise<ExportKeyResult> {
      return getRuntime().operations.exportKey(name, version);
    },

    publicKey(name: string): Promise<PublicKeyResult> {
      return getRuntime().operations.publicKey(name);
    },
  },

  audit(query: Partial<AuditListQuery> = {}): Promise<OffsetPage<CryptoAuditRecord>> {
    return getRuntime().operations.audit(query);
  },

  /** Console-only read: served by a server, not by the client. */
  overview(): Promise<CryptoOverview> {
    return getRuntime().operations.overview();
  },

  whoami(): Promise<Whoami> {
    return Promise.resolve(getRuntime().operations.whoami());
  },

  /** Where this process stands: local or remote, and whether the last check worked. */
  status(): CryptoStatus | undefined {
    return hasRuntime() ? getRuntime().status() : undefined;
  },

  /**
   * Per-subject keys with local envelopes (`subjects` in `config/crypto.ts`): `encrypt`, `decrypt`,
   * `create`, `forget`, `rotateDataKey`, `rewrapDataKeys`, `evict`.
   */
  get subjects(): SubjectKeys {
    const subjects = getRuntime().subjects;
    if (!subjects) {
      throw new Error(
        '@adonis-agora/crypto: add `subjects: {}` to config/crypto.ts to use subject keys',
      );
    }
    return subjects;
  },

  /**
   * Crypto-shredding: deletes the subject's key, so every value sealed for it is unrecoverable.
   * Same as `crypto.subjects.forget(subjectId)`.
   */
  forgetSubject(subjectId: SubjectId): ReturnType<SubjectKeys['forget']> {
    return crypto.subjects.forget(subjectId);
  },

  /** The tenant client (undefined on a server). */
  get client() {
    return hasRuntime() ? getRuntime().client : undefined;
  },

  /** The store (undefined on a tenant). */
  get store() {
    return hasRuntime() ? getRuntime().store : undefined;
  },

  /** The local service (undefined on a tenant). */
  get service() {
    return hasRuntime() ? getRuntime().service : undefined;
  },
};

export default crypto;
