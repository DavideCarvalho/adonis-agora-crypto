import { describe, expect, it } from 'vitest';
import { cryptoDevTools } from '../../src/dev_tools.js';
import { memoryCrypto, seedKeys } from '../../src/testing/index.js';

const call = {
  ctx: {} as never,
  caller: { id: 'agent-1', via: 'token' as const },
  limits: { maxRows: 50, maxBytes: 1_000_000 },
};

function tools() {
  const crypto = memoryCrypto();
  return {
    crypto,
    list: cryptoDevTools(crypto.service, { actorFor: (c) => `mcp:${c.caller.id}` }),
  };
}

describe('dev tools', () => {
  it('is metadata only: four reads, no operation tool at all', () => {
    const { list } = tools();
    expect(list.map((tool) => tool.name).sort()).toEqual([
      'crypto_get_key',
      'crypto_list_audit',
      'crypto_list_keys',
      'crypto_overview',
    ]);
    expect(list.every((tool) => tool.kind === 'read')).toBe(true);
    expect(list.some((tool) => tool.name.match(/encrypt|decrypt|sign|export/))).toBe(false);
  });

  it('lists keys and reads one, without key material', async () => {
    const { crypto, list } = tools();
    await seedKeys(crypto);
    const listKeys = list.find((tool) => tool.name === 'crypto_list_keys')!;
    const result = (await listKeys.run({ app: 'shop' }, call)) as {
      items: Array<{ name: string; type: string; versions: number }>;
      next: number | null;
    };
    expect(result.items).toHaveLength(5);
    expect(result.next).toBeNull();
    expect(result.items.find((item) => item.name === 'inbox')).toMatchObject({
      type: 'x25519',
      versions: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(/sealed|material/);

    const getKey = list.find((tool) => tool.name === 'crypto_get_key')!;
    const key = (await getKey.run({ app: 'shop', key: 'inbox' }, call)) as {
      versions: Array<{ kid?: string; publicKey?: { crv: string } }>;
    };
    expect(key.versions[0]?.publicKey?.crv).toBe('X25519');
    expect(key.versions[0]?.kid).toBeTypeOf('string');
    expect(JSON.stringify(key)).not.toMatch(/"d"/);
  });

  it('pages the audit trail with filters, as the MCP caller', async () => {
    const { crypto, list } = tools();
    await crypto.service.createKey(
      { partition: 'shop', capabilities: ['crypto:*'], actor: 'test' },
      { name: 'orders', type: 'aes256-gcm' },
    );
    const audit = list.find((tool) => tool.name === 'crypto_list_audit')!;
    const result = (await audit.run({ app: 'shop', operation: 'create', limit: 5 }, call)) as {
      items: Array<{ operation: string; actor: string }>;
    };
    expect(result.items[0]).toMatchObject({ operation: 'create', actor: 'test' });

    const overview = list.find((tool) => tool.name === 'crypto_overview')!;
    expect(await overview.run({ app: 'shop' }, call)).toMatchObject({ keys: 1, versions: 1 });
  });

  it('requires the app argument', async () => {
    const { list } = tools();
    await expect(list[0]!.run({}, call)).rejects.toThrow(/app is required/);
  });

  it('answers not_found for an app without that key', async () => {
    const { list } = tools();
    const getKey = list.find((tool) => tool.name === 'crypto_get_key')!;
    await expect(getKey.run({ app: 'shop', key: 'nope' }, call)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
