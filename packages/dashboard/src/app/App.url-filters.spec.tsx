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
      ? META
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
    expect((screen.getByLabelText('app') as HTMLSelectElement).value).toBe('billing');
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
    fireEvent.change(screen.getByLabelText('app'), { target: { value: 'billing' } });
    await waitFor(() => expect(window.location.hash).toBe('#/keys?app=billing'));
    await waitFor(() => expect(lastQuery('/keys').get('partition')).toBe('billing'));

    fireEvent.click(screen.getByRole('link', { name: 'Audit' }));
    await waitFor(() => expect(window.location.hash).toBe('#/audit?app=billing'));
    fireEvent.change(await screen.findByLabelText('Operation'), { target: { value: 'decrypt' } });
    await waitFor(() => expect(window.location.hash).toBe('#/audit?app=billing&operation=decrypt'));
    await waitFor(() => expect(lastQuery('/audit').get('filter[operation]')).toBe('decrypt'));
    expect(lastQuery('/audit').get('partition')).toBe('billing');

    fireEvent.change(screen.getByLabelText('app'), { target: { value: 'shop' } });
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

  it('an old `#/keys?key=<name>` link still opens that key', async () => {
    window.history.replaceState(null, '', '/crypto#/keys?key=payments');
    renderApp();
    await waitFor(() => expect(urls.some((u) => u.includes('/keys/payments'))).toBe(true));
  });
});
