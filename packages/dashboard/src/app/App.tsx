import { useQuery } from '@tanstack/react-query';
import { parseAsString, useQueryState } from 'nuqs';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIcon,
  AppModeBadge,
  AppShell,
  actionsUnavailableReason,
  DocumentIcon,
  ErrorBoundary,
  FederatedNotice,
  NuqsHashAdapter,
  PageBody,
  readShellConfig,
  ScopeChip,
  ScopeMenu,
  ServerIcon,
  splitHash,
  subscribeHashUrl,
} from '../agora-kit';
import { Skeleton } from '../agora-kit/ui/skeleton';
import {
  CryptoApi,
  type FederatedAppInfo,
  type Meta,
  readBootstrap,
} from '../client/crypto-client';
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
  const { path: rawPath, search } = splitHash(hash);
  const path = rawPath.replace(/^\/?/, '');
  const params = new URLSearchParams(search);
  const key = params.get('key') ?? undefined;
  if (path === 'audit') return { page: 'audit' };
  if (path === 'keys') return key ? { page: 'key', key } : { page: 'keys' };
  return { page: 'overview' };
}

function sameRoute(a: Route, b: Route): boolean {
  return a.page === b.page && a.key === b.key;
}

/**
 * The page is the hash's path (`#/keys`, `#/keys?key=<name>` for one key); each page's view state
 * (search, filters, page) and the topbar's app ride in the hash's query, written by nuqs through
 * the kit's `NuqsHashAdapter`. Moving to another page keeps the app and drops the old page's view
 * state. `app` overrides the app carried along (`null` = the default).
 */
function useRoute(): [Route, (route: Route, app?: string | null) => void] {
  const [route, setRoute] = useState<Route>(readRoute);
  // Follows links, back/forward and query-only writes (which fire no `hashchange`).
  useEffect(
    () =>
      subscribeHashUrl(() =>
        setRoute((prev) => {
          const next = readRoute();
          return sameRoute(prev, next) ? prev : next;
        }),
      ),
    [],
  );
  const go = useCallback((next: Route, app?: string | null) => {
    const query = new URLSearchParams();
    if (next.page === 'key' && next.key) query.set('key', next.key);
    const carried =
      app !== undefined
        ? app
        : new URLSearchParams(splitHash(window.location.hash).search).get('app');
    if (carried !== null) query.set('app', carried);
    const path = next.page === 'key' ? '/keys' : `/${next.page}`;
    const rest = query.toString();
    window.location.hash = rest === '' ? `#${path}` : `#${path}?${rest}`;
    setRoute(next);
  }, []);
  return [route, go];
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

const APP_TEXT = {
  noun: 'App',
  all: 'All apps',
  some: 'Pick an app',
  search: 'Search apps',
  empty: 'No apps.',
};

/**
 * The topbar's app picker, the kit's header picker over `/meta`'s apps: a fixed chip when there is
 * only one app, a searchable menu otherwise. One app is always picked (no "all apps").
 */
function AppPicker({
  value,
  options,
  federated,
  onChange,
}: {
  value: string;
  options: readonly string[];
  /** The options that are other apps: their label, and a `federated` hint. */
  federated: readonly FederatedAppInfo[];
  onChange: (value: string) => void;
}) {
  const labelOf = (id: string) => federated.find((app) => app.id === id)?.label ?? id;
  if (options.length <= 1) {
    return <ScopeChip noun={APP_TEXT.noun} label={labelOf(value)} kind="app" />;
  }
  return (
    <ScopeMenu
      items={options.map((id) => {
        const other = federated.find((app) => app.id === id);
        return other
          ? { id, label: other.label, ...(other.mode === 'federated' ? { hint: 'federated' } : {}) }
          : { id, label: id };
      })}
      all={false}
      current={value}
      text={APP_TEXT}
      labelOf={labelOf}
      onChoose={(next) => {
        if (next !== undefined) onChange(next);
      }}
    />
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

/**
 * The crypto console, wrapped in the kit's `NuqsHashAdapter`: the picked app and each page's view
 * state live in the hash's query (`#/audit?app=billing&result=denied`), so a view is a link.
 */
export function App() {
  return (
    <NuqsHashAdapter>
      <Console />
    </NuqsHashAdapter>
  );
}

function Console() {
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
  // The app (partition) picked in the topbar: `?app=` in the hash, else the bootstrap's / the
  // server's default. Picking the default again takes it out of the URL.
  const [pickedApp, setPickedApp] = useQueryState(
    'app',
    parseAsString.withOptions({ history: 'push' }),
  );
  const defaultPartition = meta.data ? (bootstrap?.app ?? meta.data.defaultPartition) : null;
  const partition = defaultPartition === null ? null : (pickedApp ?? defaultPartition);
  const setPartition = useCallback(
    (next: string) => void setPickedApp(next === defaultPartition ? null : next),
    [defaultPartition, setPickedApp],
  );

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
  const federatedApps = meta.data.federated ?? [];
  const federated = federatedApps.find((app) => app.id === partition);
  const readOnly = federated ? actionsUnavailableReason(federated.label, federated) : undefined;
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
    <ConsoleContext.Provider
      value={{ api, meta: meta.data, partition, setPartition, federated, readOnly }}
    >
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
          <>
            <AppPicker
              value={partition}
              options={apps}
              federated={federatedApps}
              onChange={(next) => {
                // A key belongs to one app: going back to the list avoids showing a 404 page.
                if (route.page === 'key')
                  go({ page: 'keys' }, next === defaultPartition ? null : next);
                else setPartition(next);
              }}
            />
            {federated ? (
              <AppModeBadge
                appLabel={federated.label}
                mode={federated.mode}
                actions={federated.actions}
              />
            ) : null}
          </>
        }
      >
        <PageBody>
          {federated ? (
            <FederatedNotice
              appLabel={federated.label}
              mode={federated.mode}
              actions={federated.actions}
            />
          ) : null}
          <ErrorBoundary label={TITLES[route.page]} resetKeys={[route, partition]}>
            {current}
          </ErrorBoundary>
        </PageBody>
      </AppShell>
    </ConsoleContext.Provider>
  );
}
