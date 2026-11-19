import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Meta } from '../client/crypto-client';
import { App } from './App';

const META: Meta = {
  apps: ['shop', 'billing'],
  defaultPartition: 'shop',
  topology: 'control-plane',
  actor: 'alice',
  keyTypes: [],
  capabilityLegend: [],
};
let meta: Meta = META;

/** Three cursor pages: `c1` → page 2, `c2` → page 3 (the last). */
function auditPage(after: string | null) {
  const n = after === null ? 1 : Number(after.slice(1)) + 1;
  return {
    data: [
      {
        id: `audit-${n}`,
        at: '2026-01-01T00:00:00.000Z',
        partition: 'shop',
        operation: 'encrypt',
        actor: `actor-p${n}`,
        result: 'ok',
      },
    ],
    meta: {
      nextCursor: n < 3 ? `c${n}` : null,
      prevCursor: n > 1 ? `p${n}` : null,
      hasNext: n < 3,
      hasPrev: n > 1,
    },
  };
}

const originalFetch = globalThis.fetch;
let urls: string[] = [];

function key(name: string) {
  return {
    partition: 'shop',
    name,
    type: 'aes256-gcm96',
    latestVersion: 1,
    minDecryptionVersion: 1,
    deletionAllowed: false,
    exportable: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'alice',
    versions: [],
  };
}

function page<T>(data: T[], currentPage = 1, lastPage = 3) {
  return {
    data,
    meta: { total: lastPage * 50, perPage: 50, currentPage, lastPage, firstPage: 1 },
  };
}

