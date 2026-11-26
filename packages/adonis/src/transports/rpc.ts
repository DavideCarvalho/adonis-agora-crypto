import {
  assertTransportSize,
  CryptoError,
  type CryptoErrorCode,
  createDedupe,
  type DedupeStore,
  TRANSPORT_MESSAGE_VERSION,
  type TransportCallMessage,
  type TransportOperation,
  type TransportReplyMessage,
  transportDedupeKey,
} from '@adonis-agora/crypto-core';
import type { CryptoPrincipal, CryptoService } from '../crypto/service.js';
import { resolveTenantVerifier, type TenantVerifierInput } from '../topology/verify.js';

export interface CryptoRpcOptions {
  service: CryptoService;
  verifyTenant: TenantVerifierInput;
  /** Default: in-process, TTL 10 min. Multi-replica control planes should pass a shared store. */
  dedupe?: DedupeStore;
  /** Refuse a message older than this. Default 5 min. */
  maxAgeMs?: number;
  maxMessageBytes?: number;
  logger?: { warn(message: string): void };
}

export interface CryptoRpc {
  /** Handles one message. Never throws: a bad message becomes an error reply. */
  handle(message: unknown): Promise<TransportReplyMessage>;
  /** For drivers that dead-letter poison messages instead of replying. */
  isPoison(message: unknown): boolean;
}

const OPERATIONS = new Set<string>([
  'encrypt',
  'decrypt',
  'rewrap',
  'datakeys',
  'sign',
  'verify',
  'hmac',
  'keys.list',
  'keys.get',
  'keys.create',
  'keys.rotate',
  'keys.policy',
  'keys.delete',
  'keys.export',
  'keys.public',
  'keys.has',
  'audit',
  'overview',
  'whoami',
]);

const errorReply = (id: string, code: CryptoErrorCode, message: string): TransportReplyMessage => ({
  v: TRANSPORT_MESSAGE_VERSION,
  id,
  ok: false,
  error: { code, message },
});

/**
 * The control plane side of the call channel, shared by every driver.
 *
 * The token is verified on **every** message (`verifyTenant`), so a shared broker is not a trust
 * boundary; the partition and the capabilities come from the verified token only. The message id is
 * deduped per partition, the payload is size-capped and the age is bounded.
 */
export function createCryptoRpc(options: CryptoRpcOptions): CryptoRpc {
  const verifyTenant = resolveTenantVerifier(options.verifyTenant);
  const dedupe = options.dedupe ?? createDedupe();
  const maxAgeMs = options.maxAgeMs ?? 5 * 60 * 1000;
  const maxBytes = options.maxMessageBytes;

  const parse = (message: unknown): TransportCallMessage | null => {
    if (typeof message !== 'object' || message === null) return null;
    const value = message as Partial<TransportCallMessage>;
    if (
      value.v !== TRANSPORT_MESSAGE_VERSION ||
      typeof value.id !== 'string' ||
      value.id === '' ||
      typeof value.operation !== 'string' ||
      !OPERATIONS.has(value.operation) ||
      typeof value.token !== 'string' ||
      value.token === '' ||
      typeof value.issuedAt !== 'number'
    )
      return null;
    return value as TransportCallMessage;
  };

  const principalFor = async (message: TransportCallMessage): Promise<CryptoPrincipal | null> => {
    const verified = await verifyTenant({ token: message.token });
    if (!verified) return null;
    return {
      partition: verified.partition,
      capabilities: verified.capabilities,
      actor: verified.actor ?? verified.clientId ?? verified.partition,
      ...(verified.clientId !== undefined ? { clientId: verified.clientId } : {}),
    };
  };

  const run = (principal: CryptoPrincipal, message: TransportCallMessage): Promise<unknown> => {
    const service = options.service;
    const input = (message.input ?? {}) as Record<string, unknown>;
    switch (message.operation as TransportOperation) {
      case 'encrypt':
        return service.encrypt(principal, input as never);
      case 'decrypt':
        return service.decrypt(principal, input as never);
      case 'rewrap':
        return service.rewrap(principal, input as never);
      case 'datakeys':
        return service.generateDataKey(principal, input as never);
      case 'sign':
        return service.sign(principal, input as never);
      case 'verify':
        return service.verify(principal, input as never);
      case 'hmac':
        return service.hmac(principal, input as never);
      case 'keys.list':
        return service.listKeys(principal, {
          page: Number(input.page ?? 1),
          size: Number(input.size ?? 50),
        });
      case 'keys.get':
        return service.getKey(principal, String(input.name ?? ''));
      case 'keys.create':
        return service.createKey(principal, input as never);
      case 'keys.rotate':
        return service.rotateKey(principal, String(input.name ?? ''));
      case 'keys.policy':
        return service.updateKeyPolicy(principal, String(input.name ?? ''), input as never);
      case 'keys.delete':
        return service.deleteKey(principal, String(input.name ?? ''));
      case 'keys.export':
        return service.exportKey(
          principal,
          String(input.name ?? ''),
          input.version === undefined ? undefined : Number(input.version),
        );
      case 'keys.has':
        return service.hasKey(principal, { key: String(input.key ?? '') });
      case 'keys.public':
        return service.publicKey(principal, String(input.name ?? ''));
      case 'audit':
        return service.audit(principal, input as never);
      case 'overview':
        return service.overview(principal);
      case 'whoami':
        return Promise.resolve(service.whoami(principal));
      default:
        throw new CryptoError('unsupported', `crypto: unknown operation "${message.operation}"`);
    }
  };

  return {
    isPoison(message) {
      if (parse(message) === null) return true;
      try {
        assertTransportSize(message, maxBytes);
      } catch {
        return true;
      }
      return false;
    },
    async handle(message) {
      const parsed = parse(message);
      if (parsed === null) return errorReply('', 'invalid', 'crypto: malformed transport message');
      try {
        assertTransportSize(parsed, maxBytes);
      } catch (error) {
        return errorReply(parsed.id, 'too_large', (error as Error).message);
      }
      if (Math.abs(Date.now() - parsed.issuedAt) > maxAgeMs) {
        return errorReply(parsed.id, 'invalid', 'crypto: stale transport message');
      }
      const principal = await principalFor(parsed);
      if (principal === null)
        return errorReply(parsed.id, 'unauthenticated', 'crypto: unauthorized');
      if (!dedupe.seen(transportDedupeKey(principal.partition, parsed.id))) {
        return errorReply(parsed.id, 'conflict', 'crypto: duplicate transport message');
      }
      try {
        const result = await run(principal, parsed);
        return { v: TRANSPORT_MESSAGE_VERSION, id: parsed.id, ok: true, result };
      } catch (error) {
        if (error instanceof CryptoError) return errorReply(parsed.id, error.code, error.message);
        options.logger?.warn(`[@adonis-agora/crypto] transport operation failed: ${String(error)}`);
        return errorReply(parsed.id, 'unreadable', 'crypto: transport operation failed');
      }
    },
  };
}
