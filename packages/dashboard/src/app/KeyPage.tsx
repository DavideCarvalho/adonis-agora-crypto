import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader, Panel, QueryBoundary, Toolbar } from '../agora-kit';
import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { Badge } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import { Input } from '../agora-kit/ui/input';
import { Skeleton } from '../agora-kit/ui/skeleton';
import type { KeyTestResult, KeyVersion } from '../client/crypto-client';
import { useConsole } from './console-context';
import { exactTime, relativeTime, shortKid, versionTone } from './format';

const columns: Column<KeyVersion>[] = [
  {
    id: 'version',
    header: 'Version',
    cell: (row) => <span className="mono tnum text-[11.5px] text-fg">v{row.version}</span>,
  },
  {
    id: 'status',
    header: 'Status',
    cell: (row) => <Badge variant={versionTone(row.status)}>{row.status}</Badge>,
  },
  {
    id: 'kid',
    header: 'Kid',
    hideBelow: 'sm',
    cell: (row) => (
      <span className="mono text-[10.5px] text-faint" title={row.kid}>
        {shortKid(row.kid)}
      </span>
    ),
  },
  {
    id: 'public',
    header: 'Public',
    hideBelow: 'md',
    cell: (row) => (
      <span className="mono text-[10.5px] text-faint">
        {row.publicKey ? `${row.publicKey.crv} · ${shortKid(row.publicKey.x, 10)}` : '—'}
      </span>
    ),
  },
  {
    id: 'created',
    header: 'Created',
    hideBelow: 'md',
    cell: (row) => (
      <span className="text-[11px] text-faint" title={exactTime(row.createdAt)}>
        {relativeTime(row.createdAt)} by {row.createdBy}
      </span>
    ),
  },
];

