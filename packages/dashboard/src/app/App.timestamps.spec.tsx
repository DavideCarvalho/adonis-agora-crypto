import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Meta } from '../client/crypto-client';
import { App } from './App';
import { exactTime } from './format';

const META: Meta = {
  apps: ['shop'],
  defaultPartition: 'shop',
  topology: 'control-plane',
  actor: 'alice',
  keyTypes: [],
  capabilityLegend: [],
};

const CREATED = '2026-01-01T00:00:00.000Z';
const UPDATED = '2026-02-01T00:00:00.000Z';

function key(name: string, updated: boolean) {
  return {
    partition: 'shop',
    name,
    type: 'aes256-gcm',
    latestVersion: 1,
    minDecryptionVersion: 1,
    deletionAllowed: false,
    exportable: false,
    createdAt: CREATED,
    createdBy: 'alice',
    ...(updated ? { updatedAt: UPDATED, updatedBy: 'bob' } : {}),
    versions: [],
  };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  const data = document.createElement('script');
  data.id = 'crypto-dashboard-config';
  data.type = 'application/json';
  data.textContent = JSON.stringify({ base: '/crypto', api: '/crypto/api' });
  document.body.appendChild(data);
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/meta')
      ? META
      : url.includes('/keys/orders')
        ? key('orders', true)
        : url.includes('/keys/legacy')
          ? key('legacy', false)
          : url.includes('/keys')
            ? {
                data: [key('orders', true)],
                meta: { total: 1, perPage: 50, currentPage: 1, lastPage: 1, firstPage: 1 },
              }
            : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  document.getElementById('crypto-dashboard-config')?.remove();
});

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

describe('the crypto console: created and updated', () => {
  it('lists keys with a Created column carrying the full timestamp in its title', async () => {
    window.history.replaceState(null, '', '/crypto#/keys');
    renderApp();
    await screen.findAllByText('orders');
    expect(screen.getAllByRole('columnheader', { name: 'Created' }).length).toBeGreaterThan(0);
    expect(document.querySelector(`[title="${exactTime(CREATED)}"]`)).not.toBeNull();
  });

  it('shows Created and Updated on a key', async () => {
    window.history.replaceState(null, '', '/crypto#/keys?key=orders');
    renderApp();
    expect(await screen.findByText(`${exactTime(UPDATED)} by bob`)).toBeTruthy();
    expect(screen.getByText(`${exactTime(CREATED)} by alice`)).toBeTruthy();
    expect(screen.getByText('Updated')).toBeTruthy();
  });

  it('shows — as Updated on a key that never recorded one', async () => {
    window.history.replaceState(null, '', '/crypto#/keys?key=legacy');
    renderApp();
    await screen.findByText(`${exactTime(CREATED)} by alice`);
    const updated = screen.getByText('Updated');
    expect(updated.nextElementSibling?.textContent).toBe('—');
  });
});
