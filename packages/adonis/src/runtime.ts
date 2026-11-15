import type { CryptoClient } from '@adonis-agora/crypto-core';
import type { CryptoService } from './crypto/service.js';
import type { CryptoApi } from './http/api.js';
import type { CryptoOperations } from './operations.js';
import type { CryptoStore } from './store/store.js';
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
  /** The same calls everywhere: in-process on a server, over HTTP or a broker on a tenant. */
  operations: CryptoOperations;
  /** Set when the control plane consumes a broker: shuts its consumer down. */
  stopTransport?: () => Promise<void>;
  /** The control plane's tenant verifier, so an out-of-band channel (durable workflow) can use it. */
  verifyTenant?: TenantVerifier;
  /**
   * The operations of one app, as one actor: a server builds them for the named partition (the
   * console, the CLI), a tenant ignores both (its token decides). Used by the ops commands.
   */
  operationsFor(partition: string, actor: string): CryptoOperations;
  status(): CryptoStatus;
}
