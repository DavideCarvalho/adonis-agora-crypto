import { type CryptoKeyType, isCryptoKeyType } from '@adonis-agora/crypto-core';
import { args, BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { resealKeyMaterial } from '../src/crypto/reseal.js';
import { CryptoCommand, commandPrincipal, serviceOf } from './shared.js';

/** `node ace crypto:keys:list [--app] [--json]` */
export class CryptoKeysList extends CryptoCommand {
  static override commandName = 'crypto:keys:list';
  static override description = 'List the keys of one app (metadata only)';

  @flags.string({ description: 'Substring of the name or description' })
  declare search: string;

  override async run(): Promise<void> {
    const partition = await this.partition();
    const page = await this.service.listKeys(commandPrincipal(partition), {
      page: 1,
      size: 200,
      ...(this.search ? { search: this.search } : {}),
    });
    this.output(page, () => {
      if (page.data.length === 0) {
        this.logger.info(`crypto: ${partition} has no keys yet`);
        return;
      }
      this.printKeys(page.data);
    });
  }
}

/** `node ace crypto:keys:show <name>` */
export class CryptoKeysShow extends CryptoCommand {
  static override commandName = 'crypto:keys:show';
  static override description = 'One key: type, policy and versions (metadata only)';

  @args.string({ description: 'Key name' })
  declare name: string;

  override async run(): Promise<void> {
    const partition = await this.partition();
    const view = await this.service.getKey(commandPrincipal(partition), this.name);
    this.output(view, () => this.printKey(view));
  }
}

/** `node ace crypto:keys:create <name> --type <type>` */
export class CryptoKeysCreate extends CryptoCommand {
  static override commandName = 'crypto:keys:create';
  static override description = 'Create a named key with version 1';

  @args.string({ description: 'Key name (lowercase, digits, _ and -)' })
  declare name: string;

  @flags.string({ description: 'Key type: aes256-gcm | x25519 | ed25519 | hmac-sha256' })
  declare type: string;

  @flags.string({ description: 'What the key is for' })
  declare description: string;

  @flags.boolean({ description: 'Allow a later delete' })
  declare deletionAllowed: boolean;

  @flags.boolean({ description: 'Allow exporting the material later' })
  declare exportable: boolean;

  override async run(): Promise<void> {
    const type = (this.type ?? 'aes256-gcm') as CryptoKeyType;
    if (!isCryptoKeyType(type)) {
      this.logger.error(`crypto: unknown key type "${this.type}"`);
      this.exitCode = 1;
      return;
    }
    const partition = await this.partition();
    const created = await this.service.createKey(commandPrincipal(partition), {
      name: this.name,
      type,
      ...(this.description ? { description: this.description } : {}),
      ...(this.deletionAllowed ? { deletionAllowed: true } : {}),
      ...(this.exportable ? { exportable: true } : {}),
    });
    this.output(created, () => {
      this.logger.success(`created ${partition}/${created.name} (${created.type}) v1`);
      if (created.versions[0]?.kid) this.logger.info(`kid ${created.versions[0].kid}`);
    });
  }
}

/** `node ace crypto:keys:rotate <name>` */
export class CryptoKeysRotate extends CryptoCommand {
  static override commandName = 'crypto:keys:rotate';
  static override description = 'Add a new version to a key (old data keeps opening)';

  @args.string({ description: 'Key name' })
  declare name: string;

  override async run(): Promise<void> {
    const partition = await this.partition();
    const rotated = await this.service.rotateKey(commandPrincipal(partition), this.name);
    this.output(rotated, () => {
      this.logger.success(`${partition}/${rotated.name} is now at v${rotated.latestVersion}`);
      this.logger.info(
        `old versions still decrypt down to v${rotated.minDecryptionVersion}; run \`crypto:keys:policy --min-decryption-version ${rotated.latestVersion}\` to retire them after a rewrap`,
      );
    });
  }
}

/** `node ace crypto:keys:policy <name> [...]` */
export class CryptoKeysPolicy extends CryptoCommand {
  static override commandName = 'crypto:keys:policy';
  static override description = 'Change a key policy (decryption floor, deletion, export)';

  @args.string({ description: 'Key name' })
  declare name: string;

  @flags.number({ description: 'Oldest version that may still decrypt' })
  declare minDecryptionVersion: number;

  @flags.boolean({ description: 'Allow deleting the key', showNegatedVariantInHelp: true })
  declare deletionAllowed: boolean;

  @flags.boolean({ description: 'Allow exporting the material', showNegatedVariantInHelp: true })
  declare exportable: boolean;

  @flags.string({ description: 'What the key is for (empty string clears it)' })
  declare description: string;

  override async run(): Promise<void> {
    const partition = await this.partition();
    const updated = await this.service.updateKeyPolicy(commandPrincipal(partition), this.name, {
      ...(this.minDecryptionVersion !== undefined
        ? { minDecryptionVersion: Number(this.minDecryptionVersion) }
        : {}),
      ...(this.deletionAllowed !== undefined ? { deletionAllowed: this.deletionAllowed } : {}),
      ...(this.exportable !== undefined ? { exportable: this.exportable } : {}),
      ...(this.description !== undefined ? { description: this.description } : {}),
    });
    this.output(updated, () => {
      this.logger.success(`updated ${partition}/${updated.name}`);
      this.printKey(updated);
    });
  }
}

/** `node ace crypto:keys:delete <name> [--force]` */
export class CryptoKeysDelete extends CryptoCommand {
  static override commandName = 'crypto:keys:delete';
  static override description = 'Destroy a key and every version (needs deletionAllowed)';

  @args.string({ description: 'Key name' })
  declare name: string;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force: boolean;

  override async run(): Promise<void> {
    const partition = await this.partition();
    const key = await this.service.getKey(commandPrincipal(partition), this.name);
    if (!key.deletionAllowed) {
      this.logger.error(
        `crypto: ${this.name} does not allow deletion; enable it with crypto:keys:policy`,
      );
      this.exitCode = 1;
      return;
    }
    const confirmed = await this.confirm(
      `Destroy ${partition}/${this.name} (${key.latestVersion} version(s))? This cannot be undone.`,
      this.force === true,
    );
    if (!confirmed) {
      this.logger.info('cancelled');
      return;
    }
    const result = await this.service.deleteKey(commandPrincipal(partition), this.name);
    this.output(result, () => this.logger.success(`deleted ${partition}/${this.name}`));
  }
}

/** `node ace crypto:keys:export <name>` */
export class CryptoKeysExport extends CryptoCommand {
  static override commandName = 'crypto:keys:export';
  static override description =
    'Print a key’s material (needs exportable and the export capability)';

  @args.string({ description: 'Key name' })
  declare name: string;

  @flags.number({ description: 'Version to export (default: latest)' })
  declare version: number;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force: boolean;

  override async run(): Promise<void> {
    const partition = await this.partition();
    const confirmed = await this.confirm(
      `Export the private material of ${partition}/${this.name} to stdout?`,
      this.force === true,
    );
    if (!confirmed) {
      this.logger.info('cancelled');
      return;
    }
    const exported = await this.service.exportKey(
      commandPrincipal(partition),
      this.name,
      this.version !== undefined ? Number(this.version) : undefined,
    );
    process.stdout.write(`${JSON.stringify(exported)}\n`);
  }
}

/**
 * `node ace crypto:keys:reseal [--dry-run] [--all] [--json]` — re-seals every key version with the
 * active root key after a `crypto.keys` rotation or a switch to a KMS. The keys, their versions and
 * every ciphertext stay the same; only the envelope around the private material moves. Exit code 1
 * when a version cannot be opened (a lost root) or rewritten.
 */
export class CryptoKeysReseal extends BaseCommand {
  static override commandName = 'crypto:keys:reseal';
  static override description = 'Re-seal key material with the active root key';
  static override options: CommandOptions = { startApp: true };

  @flags.boolean({ description: 'Count what would be re-sealed; change nothing' })
  declare dryRun: boolean;

  @flags.boolean({ description: 'Rewrite every version, even one already on the active root' })
  declare all: boolean;

  @flags.boolean({ description: 'Print one JSON object to stdout' })
  declare json: boolean;

  override async run(): Promise<void> {
    const service = serviceOf();
    const report = await resealKeyMaterial(service.store, service.keyring, {
      dryRun: this.dryRun === true,
      all: this.all === true,
    });
    if (this.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      this.logger.info(
        `${report.dryRun ? 'would re-seal' : 're-sealed'} ${report.resealed} of ${report.scanned} key version(s)${report.all ? ' (--all)' : ''}`,
      );
      const table = this.ui.table();
      table.head(['Status', 'Versions']);
      for (const [status, count] of Object.entries(report.statuses)) {
        table.row([status, String(count)]);
      }
      table.render();
      if (report.failed > 0) {
        this.logger.error(
          `${report.failed} key version(s) could not be opened: the root that sealed them is missing`,
        );
      }
    }
    if (report.failed > 0) this.exitCode = 1;
  }
}
