import type { CryptoClient, ServerUrlSource, TenantTokenSource } from '@adonis-agora/crypto-core';
import type { CryptoService } from './crypto/service.js';
import type { CryptoApi } from './http/api.js';
import type { ResolvedInboundEnvelope } from './http/envelope_global.js';
import type { CryptoOperations } from './operations.js';
import type { CryptoStore } from './store/store.js';
import type { SubjectKeys } from './subjects/subject_keys.js';
import type { ResolvedTenantFields } from './topology/tenant_auto.js';
import type { TenantVerifier } from './topology/verify.js';

/** What a tenant loaded: who it is and what its token may do. */
export interface CryptoStatus {
  topology: CryptoRuntime['topology'];
  partition: string;
  /** `remote` on a tenant, `local` on a standalone app or a control plane. */
  mode: 'local' | 'remote';
  /** Last successful `whoami` against the server (tenant only). */
  lastCheckAt?: string;
  lastError?: string;
}

/** Everything the provider built, shared by the service, the console and the commands. */
export interface CryptoRuntime {
  topology: 'standalone' | 'control-plane' | 'tenant';
  /** The app name on a standalone/control-plane, the partition on a tenant. */
  partition: string;
  /** Control plane and standalone only. */
  store?: CryptoStore;
  /** Control plane and standalone only. */
  service?: CryptoService;
  /** Control plane only. */
  api?: CryptoApi;
  /** Tenant only. */
  client?: CryptoClient;
  /**
   * Tenant only: the url, token and partition in use, and where each came from (`config/crypto.ts`
   * or authkit-client's discovery).
   */
  tenant?: {
    url?: ServerUrlSource;
    token?: TenantTokenSource;
    partition: string;
    sources: ResolvedTenantFields['sources'];
    missing: ResolvedTenantFields['missing'];
  };
  /** The same calls everywhere: in-process on a server, over HTTP or a broker on a tenant. */
  operations: CryptoOperations;
  /** Set when the control plane consumes a broker: shuts its consumer down. */
  stopTransport?: () => Promise<void>;
  /** The control plane's tenant verifier, so an out-of-band channel (durable workflow) can use it. */
  verifyTenant?: TenantVerifier;
  /**
   * Set when `config/crypto.ts` has an inbound `envelope`: the server middleware opens the request
   * body with this app's own cipher. Per-app state on purpose — two apps in one process (tests) each
   * keep their own.
   */
  envelope?: ResolvedInboundEnvelope;
  /** Set when `config/crypto.ts` has `subjects`: per-subject keys with local envelopes. */
  subjects?: SubjectKeys;
  /**
   * The operations of one app, as one actor: a server builds them for the named partition (the
   * console, the CLI), a tenant ignores both (its token decides). Used by the ops commands.
   */
  operationsFor(partition: string, actor: string): CryptoOperations;
  status(): CryptoStatus;
}
