import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { EmptyState, PageHeader, Pager, Panel, QueryBoundary } from '../agora-kit';
import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { Badge } from '../agora-kit/ui/badge';
import { Input } from '../agora-kit/ui/input';
import { Skeleton } from '../agora-kit/ui/skeleton';
import type { AuditRow } from '../client/crypto-client';
import { useConsole } from './console-context';
import { exactTime, relativeTime, resultTone } from './format';

const OPERATIONS = [
  'encrypt',
  'decrypt',
  'rewrap',
  'datakey',
  'sign',
  'verify',
  'hmac',
  'public-key',
  'read',
  'create',
  'rotate',
  'policy',
  'delete',
  'export',
];

const columns: Column<AuditRow>[] = [
  {
    id: 'at',
    header: 'When',
    cell: (row) => (
      <span className="text-[11px] text-faint" title={exactTime(row.at)}>
        {relativeTime(row.at)}
      </span>
    ),
  },
  {
    id: 'actor',
    header: 'Who',
    cell: (row) => (
      <div className="min-w-0">
        <div className="truncate text-[11.5px] text-fg">{row.actor}</div>
        {row.clientId ? (
          <div className="mono truncate text-[10px] text-faint">{row.clientId}</div>
        ) : null}
      </div>
    ),
  },
  {
    id: 'operation',
    header: 'Operation',
    cell: (row) => <span className="mono text-[11px] text-dim">{row.operation}</span>,
  },
  {
    id: 'key',
    header: 'Key',
    hideBelow: 'sm',
    cell: (row) => (
      <span className="mono text-[11px] text-faint">
        {row.key ?? '—'}
        {row.version !== undefined ? <span className="text-faint"> v{row.version}</span> : null}
      </span>
    ),
  },
  {
    id: 'result',
    header: 'Result',
    cell: (row) => <Badge variant={resultTone(row.result)}>{row.result}</Badge>,
  },
  {
    id: 'error',
    header: 'Why',
    hideBelow: 'md',
    cell: (row) => (
      <span className="text-[10.5px] text-faint" title={row.error}>
        {row.error ?? '—'}
      </span>
    ),
  },
];

export function AuditPage() {
  const { api, partition } = useConsole();
  const [page, setPage] = useState(1);
  const [operation, setOperation] = useState('');
  const [result, setResult] = useState('');
  const [key, setKey] = useState('');
  const query = useQuery({
    queryKey: ['audit', partition, page, operation, result, key],
    queryFn: () =>
      api.audit(partition, {
        page,
        size: 50,
        ...(operation ? { operation } : {}),
        ...(result ? { result } : {}),
        ...(key ? { key } : {}),
      }),
  });

  return (
    <>
      <PageHeader
        title="Audit"
        description="Who did what, when, and why. The trail never contains plaintext or key material."
      />
      <Panel
        title="Operations"
        description={query.data ? `${query.data.meta.total} rows` : undefined}
        flush
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Filter by key"
              placeholder="key"
              className="h-7 w-32 text-[11px]"
              value={key}
              onChange={(event) => {
                setKey(event.target.value);
                setPage(1);
              }}
            />
            <select
              aria-label="Operation"
              className="h-7 rounded-md border border-border bg-panel-2 px-1.5 text-[11px] text-dim"
              value={operation}
              onChange={(event) => {
                setOperation(event.target.value);
                setPage(1);
              }}
            >
              <option value="">every operation</option>
              {OPERATIONS.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
            <select
              aria-label="Result"
              className="h-7 rounded-md border border-border bg-panel-2 px-1.5 text-[11px] text-dim"
              value={result}
              onChange={(event) => {
                setResult(event.target.value);
                setPage(1);
              }}
            >
              <option value="">every result</option>
              <option value="ok">ok</option>
              <option value="denied">denied</option>
              <option value="error">error</option>
            </select>
          </div>
        }
      >
        <QueryBoundary
          label="Audit"
          query={query}
          skeleton={
            <div className="grid gap-2 p-4">
              {['a', 'b', 'c', 'd', 'e', 'f'].map((id) => (
                <Skeleton key={id} className="h-8 w-full" />
              ))}
            </div>
          }
          isEmpty={(data) => data.data.length === 0}
          empty={
            <EmptyState
              title="Nothing recorded yet"
              description="Operations on this app's keys show up here, refusals included."
            />
          }
        >
          {(data) => (
            <div className="p-2">
              <DataTable
                label="Audit trail"
                columns={columns}
                rows={data.data}
                rowKey={(row) => row.id}
              />
              <Pager meta={data.meta} onPage={setPage} />
            </div>
          )}
        </QueryBoundary>
      </Panel>
    </>
  );
}
