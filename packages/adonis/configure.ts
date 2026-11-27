import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace add @adonis-agora/crypto`:
 *
 * 1. registers the provider in `adonisrc.ts`;
 * 2. publishes `config/crypto.ts` as a standalone app (change `topology` for a server; pass
 *    `--topology=tenant` for the one-line tenant form), the tables' migration and the audit filters'
 *    index migration;
 * 3. adds the variables the tenant topology reads to the env validations.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  // biome-ignore lint/suspicious/noExplicitAny: `updateRcFile` types its callback loosely.
  await codemods.updateRcFile((rcFile: any) => {
    rcFile.addProvider('@adonis-agora/crypto/crypto_provider');
    rcFile.addCommand('@adonis-agora/crypto/commands');
  });

  const stubs = stubsRoot();
  // `--topology=tenant`: an app of a Hub's crypto server, in the one-line form.
  const tenant = command.parsedFlags?.topology === 'tenant';
  await codemods.makeUsingStub(
    stubs,
    tenant ? 'config/crypto_tenant.stub' : 'config/crypto.stub',
    {},
  );
  await codemods.makeUsingStub(stubs, 'database/migrations/create_crypto_tables.stub', {});
  // Opt-in on an existing install (built CONCURRENTLY on Postgres): the audit filters' indexes.
  await codemods.makeUsingStub(
    stubs,
    'database/migrations/add_crypto_audit_filter_indexes.stub',
    {},
  );

  await codemods.defineEnvValidations({
    leadingComment: 'Agora crypto',
    variables: {
      CRYPTO_APP: 'Env.schema.string.optional()',
      CRYPTO_URL: 'Env.schema.string.optional()',
      CRYPTO_TOKEN: 'Env.schema.string.optional()',
      CRYPTO_ROOT_KEY: 'Env.schema.string.optional()',
    },
  });

  command.logger.info(
    'A control plane must exempt its tenant API from Shield CSRF: exceptRoutes: (ctx) => cryptoCsrfExceptions(ctx.request.url()), imported from @adonis-agora/crypto.',
  );
  command.logger.info(
    'Key material is sealed with the app’s encryption service (config/encryption.ts) by default. After rotating the root, run `node ace crypto:keys:reseal` to move the stored material.',
  );
}
