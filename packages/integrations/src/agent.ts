import type { AgoraDoctorCheck } from '@adonis-agora/crypto';
import type { KmsAdapterLike } from '@adonis-agora/crypto-client';
import { ROOT_KEYS } from './keys.js';
import { type KmsCheckOptions, type KmsIntegrationOptions, kmsDoctorCheck, kmsFor } from './kms.js';

/** agent's poppy-connections root: the refresh tokens, DPoP keys and delegated keys it keeps. */
export const AGENT_ROOT_KEY = ROOT_KEYS.agent;
/** The package the check reports under. */
export const AGENT_PACKAGE = '@adonis-agora/agent';

/**
 * The KMS root for agent's poppy connections:
 *
 * ```ts title="config/poppy.ts"
 * crypto: { kms: agentPoppyKms({ source: { client: crypto } }) }
 * ```
 *
 * Each connection's state (refresh token, DPoP and delegated private keys, sign-in flows) is sealed
 * with a data key wrapped by `agent-poppy-root`.
 */
export function agentPoppyKms(
  options: Omit<KmsIntegrationOptions, 'key'> & { key?: string },
): KmsAdapterLike {
  const key = options.key ?? AGENT_ROOT_KEY;
  return kmsFor(key, { ...options, key });
}

/** `agora:doctor --lib agent`: `agent-poppy-root` exists and this process can use it. */
export function agentPoppyKmsCheck(
  options: Omit<KmsCheckOptions, 'lib' | 'packageName' | 'key'> & { key?: string },
): AgoraDoctorCheck {
  return kmsDoctorCheck({
    ...options,
    lib: 'agent',
    packageName: AGENT_PACKAGE,
    key: options.key ?? AGENT_ROOT_KEY,
    title: 'KMS root for poppy connections',
  });
}