beforeEach(() => {
  urls = [];
  meta = META;
  const data = document.createElement('script');
  data.id = 'crypto-dashboard-config';
  data.type = 'application/json';
  data.textContent = JSON.stringify({ base: '/crypto', api: '/crypto/api' });
  document.body.appendChild(data);
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const params = new URL(url, 'http://x').searchParams;
    const body = url.includes('/meta')
      ? meta
      : url.includes('/keys')
        ? page([key(`key-p${params.get('page')}`)], Number(params.get('page')))
        : url.includes('/audit')
          ? auditPage(params.get('after'))
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

/** Opens a kit combobox (Base UI opens on ArrowDown in jsdom), types, and picks an option. */
async function pickCombo(label: string, text: string, option: string | RegExp = text) {
  const input = screen.getByRole('combobox', { name: label });
  await act(async () => {
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.change(input, { target: { value: text } });
    await new Promise((r) => setTimeout(r, 20));
  });
  const item = await screen.findByRole('option', { name: option });
  await act(async () => {
    fireEvent.click(item);
    await new Promise((r) => setTimeout(r, 20));
  });
}

/** Opens the topbar's App menu (the kit's ScopeMenu), searches, and picks an app. */
async function pickApp(text: string, option: string) {
  fireEvent.click(appButton());
  fireEvent.change(await screen.findByRole('combobox', { name: 'Search apps' }), {
    target: { value: text },
  });
  await act(async () => {
    fireEvent.mouseDown(await screen.findByRole('option', { name: option }));
    await new Promise((r) => setTimeout(r, 20));
  });
}

const appButton = () => screen.getByRole('button', { name: /^App/ });

const lastQuery = (path: string) =>
  new URL(urls.filter((u) => u.includes(path)).at(-1) ?? '/', 'http://x').searchParams;

describe('the crypto console: view state in the URL', () => {
  it('opens on the app, search and page a shared link names', async () => {
    window.history.replaceState(null, '', '/crypto#/keys?app=billing&q=pay&page=2');
    renderApp();
    await screen.findByText('key-p2');
    const query = lastQuery('/keys');
    expect(query.get('partition')).toBe('billing');
    expect(query.get('search')).toBe('pay');
    expect(query.get('page')).toBe('2');
    expect(appButton().textContent).toContain('billing');
    expect((screen.getByLabelText('Search keys') as HTMLInputElement).value).toBe('pay');
  });

  it('typing replaces and goes back to page 1; paging pushes and back returns', async () => {
    window.history.replaceState(null, '', '/crypto#/keys?page=2');
    renderApp();
    await screen.findByText('key-p2');
    const start = window.history.length;
    fireEvent.change(screen.getByLabelText('Search keys'), { target: { value: 'pay' } });
    await waitFor(() => expect(window.location.hash).toBe('#/keys?q=pay'));
    expect(window.history.length).toBe(start);
    await screen.findByText('key-p1');

    fireEvent.click(screen.getByLabelText('Next page'));
    await waitFor(() => expect(window.location.hash).toBe('#/keys?q=pay&page=2'));
    expect(window.history.length).toBe(start + 1);
    await screen.findByText('key-p2');
    act(() => window.history.back());
    await screen.findByText('key-p1');
    expect(window.location.hash).toBe('#/keys?q=pay');
  });

  it('the app pick is in the URL and survives a page change; the default leaves it', async () => {
    window.history.replaceState(null, '', '/crypto#/keys');
    renderApp();
    await screen.findByText('key-p1');
    await pickApp('bil', 'billing');
    await waitFor(() => expect(window.location.hash).toBe('#/keys?app=billing'));
    await waitFor(() => expect(lastQuery('/keys').get('partition')).toBe('billing'));

    fireEvent.click(screen.getByRole('link', { name: 'Audit' }));
    await waitFor(() => expect(window.location.hash).toBe('#/audit?app=billing'));
    await screen.findByRole('combobox', { name: 'Operation' });
    await pickCombo('Operation', 'decr', 'decrypt');
    await waitFor(() => expect(window.location.hash).toBe('#/audit?app=billing&operation=decrypt'));
    await waitFor(() => expect(lastQuery('/audit').get('filter[operation]')).toBe('decrypt'));
    expect(lastQuery('/audit').get('partition')).toBe('billing');

    await pickApp('sho', 'shop');
    await waitFor(() => expect(window.location.hash).toBe('#/audit?operation=decrypt'));
  });

  it('the audit walks by cursor: next pushes `after`, back pops it, a filter resets it', async () => {
    window.history.replaceState(null, '', '/crypto#/audit');
    renderApp();
    await screen.findByText('actor-p1');
    expect(lastQuery('/audit').get('after')).toBeNull();
    expect(lastQuery('/audit').get('first')).toBe('50');
    expect(lastQuery('/audit').get('page')).toBeNull();

    fireEvent.click(screen.getByLabelText('Next page'));
    await screen.findByText('actor-p2');
    await waitFor(() => expect(window.location.hash).toBe('#/audit?after=c1'));
    fireEvent.click(screen.getByLabelText('Next page'));
    await screen.findByText('actor-p3');
    await waitFor(() => expect(window.location.hash).toBe('#/audit?after=c1,c2'));
    expect((screen.getByLabelText('Next page') as HTMLButtonElement).disabled).toBe(true);

    act(() => window.history.back());
    await screen.findByText('actor-p2');
    fireEvent.click(screen.getByLabelText('Previous page'));
    await screen.findByText('actor-p1');
    await waitFor(() => expect(window.location.hash).toBe('#/audit'));

    fireEvent.click(screen.getByLabelText('Next page'));
    await waitFor(() => expect(window.location.hash).toBe('#/audit?after=c1'));
    fireEvent.change(screen.getByLabelText('Result'), { target: { value: 'denied' } });
    await waitFor(() => expect(window.location.hash).toBe('#/audit?result=denied'));
    expect(lastQuery('/audit').get('after')).toBeNull();
  });

  it("the key filter offers the app's keys, searched server-side, and takes a typed name", async () => {
    window.history.replaceState(null, '', '/crypto#/audit');
    renderApp();
    await screen.findByText('actor-p1');
    await pickCombo('Filter by key', 'key', 'key-p1');
    await waitFor(() => expect(window.location.hash).toBe('#/audit?key=key-p1'));
    await waitFor(() => expect(lastQuery('/audit').get('filter[key]')).toBe('key-p1'));
    expect(lastQuery('/keys').get('partition')).toBe('shop');

    await pickCombo('Filter by key', 'orders', 'Use “orders”');
    await waitFor(() => expect(window.location.hash).toBe('#/audit?key=orders'));
    await waitFor(() => expect(lastQuery('/audit').get('filter[key]')).toBe('orders'));
    expect(lastQuery('/keys').get('search')).toBe('orders');
  });

  it('the key type select lists the types `/meta` names', async () => {
    meta = { ...META, keyTypes: ['ed25519', 'x25519'] };
    window.history.replaceState(null, '', '/crypto#/keys');
    renderApp();
    await screen.findByText('key-p1');
    fireEvent.click(screen.getAllByRole('button', { name: 'New key' })[0]!);
    const select = (await screen.findByLabelText('Type')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['ed25519', 'x25519']);
  });

  it('an old `#/keys?key=<name>` link still opens that key', async () => {
    window.history.replaceState(null, '', '/crypto#/keys?key=payments');
    renderApp();
    await waitFor(() => expect(urls.some((u) => u.includes('/keys/payments'))).toBe(true));
  });
});
