import { userInfo } from 'node:os';
import type { CryptoKeyView } from '@adonis-agora/crypto-core';
import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import type { CryptoPrincipal, CryptoService } from '../src/crypto/service.js';
import { getRuntime, hasRuntime } from '../src/services/accessor.js';

/** `cli:<os user>`, the actor every command records in the audit trail. */
export function cliActor(): string {
  try {
    return `cli:${userInfo().username}`;
  } catch {
    return 'cli';
  }
}

/** The booted server's service, or a clear error (a tenant holds no keys). */
export function serviceOf(): CryptoService {
  if (!hasRuntime()) {
    throw new Error(
      '@adonis-agora/crypto is not booted: register "@adonis-agora/crypto/crypto_provider" in adonisrc.ts',
    );
  }
  const runtime = getRuntime();
  if (!runtime.service) {
    throw new Error(
      '@adonis-agora/crypto: this app is a tenant; its keys are managed on the crypto server',
    );
  }
  return runtime.service;
}

/** The principal a command acts as: the operator, with full rights on one app. */
export function commandPrincipal(app: string): CryptoPrincipal {
  return { partition: app, capabilities: ['crypto:*'], actor: cliActor() };
}

/** Shared flags and helpers for the `crypto:*` commands. */
export abstract class CryptoCommand extends BaseCommand {
  static override options: CommandOptions = { startApp: true };

  @flags.string({
    description: 'Application (partition). Default: the runtime app or the first one',
    alias: 'a',
  })
  declare application: string;

  @flags.boolean({ description: 'Print one JSON object to stdout' })
  declare json: boolean;

  protected get service(): CryptoService {
    return serviceOf();
  }

  /** The app named by `--app`, the runtime's own, or the first one in the store. */
  protected async partition(): Promise<string> {
    if (this.application) return this.application;
    const runtime = getRuntime();
    if (runtime.partition) return runtime.partition;
    const first = (await this.service.store.partitions())[0];
    if (!first) throw new Error('crypto: the store has no app yet; pass --app');
    return first;
  }

  protected output(payload: unknown, human: () => void): void {
    if (this.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
    else human();
  }

  /** Asks before an irreversible action unless `--force` was passed. */
  protected async confirm(message: string, force: boolean): Promise<boolean> {
    if (force) return true;
    return (await this.prompt.confirm(message)) === true;
  }

  protected printKeys(keys: readonly CryptoKeyView[]): void {
    const table = this.ui.table();
    table.head(['Key', 'Type', 'Version', 'Min version', 'Deletable', 'Exportable', 'Deleted']);
    for (const key of keys) {
      table.row([
        key.name,
        key.type,
        `v${key.latestVersion}`,
        `v${key.minDecryptionVersion}`,
        key.deletionAllowed ? 'yes' : '',
        key.exportable ? 'yes' : '',
        key.deletedAt ?? '',
      ]);
    }
    table.render();
  }

  protected printKey(key: CryptoKeyView): void {
    this.logger.info(`${key.partition}/${key.name} (${key.type})`);
    const table = this.ui.table();
    table.head(['Version', 'Status', 'Kid', 'Created by', 'Created at']);
    for (const version of key.versions) {
      table.row([
        `v${version.version}`,
        version.status,
        version.kid ?? '',
        version.createdBy,
        version.createdAt,
      ]);
    }
    table.render();
    const policy = this.ui.table();
    policy.head(['Policy', 'Value']);
    policy.row(['latestVersion', String(key.latestVersion)]);
    policy.row(['minDecryptionVersion', String(key.minDecryptionVersion)]);
    policy.row(['deletionAllowed', key.deletionAllowed ? 'yes' : 'no']);
    policy.row(['exportable', key.exportable ? 'yes' : 'no']);
    if (key.description !== undefined) policy.row(['description', key.description]);
    if (key.deletedAt !== undefined) policy.row(['deletedAt', key.deletedAt]);
    policy.render();
  }
}
