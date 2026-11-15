import type { CryptoRuntime } from '../runtime.js';

let runtime: CryptoRuntime | undefined;

export function setRuntime(value: CryptoRuntime | undefined): void {
  runtime = value;
}

export function hasRuntime(): boolean {
  return runtime !== undefined;
}

/** The booted config runtime; throws a clear error when the provider is not registered. */
export function getRuntime(): CryptoRuntime {
  if (!runtime) {
    throw new Error(
      '@adonis-agora/crypto is not booted: register "@adonis-agora/crypto/config_provider" in adonisrc.ts',
    );
  }
  return runtime;
}
