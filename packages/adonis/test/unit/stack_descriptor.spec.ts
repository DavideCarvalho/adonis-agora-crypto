import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataKeyStores, defineConfig, stores } from '../../src/define_config.js';
import { STACK_DESCRIPTOR } from '../../src/stack.js';
import { transports } from '../../src/transports/index.js';

const appConfig = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@adonisjs/core/services/app', () => ({
  default: { config: { get: (key: string) => appConfig.current[key] } },
}));

const uses = (value: object) => (value as Record<symbol, unknown>)[STACK_DESCRIPTOR];
const database = {
  connection: 'pg',
  connections: { pg: { client: 'pg' }, vault: { client: 'mysql2' } },
};
const redisLike = { lpush: async () => 0, brpop: async () => null };

afterEach(() => {
  appConfig.current = {};
});

describe('stack descriptors', () => {
  it('names the Lucid connection of the key and data key stores', () => {
    appConfig.current = { database };
    expect(STACK_DESCRIPTOR).toBe(Symbol.for('@adonis-agora/stack'));
    expect(uses(stores.lucid())).toEqual([{ tech: 'postgres', connection: 'pg', purpose: 'keys' }]);
    expect(uses(dataKeyStores.lucid({ connection: 'vault' }))).toEqual([
      { tech: 'mysql', connection: 'vault', purpose: 'data keys' },
    ]);
    expect(uses(stores.memory())).toBeUndefined();
    expect(Object.keys(stores.lucid())).toEqual([]);
  });

  it('describes the defaults on the defineConfig result', () => {
    appConfig.current = { database };
    expect(uses(defineConfig({ app: 'shop', subjects: {} }))).toEqual([
      { tech: 'postgres', connection: 'pg', purpose: 'keys' },
      { tech: 'postgres', connection: 'pg', purpose: 'data keys' },
    ]);
    expect(uses(defineConfig({ app: 'shop', store: stores.memory() }))).toEqual([]);
    expect(
      uses(
        defineConfig({
          topology: 'tenant',
          tenant: { url: 'https://crypto.example.com/_crypto', partition: 'shop', token: 't' },
        }),
      ),
    ).toEqual([]);
  });

  it('describes nothing without a database config', () => {
    expect(uses(defineConfig({ app: 'shop' }))).toEqual([]);
  });

  it('names an @adonisjs/redis connection handed to a broker transport', () => {
    const named = { ...redisLike, connectionName: 'bus' };
    expect(uses(transports.redis({ connection: named }))).toEqual([
      { tech: 'redis', connection: 'bus', purpose: 'tenant link' },
    ]);
    expect(
      uses(
        transports.queue({
          connection: named,
          dispatch: async () => {},
          consume: () => {},
        } as never),
      ),
    ).toEqual([{ tech: 'redis', connection: 'bus', purpose: 'tenant link' }]);
    expect(uses(transports.bullmq({ connection: named }))).toEqual([
      { tech: 'redis', connection: 'bus', purpose: 'tenant link' },
    ]);
    expect(uses(transports.redis({ connection: redisLike }))).toEqual([]);
  });
});
