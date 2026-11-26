import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Meta } from '../client/crypto-client';
import { App } from './App';

const META: Meta = {
  apps: ['eduliberta', 'et', 'ro'],
  federated: [
    { id: 'et', label: 'Entre Textos', mode: 'federated', actions: 'app' },
    { id: 'ro', label: 'Read Only', mode: 'federated', actions: 'none' },
  ],
  defaultPartition: 'eduliberta',
  topology: 'control-plane',
  actor: 'ana',
  keyTypes: [],
  capabilityLegend: [],
};

const KEY = {
  partition: 'entre-textos',
  name: 'thesis',
  type: 'aes256-gcm',
  latestVersion: 2,
  minDecryptionVersion: 1,
  deletionAllowed: false,
  exportable: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'deploy',
  versions: [],
};

const originalFetch = globalThis.fetch;
let calls: Array<{ method: string; url: string }> = [];
let meta: Meta = META;

beforeEach(() => {
  calls = [];
  meta = META;
  const data = document.createElement('script');
  data.id = 'crypto-dashboard-config';
  data.type = 'application/json';
  data.textContent = JSON.stringify({ base: '/crypto', api: '/crypto/api' });
  document.body.appendChild(data);
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? 'GET', url });
    const body = url.includes('/meta')
      ? meta
      : url.includes('/test')
        ? {
            key: 'thesis',
            type: 'aes256-gcm',
            version: 2,
            ok: true,
            operations: ['encrypt', 'decrypt'],
          }
        : url.includes('/keys/thesis')
          ? KEY
          : url.includes('/keys')
            ? {
                data: [KEY],
                meta: { total: 1, perPage: 50, currentPage: 1, lastPage: 1, firstPage: 1 },
              }
            : url.includes('/audit')
              ? {
                  data: [],
                  meta: { nextCursor: null, prevCursor: null, hasNext: false, hasPrev: false },
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

describe('the federated crypto console', () => {
  it('shows the badge and the notice, and tests a key through the app', async () => {
    window.history.replaceState(null, '', '/crypto#/keys?app=et&key=thesis');
    renderApp();
    await screen.findByRole('heading', { name: 'thesis' });
    expect(document.querySelector('[data-app-mode="federated"]')).not.toBeNull();
    expect(document.querySelector('[data-federated-notice]')?.textContent).toMatch(
      /Entre Textos's own store/,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() =>
      expect(document.querySelector('[data-key-test="ok"]')?.textContent).toMatch(
        /encrypt \+ decrypt with v2/,
      ),
    );
    expect(
      calls.some((c) => c.method === 'POST' && c.url.includes('/keys/thesis/test?partition=et')),
    ).toBe(true);
  });

  it('a read-only federated app disables every key operation', async () => {
    window.history.replaceState(null, '', '/crypto#/keys?app=ro');
    renderApp();
    await screen.findByText('thesis');
    const create = screen.getAllByRole('button', { name: 'New key' }) as HTMLButtonElement[];
    expect(create.every((button) => button.disabled)).toBe(true);
    expect(create[0]?.title).toMatch(/read-only here/);
    const rotate = screen.getByRole('button', { name: 'Rotate' }) as HTMLButtonElement;
    expect(rotate.disabled).toBe(true);
  });

  it('a viewer whose grant lacks crypto:keys:manage cannot change keys, but may still test them', async () => {
    meta = { ...META, capabilities: ['crypto:keys:read', 'crypto:encrypt:*', 'crypto:decrypt:*'] };
    window.history.replaceState(null, '', '/crypto#/keys?key=thesis');
    renderApp();
    await screen.findByRole('heading', { name: 'thesis' });
    const rotate = screen.getByRole('button', { name: 'Rotate' }) as HTMLButtonElement;
    expect(rotate.disabled).toBe(true);
    expect(rotate.title).toMatch(/needs crypto:keys:manage/);
    expect((screen.getByRole('button', { name: 'Test' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('a read-only viewer cannot test a key either', async () => {
    meta = { ...META, capabilities: ['crypto:keys:read'] };
    window.history.replaceState(null, '', '/crypto#/keys?key=thesis');
    renderApp();
    await screen.findByRole('heading', { name: 'thesis' });
    const test = screen.getByRole('button', { name: 'Test' }) as HTMLButtonElement;
    expect(test.disabled).toBe(true);
    expect(test.title).toMatch(/needs crypto:encrypt:thesis/);
  });
});
