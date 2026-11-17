import { useQuery } from '@tanstack/react-query';
import {
  ActivityIcon,
  MetricCard,
  MetricGrid,
  PageHeader,
  Panel,
  QueryBoundary,
} from '../agora-kit';
import { Badge } from '../agora-kit/ui/badge';
import { Skeleton } from '../agora-kit/ui/skeleton';
import { useConsole } from './console-context';
import { exactTime, plural, relativeTime, resultTone } from './format';

const KEY_TYPES: Array<{ type: string; what: string; public: string }> = [
  { type: 'aes256-gcm', what: 'encrypt, decrypt, rewrap, data keys', public: '—' },
  { type: 'x25519', what: 'seal to the key, open with it', public: 'JWK' },
  { type: 'ed25519', what: 'sign, verify', public: 'JWK / JWKS' },
  { type: 'hmac-sha256', what: 'hmac', public: '—' },
];

export function OverviewPage() {
  const { api, meta, partition } = useConsole();
  const overview = useQuery({
    queryKey: ['overview', partition],
    queryFn: () => api.overview(partition),
  });
  const recent = useQuery({
    queryKey: ['audit', partition, 'recent'],
    queryFn: () => api.audit(partition, { size: 8 }),
  });

  return (
    <>
      <PageHeader
        title={partition}
        description="Keys are sealed by the server and never leave it. This console shows metadata only."
      />

      <QueryBoundary
        label="Overview"
        query={overview}
        skeleton={
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {['a', 'b', 'c', 'd'].map((id) => (
              <Skeleton key={id} className="h-[92px] w-full" />
            ))}
          </div>
        }
      >
        {(data) => (
          <MetricGrid>
            <MetricCard
              label="Keys"
              value={data.keys}
              caption={plural(data.versions, 'version')}
              tone="brand"
            />
            <MetricCard
              label="Operations · 24h"
              value={data.operations24h}
              caption={
                data.lastOperationAt ? `last ${relativeTime(data.lastOperationAt)}` : 'none yet'
              }
              tone="good"
            />
            <MetricCard
              label="Denied · 24h"
              value={data.denied24h}
              caption="capability refusals"
              tone={data.denied24h > 0 ? 'warn' : 'default'}
            />
            <MetricCard
              label="Failed · 24h"
              value={data.errors24h}
              caption="errors the server answered"
              tone={data.errors24h > 0 ? 'bad' : 'default'}
            />
          </MetricGrid>
        )}
      </QueryBoundary>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Recent operations" description="who did what, newest first" flush>
          <QueryBoundary
            label="Recent operations"
            query={recent}
            skeleton={
              <div className="grid gap-2 p-4">
                {['a', 'b', 'c', 'd'].map((id) => (
                  <Skeleton key={id} className="h-8 w-full" />
                ))}
              </div>
            }
            isEmpty={(data) => data.data.length === 0}
            empty={
              <div className="flex items-center gap-2 p-6 text-xs text-faint">
                <ActivityIcon /> Nothing recorded yet: operations show up here.
              </div>
            }
          >
            {(data) => (
              <ul className="divide-y divide-border">
                {data.data.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge variant={resultTone(row.result)}>{row.result}</Badge>
                        <span className="mono text-[11.5px] text-fg">{row.operation}</span>
                        {row.key ? (
                          <span className="mono truncate text-[11px] text-faint">{row.key}</span>
                        ) : null}
                        {row.version !== undefined ? (
                          <span className="mono tnum text-[10.5px] text-faint">v{row.version}</span>
                        ) : null}
                      </div>
                      {row.result !== 'ok' && row.error ? (
                        <p
                          className="mono mt-1 truncate text-[10.5px] text-faint"
                          title={row.error}
                        >
                          {row.error}
                        </p>
                      ) : null}
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-[11px] text-dim">{row.actor}</div>
                      <div className="mono text-[10px] text-faint" title={exactTime(row.at)}>
                        {relativeTime(row.at)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </QueryBoundary>
        </Panel>

        <Panel title="Key types" description="what each one is for">
          <div className="grid gap-3">
            {KEY_TYPES.map((entry) => (
              <div key={entry.type} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="mono text-[12px] text-fg">{entry.type}</div>
                  <p className="mt-0.5 text-[11px] text-faint">{entry.what}</p>
                </div>
                <Badge variant="outline">{entry.public}</Badge>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Capabilities" description="what a token can be granted, per key">
        <div className="flex flex-wrap gap-1.5">
          {meta.capabilityLegend.map((capability) => (
            <span
              key={capability}
              className="mono rounded-md border border-border bg-panel-2 px-2 py-1 text-[10.5px] text-dim"
            >
              {capability}
            </span>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-faint">
          A trailing <span className="mono">*</span> matches the rest of the capability:
          <span className="mono"> crypto:*</span> is everything,{' '}
          <span className="mono">crypto:encrypt:*</span> every key of encrypt, and{' '}
          <span className="mono">crypto:*:orders</span> every operation on{' '}
          <span className="mono">orders</span>. Nothing is implied: encrypt never grants decrypt.
        </p>
      </Panel>
    </>
  );
}