export function KeyPage({ name, onBack }: { name: string; onBack: () => void }) {
  const { api, partition, readOnly } = useConsole();
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<KeyTestResult | null>(null);
  const [floor, setFloor] = useState<string>('');
  const [description, setDescription] = useState<string | null>(null);

  const key = useQuery({
    queryKey: ['key', partition, name],
    queryFn: () => api.key(partition, name),
  });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['key', partition, name] });
    void client.invalidateQueries({ queryKey: ['keys', partition] });
    void client.invalidateQueries({ queryKey: ['overview', partition] });
    void client.invalidateQueries({ queryKey: ['audit', partition] });
  };

  const policy = useMutation({
    mutationFn: (input: {
      minDecryptionVersion?: number;
      deletionAllowed?: boolean;
      exportable?: boolean;
      description?: string | null;
    }) => api.updateKey(partition, name, input),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (failure: Error) => setError(failure.message),
  });

  const rotate = useMutation({
    mutationFn: () => api.rotateKey(partition, name),
    onSuccess: refresh,
    onError: (failure: Error) => setError(failure.message),
  });

  const test = useMutation({
    mutationFn: () => api.testKey(partition, name),
    onSuccess: (result) => {
      setError(null);
      setTested(result);
      void client.invalidateQueries({ queryKey: ['audit', partition] });
    },
    onError: (failure: Error) => {
      setTested(null);
      setError(failure.message);
    },
  });

  return (
    <>
      <PageHeader
        title={name}
        description={`${partition} · ${key.data?.type ?? '…'}`}
        actions={
          <>
            <Button variant="ghost" onClick={onBack}>
              Back
            </Button>
            <Button
              variant="secondary"
              disabled={
                test.isPending || readOnly !== undefined || key.data?.deletedAt !== undefined
              }
              title={readOnly ?? 'Run this key once with a random probe (audited)'}
              onClick={() => test.mutate()}
            >
              {test.isPending ? 'Testing…' : 'Test'}
            </Button>
            <Button
              disabled={
                rotate.isPending || readOnly !== undefined || key.data?.deletedAt !== undefined
              }
              title={readOnly}
              onClick={() => rotate.mutate()}
            >
              Rotate
            </Button>
          </>
        }
      />

      {error ? (
        <div className="rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-[11.5px] text-bad">
          {error}
        </div>
      ) : null}
      {tested ? (
        <div
          role="status"
          data-key-test={tested.ok ? 'ok' : 'failed'}
          className={
            tested.ok
              ? 'rounded-md border border-good/30 bg-good/10 px-3 py-2 text-[11.5px] text-good'
              : 'rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-[11.5px] text-bad'
          }
        >
          {tested.ok ? 'Works' : 'Did not round-trip'}: {tested.operations.join(' + ')} with v
          {tested.version}.
        </div>
      ) : null}

      <QueryBoundary
        label="Key"
        query={key}
        skeleton={
          <div className="grid gap-3">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        }
      >
        {(data) => (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              <Panel title="Metadata" description="never key material">
                <dl className="grid grid-cols-[9rem_1fr] gap-y-2 text-[11.5px]">
                  <dt className="text-faint">Type</dt>
                  <dd className="mono text-fg">{data.type}</dd>
                  <dt className="text-faint">Latest version</dt>
                  <dd className="mono tnum text-fg">v{data.latestVersion}</dd>
                  <dt className="text-faint">Decryption floor</dt>
                  <dd className="mono tnum text-fg">v{data.minDecryptionVersion}</dd>
                  <dt className="text-faint">Deletion</dt>
                  <dd className="text-fg">{data.deletionAllowed ? 'allowed' : 'not allowed'}</dd>
                  <dt className="text-faint">Export</dt>
                  <dd className="text-fg">{data.exportable ? 'allowed' : 'not allowed'}</dd>
                  <dt className="text-faint">Created</dt>
                  <dd className="text-fg">
                    {exactTime(data.createdAt)} by {data.createdBy}
                  </dd>
                  <dt className="text-faint">Updated</dt>
                  <dd className="text-fg">
                    {data.updatedAt
                      ? `${exactTime(data.updatedAt)} by ${data.updatedBy ?? '—'}`
                      : '—'}
                  </dd>
                  {data.deletedAt ? (
                    <>
                      <dt className="text-faint">Deleted</dt>
                      <dd className="text-bad">{exactTime(data.deletedAt)}</dd>
                    </>
                  ) : null}
                  <dt className="text-faint">Description</dt>
                  <dd className="text-fg">{data.description ?? '—'}</dd>
                </dl>
              </Panel>

              <Panel title="Policy" description="applies to the whole key">
                <div className="grid gap-3">
                  <label htmlFor="crypto-key-floor" className="grid gap-1 text-[11px] text-faint">
                    Decryption floor (oldest version that may still decrypt)
                    <div className="flex items-center gap-2">
                      <Input
                        id="crypto-key-floor"
                        className="h-8 w-24"
                        inputMode="numeric"
                        placeholder={String(data.minDecryptionVersion)}
                        value={floor}
                        onChange={(event) => setFloor(event.target.value)}
                      />
                      <Button
                        size="sm"
                        disabled={floor.trim() === '' || policy.isPending || readOnly !== undefined}
                        onClick={() => {
                          const value = Number(floor);
                          policy.mutate({ minDecryptionVersion: value });
                          setFloor('');
                        }}
                      >
                        Set floor
                      </Button>
                    </div>
                  </label>
                  <label
                    htmlFor="crypto-key-description-field"
                    className="grid gap-1 text-[11px] text-faint"
                  >
                    Description
                    <div className="flex items-center gap-2">
                      <Input
                        id="crypto-key-description-field"
                        className="h-8"
                        placeholder={data.description ?? 'what this key is for'}
                        value={description ?? data.description ?? ''}
                        onChange={(event) => setDescription(event.target.value)}
                      />
                      <Button
                        size="sm"
                        disabled={
                          description === null || policy.isPending || readOnly !== undefined
                        }
                        onClick={() => {
                          policy.mutate({ description: description === '' ? null : description });
                          setDescription(null);
                        }}
                      >
                        Save
                      </Button>
                    </div>
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant={data.deletionAllowed ? 'ghost' : 'secondary'}
                      disabled={policy.isPending || readOnly !== undefined}
                      onClick={() => policy.mutate({ deletionAllowed: !data.deletionAllowed })}
                    >
                      {data.deletionAllowed ? 'Forbid deletion' : 'Allow deletion'}
                    </Button>
                    <Button
                      size="sm"
                      variant={data.exportable ? 'ghost' : 'secondary'}
                      disabled={policy.isPending || readOnly !== undefined}
                      onClick={() => policy.mutate({ exportable: !data.exportable })}
                    >
                      {data.exportable ? 'Forbid export' : 'Allow export'}
                    </Button>
                  </div>
                  <p className="text-[10.5px] text-faint">
                    The floor refuses a retired version; rewrap stored ciphertext before moving it.
                    Export is audited and off by default — a key that never leaves the server cannot
                    leak from an app.
                  </p>
                </div>
              </Panel>
            </div>

            <Panel title="Versions" description={`${data.versions.length} version(s)`} flush>
              <div className="p-2">
                <DataTable
                  label="Versions"
                  columns={columns}
                  rows={[...data.versions].reverse()}
                  rowKey={(row) => String(row.version)}
                  empty={
                    <div className="p-6 text-xs text-faint">This key has no version left.</div>
                  }
                />
              </div>
            </Panel>

            {data.type === 'x25519' || data.type === 'ed25519' ? (
              <Panel
                title="Public keys"
                description="what a caller seals to, or verifies a signature with"
                action={
                  <Toolbar label="Public key actions">
                    <Badge variant="outline">JWKS</Badge>
                  </Toolbar>
                }
              >
                <pre className="mono max-h-64 overflow-auto rounded-md border border-border bg-panel-2 p-3 text-[10.5px] text-dim">
                  {JSON.stringify(
                    { keys: data.versions.map((version) => version.publicKey).filter(Boolean) },
                    null,
                    2,
                  )}
                </pre>
              </Panel>
            ) : null}
          </>
        )}
      </QueryBoundary>
    </>
  );
}
