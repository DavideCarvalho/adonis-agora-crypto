import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  ActivityIcon,
  AppShell,
  DocumentIcon,
  ErrorBoundary,
  PageBody,
  readShellConfig,
  ServerIcon,
} from '../agora-kit';
import { Skeleton } from '../agora-kit/ui/skeleton';
import { CryptoApi, type Meta, readBootstrap } from '../client/crypto-client';
import { AuditPage } from './AuditPage';
import { ConsoleContext } from './console-context';
import { KeyPage } from './KeyPage';
import { KeysPage } from './KeysPage';
import { OverviewPage } from './OverviewPage';

/** The console's one colour input (CONSOLE-SHELL-SPEC; teal is not used by another console). */
export const CRYPTO_ACCENT = '#2dd4bf';

type Page = 'overview' | 'keys' | 'key' | 'audit';

interface Route {
  page: Page;
  key?: string;
}

const TITLES: Record<Page, string> = {
  overview: 'Overview',
  keys: 'Keys',
  key: 'Key',
  audit: 'Audit',
};

function readRoute(): Route {
  const hash = typeof window === 'undefined' ? '' : window.location.hash;
  const [path, search] = hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(search ?? '');
  const key = params.get('key') ?? undefined;
  if (path === 'audit') return { page: 'audit' };
  if (path === 'keys') return key ? { page: 'key', key } : { page: 'keys' };
  return { page: 'overview' };
}

function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(readRoute);
  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return [
    route,
    (next) => {
      const hash =
        next.page === 'key' && next.key
          ? `#/keys?key=${encodeURIComponent(next.key)}`
          : `#/${next.page}`;
      window.location.hash = hash;
      setRoute(next);
    },
  ];
}

function LogoMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <circle cx="8" cy="12" r="2.6" />
        <path d="M10.6 12H20M17.5 12v2.4M14.6 12v2" />
      </g>
    </svg>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-faint">
      {label}
      <select
        aria-label={label}
        className="h-7 rounded-md border border-border bg-panel-2 px-1.5 text-[11.5px] font-normal normal-case tracking-normal text-dim"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function MetaScreen({ error }: { error: unknown }) {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status: unknown }).status)
      : 0;
  const message =
    status === 401
      ? 'Your session ended. Sign in again to continue.'
      : status === 403
        ? 'Your account is not allowed to open this console.'
        : error instanceof Error
          ? error.message
          : 'The crypto server did not answer.';
  return (
    <div className="grid min-h-svh place-items-center bg-background p-8">
      <div className="agora-surface max-w-md rounded-lg border border-border p-6">
        <h1 className="text-sm font-bold text-fg">
          {status === 401 || status === 403 ? 'Not allowed' : 'The console could not load'}
        </h1>
        <p className="mt-2 text-xs text-faint">{message}</p>
      </div>
    </div>
  );
}

export function App() {
  const bootstrap = useMemo(() => readBootstrap(), []);
  const shell = useMemo(() => readShellConfig('crypto-dashboard-config'), []);
  const api = useMemo(() => (bootstrap ? new CryptoApi(bootstrap.api) : null), [bootstrap]);
  const [route, go] = useRoute();
  const meta = useQuery<Meta>({
    queryKey: ['meta'],
    queryFn: () => api!.meta(),
    enabled: api !== null,
    retry: false,
  });
  const [partition, setPartition] = useState<string | null>(null);

  useEffect(() => {
    if (!meta.data || partition !== null) return;
    setPartition(bootstrap?.app ?? meta.data.defaultPartition);
  }, [meta.data, partition, bootstrap]);

  if (bootstrap === null || api === null) {
    return (
      <div className="grid min-h-svh place-items-center bg-background p-8">
        <div className="max-w-md rounded-lg border border-border p-6 text-xs text-faint">
          This page is the crypto console, but it was served without its data block. Mount it with
          <span className="mono"> console </span> enabled.
        </div>
      </div>
    );
  }
  if (meta.error) return <MetaScreen error={meta.error} />;
  if (meta.data === undefined || partition === null) {
    return (
      <div className="grid min-h-svh gap-3 bg-background p-8">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const apps = [...new Set([...meta.data.apps, partition])];
  const current: ReactNode =
    route.page === 'overview' ? (
      <OverviewPage />
    ) : route.page === 'audit' ? (
      <AuditPage />
    ) : route.page === 'key' && route.key ? (
      <KeyPage name={route.key} onBack={() => go({ page: 'keys' })} />
    ) : (
      <KeysPage onOpen={(key) => go({ page: 'key', key })} />
    );

  return (
    <ConsoleContext.Provider value={{ api, meta: meta.data, partition, setPartition }}>
      <AppShell
        brand={{
          name: 'crypto',
          subtitle: 'keys & operations',
          mark: <LogoMark />,
          current: { title: 'Crypto keys', package: '@adonis-agora/crypto', icon: 'generic' },
        }}
        nav={[
          {
            section: 'Keys',
            items: [
              {
                id: 'overview',
                label: 'Overview',
                icon: <ServerIcon />,
                href: '#/overview',
                onSelect: () => go({ page: 'overview' }),
              },
              {
                id: 'keys',
                label: 'Keys',
                icon: <DocumentIcon />,
                href: '#/keys',
                onSelect: () => go({ page: 'keys' }),
              },
            ],
          },
          {
            section: 'Governance',
            items: [
              {
                id: 'audit',
                label: 'Audit',
                icon: <ActivityIcon />,
                href: '#/audit',
                onSelect: () => go({ page: 'audit' }),
              },
            ],
          },
        ]}
        activeId={route.page === 'key' ? 'keys' : route.page}
        shell={shell}
        title={TITLES[route.page]}
        actions={
          <Select
            label="app"
            value={partition}
            options={apps}
            onChange={(next) => {
              setPartition(next);
              // A key belongs to one app: going back to the list avoids showing a 404 page.
              if (route.page === 'key') go({ page: 'keys' });
            }}
          />
        }
      >
        <PageBody>
          <ErrorBoundary label={TITLES[route.page]} resetKeys={[route, partition]}>
            {current}
          </ErrorBoundary>
        </PageBody>
      </AppShell>
    </ConsoleContext.Provider>
  );
}
