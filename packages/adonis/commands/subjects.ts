import { args, BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { getRuntime, hasRuntime } from '../src/services/accessor.js';
import { type BackfillModel, backfillEncryptedColumns } from '../src/subjects/backfill.js';
import { SubjectKeyError } from '../src/subjects/errors.js';
import type { SubjectKeys } from '../src/subjects/subject_keys.js';

function subjectsOf(): SubjectKeys {
  if (!hasRuntime()) {
    throw new Error(
      '@adonis-agora/crypto is not booted: register "@adonis-agora/crypto/crypto_provider" in adonisrc.ts',
    );
  }
  const subjects = getRuntime().subjects;
  if (!subjects) throw new Error('@adonis-agora/crypto: add `subjects: {}` to config/crypto.ts');
  return subjects;
}

abstract class SubjectsCommand extends BaseCommand {
  static override options: CommandOptions = { startApp: true };

  @flags.boolean({ description: 'Print one JSON object to stdout' })
  declare json: boolean;

  protected fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof SubjectKeyError ? ` [${error.code}]` : '';
    this.logger.error(`${message}${code}`);
    this.exitCode = 1;
  }
}

/** `node ace crypto:subjects:backfill #models/note [--batch-size 500] [--from <id>] [--rotate]` */
export class CryptoSubjectsBackfill extends SubjectsCommand {
  static override commandName = 'crypto:subjects:backfill';
  static override description =
    'Encrypt the plaintext of a model’s encrypted columns in place, in batches (resumable)';

  @args.string({ description: 'The model, as the app imports it (#models/note)' })
  declare model: string;

  @flags.number({ description: 'Rows per batch. Default 500' })
  declare batchSize: number;

  @flags.string({
    description: 'Resume after this primary key (the cursor a previous run printed)',
  })
  declare from: string;

  @flags.boolean({ description: 'Also re-encrypt values sealed with a retired data key' })
  declare rotate: boolean;

  @flags.boolean({ description: 'Count what would change; write nothing' })
  declare dryRun: boolean;

  @flags.array({ description: 'Only these attributes (repeat the flag)' })
  declare column: string[];

  @flags.boolean({
    description: 'Skip values that cannot be processed (listed at the end) instead of stopping',
  })
  declare skipErrors: boolean;

  @flags.boolean({
    description:
      'Re-seal values sealed for another subject than their row’s (default: report only)',
  })
  declare adoptMoved: boolean;

  override async run(): Promise<void> {
    try {
      subjectsOf();
      const Model = await this.app.importDefault<BackfillModel & object>(this.model);
      const result = await backfillEncryptedColumns(Model as BackfillModel, {
        ...(this.batchSize !== undefined ? { batchSize: Number(this.batchSize) } : {}),
        // Kept as text: the database compares it with the key ("0042" must not become 42).
        ...(this.from !== undefined ? { after: this.from } : {}),
        ...(this.skipErrors ? { onError: 'skip' as const } : {}),
        ...(this.adoptMoved ? { adoptMoved: true } : {}),
        ...(this.rotate ? { rotate: true } : {}),
        ...(this.dryRun ? { dryRun: true } : {}),
        ...(this.column?.length ? { columns: this.column } : {}),
        onBatch: (progress) => {
          if (this.json) return;
          this.logger.info(
            `${progress.rows} rows · ${progress.encrypted} encrypted · ${progress.reencrypted} re-encrypted · ${progress.moved} moved · ${progress.failed} failed · ${progress.conflicts} conflicts · cursor ${String(progress.cursor)}`,
          );
        },
      });
      if (this.json) {
        process.stdout.write(`${JSON.stringify({ ...result, dryRun: this.dryRun === true })}\n`);
        return;
      }
      this.logger.success(
        `${this.dryRun ? '[dry run] ' : ''}${result.rows} rows: ${result.encrypted} encrypted, ${result.reencrypted} re-encrypted, ${result.moved} sealed for another subject (${result.adopted} adopted), ${result.unchanged} unchanged, ${result.failed} failed, ${result.conflicts} conflicts`,
      );
      if (result.moved > result.adopted) {
        this.logger.warning(
          'some values are sealed for another subject than their row (a query-builder update of the subject column?); they were left alone. Check them, then rerun with --adopt-moved',
        );
      }
      for (const failure of result.failures) {
        this.logger.error(
          `${failure.id} ${failure.attribute}: [${failure.code}] ${failure.message}`,
        );
      }
      if (result.failed > 0) this.exitCode = 1;
      if (result.conflicts > 0) {
        this.logger.warning('rows written concurrently were left alone; run the backfill again');
      }
    } catch (error) {
      this.fail(error);
    }
  }
}

/** `node ace crypto:subjects:rewrap-keys [--subject <id>]` */
export class CryptoSubjectsRewrapKeys extends SubjectsCommand {
  static override commandName = 'crypto:subjects:rewrap-keys';
  static override description =
    'Rewrap stored data keys under the latest version of their subject key (data untouched)';

  @flags.string({ description: 'Only this subject' })
  declare subject: string;

  @flags.string({ description: 'Its type (the column `namespace`)' })
  declare type: string;

  @flags.string({ description: 'Resume after this data key id' })
  declare from: string;

  @flags.number({ description: 'Data keys per batch. Default 200' })
  declare batchSize: number;

  override async run(): Promise<void> {
    try {
      const result = await subjectsOf().rewrapDataKeys({
        ...(this.subject !== undefined
          ? { subject: this.type ? { type: this.type, id: this.subject } : this.subject }
          : {}),
        ...(this.from !== undefined ? { after: this.from } : {}),
        ...(this.batchSize !== undefined ? { batchSize: Number(this.batchSize) } : {}),
        onBatch: (progress) => {
          if (!this.json) {
            this.logger.info(
              `${progress.scanned} scanned · ${progress.rewrapped} rewrapped · cursor ${progress.cursor}`,
            );
          }
        },
      });
      if (this.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      }
      this.logger.success(
        `${result.scanned} data keys: ${result.rewrapped} rewrapped, ${result.forgotten} of forgotten subjects`,
      );
    } catch (error) {
      this.fail(error);
    }
  }
}

/** `node ace crypto:subjects:forget <subject> --force` */
export class CryptoSubjectsForget extends SubjectsCommand {
  static override commandName = 'crypto:subjects:forget';
  static override description =
    'Delete a subject’s key: everything encrypted for it becomes unrecoverable';

  @args.string({ description: 'Subject id' })
  declare subject: string;

  @flags.string({ description: 'Subject type (the column `namespace`), e.g. researcher' })
  declare type: string;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force: boolean;

  override async run(): Promise<void> {
    try {
      const subjects = subjectsOf();
      const subject = this.type ? { type: this.type, id: this.subject } : this.subject;
      const key = subjects.keyName(subject);
      if (
        !this.force &&
        (await this.prompt.confirm(
          `Forget ${this.subject} (${key})? Everything encrypted for it becomes unrecoverable.`,
        )) !== true
      ) {
        this.logger.info('cancelled');
        return;
      }
      const result = await subjects.forget(subject);
      if (this.json) process.stdout.write(`${JSON.stringify(result)}\n`);
      else this.logger.success(`${result.key} deleted; ${result.dataKeys} data keys removed`);
    } catch (error) {
      this.fail(error);
    }
  }
}
