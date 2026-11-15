import { CryptoError } from '@adonis-agora/crypto-core';
import { flags } from '@adonisjs/core/ace';
import type { CryptoOperations } from '../src/operations.js';
import { getRuntime, hasRuntime } from '../src/services/accessor.js';
import { CryptoCommand, cliActor } from './shared.js';

/**
 * The ops commands use the runtime's operations, so they work on a server (in process, for the app
 * named with `--application`) and on a tenant (over HTTP, where the token names the app) with the
 * same code — the only difference is the config.
 */
async function operationsFor(partition: string): Promise<CryptoOperations> {
  if (!hasRuntime()) {
    throw new Error(
      '@adonis-agora/crypto is not booted: register "@adonis-agora/crypto/crypto_provider" in adonisrc.ts',
    );
  }
  return getRuntime().operationsFor(partition, cliActor());
}

/** `node ace crypto:encrypt --key <name> --value <text>` */
export default class CryptoEncrypt extends CryptoCommand {
  static override commandName = 'crypto:encrypt';
  static override description = 'Encrypt a string with a key (prints the ciphertext)';

  @flags.string({ description: 'Key name', required: true })
  declare key: string;

  @flags.string({ description: 'The plaintext (prefer --value-file or --stdin for secrets)' })
  declare value: string;

  @flags.string({ description: 'Read the plaintext from a file' })
  declare valueFile: string;

  @flags.boolean({ description: 'Read the plaintext from stdin' })
  declare stdin: boolean;

  @flags.string({ description: 'Additional authenticated data (the same must reach decrypt)' })
  declare aad: string;

  @flags.number({ description: 'Encrypt with a specific version (default: latest)' })
  declare version: number;

  override async run(): Promise<void> {
    const plaintext = await this.#input();
    if (plaintext === undefined) {
      this.logger.error('crypto:encrypt needs --value, --value-file or --stdin');
      this.exitCode = 1;
      return;
    }
    try {
      const partition = await this.partition();
      const result = await (await operationsFor(partition)).encrypt({
        key: this.key,
        plaintext,
        ...(this.aad !== undefined ? { aad: this.aad } : {}),
        ...(this.version !== undefined ? { version: Number(this.version) } : {}),
      });
      if (this.json) process.stdout.write(`${JSON.stringify(result)}\n`);
      else process.stdout.write(`${result.ciphertext}\n`);
    } catch (error) {
      this.#fail(error);
    }
  }

  async #input(): Promise<string | undefined> {
    if (this.stdin === true) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8').replace(/\n$/, '');
    }
    if (this.valueFile !== undefined) {
      const { readFile } = await import('node:fs/promises');
      return readFile(this.valueFile, 'utf8');
    }
    return this.value;
  }

  #fail(error: unknown): void {
    if (error instanceof CryptoError) {
      this.logger.error(error.message);
      this.exitCode = 1;
      return;
    }
    throw error;
  }
}

/** `node ace crypto:decrypt --key <name> --value <ciphertext>` */
export class CryptoDecrypt extends CryptoCommand {
  static override commandName = 'crypto:decrypt';
  static override description = 'Decrypt a ciphertext with a key (prints the plaintext)';

  @flags.string({ description: 'Key name', required: true })
  declare key: string;

  @flags.string({ description: 'The ciphertext' })
  declare value: string;

  @flags.string({ description: 'Read the ciphertext from a file' })
  declare valueFile: string;

  @flags.boolean({ description: 'Read the ciphertext from stdin' })
  declare stdin: boolean;

  @flags.string({ description: 'The aad used at encrypt time' })
  declare aad: string;

  override async run(): Promise<void> {
    let ciphertext = this.value;
    if (this.stdin === true) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      ciphertext = Buffer.concat(chunks).toString('utf8').trim();
    } else if (this.valueFile !== undefined) {
      const { readFile } = await import('node:fs/promises');
      ciphertext = (await readFile(this.valueFile, 'utf8')).trim();
    }
    if (ciphertext === undefined || ciphertext === '') {
      this.logger.error('crypto:decrypt needs --value, --value-file or --stdin');
      this.exitCode = 1;
      return;
    }
    try {
      const partition = await this.partition();
      const result = await (await operationsFor(partition)).decrypt({
        key: this.key,
        ciphertext,
        ...(this.aad !== undefined ? { aad: this.aad } : {}),
      });
      if (this.json) process.stdout.write(`${JSON.stringify(result)}\n`);
      else process.stdout.write(`${result.plaintext}\n`);
    } catch (error) {
      if (error instanceof CryptoError) {
        this.logger.error(error.message);
        this.exitCode = 1;
        return;
      }
      throw error;
    }
  }
}

/** `node ace crypto:audit [--app] [--key] [--operation]` */
export class CryptoAuditCommand extends CryptoCommand {
  static override commandName = 'crypto:audit';
  static override description = 'The audit trail of one app (who did what, newest first)';

  @flags.string({ description: 'Only this key' })
  declare key: string;

  @flags.string({ description: 'Only this operation (encrypt, decrypt, rotate, …)' })
  declare operation: string;

  @flags.string({ description: 'Only ok, denied or error' })
  declare result: string;

  @flags.number({ description: 'Rows per page (default 50)' })
  declare limit: number;

  @flags.number({ description: 'Page, 1-based' })
  declare page: number;

  override async run(): Promise<void> {
    const partition = await this.partition();
    const audit = await this.service.audit(
      { partition, capabilities: ['crypto:keys:read'], actor: cliActor() },
      {
        page: this.page !== undefined ? Number(this.page) : 1,
        size: this.limit !== undefined ? Number(this.limit) : 50,
        sort: 'desc',
        filters: {
          ...(this.key ? { key: this.key } : {}),
          ...(this.operation ? { operation: this.operation } : {}),
          ...(this.result ? { result: this.result } : {}),
        },
      },
    );
    this.output(audit, () => {
      if (audit.data.length === 0) {
        this.logger.info(`crypto: ${partition} has no audit rows matching those filters`);
        return;
      }
      const table = this.ui.table();
      table.head(['When', 'Actor', 'Operation', 'Key', 'Version', 'Result', 'Error']);
      for (const row of audit.data) {
        table.row([
          row.at,
          row.actor,
          row.operation,
          row.key ?? '',
          row.version !== undefined ? `v${row.version}` : '',
          row.result,
          row.error ?? '',
        ]);
      }
      table.render();
      this.logger.info(
        `${audit.meta.total} row(s), page ${audit.meta.currentPage}/${audit.meta.lastPage}`,
      );
    });
  }
}
