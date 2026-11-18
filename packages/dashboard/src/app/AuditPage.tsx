import { useQuery } from '@tanstack/react-query';
import { parseAsArrayOf, parseAsString, useQueryStates } from 'nuqs';
import { useDeferredValue, useState } from 'react';
import { ComboSelect, EmptyState, PageHeader, Panel, QueryBoundary } from '../agora-kit';
import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { Badge } from '../agora-kit/ui/badge';
import { Skeleton } from '../agora-kit/ui/skeleton';
import type { AuditRow } from '../client/crypto-client';
import { useConsole } from './console-context';
import { CursorPager, useCursorPager } from './cursor-pager';
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

/**
 * The audit trail's view, in the hash's query (`#/audit?operation=decrypt&result=denied&after=…`).
 * Picking an operation, a result or a page adds a history entry; picking the key replaces it. Any
 * filter change goes back to the first page. Pages walk by cursor (`after`), so a deep page costs
 * the same as the first one; the trail shows no total.
 */
export const auditParams = {
  operation: parseAsString.withDefault('').withOptions({ history: 'push' }),
  result: parseAsString.withDefault('').withOptions({ history: 'push' }),
  key: parseAsString.withDefault(''),
  /** The cursor stack {@link useCursorPager} keeps; listed so a filter change can clear it. */
  after: parseAsArrayOf(parseAsString),
};

export function AuditPage() {
  const { api, partition } = useConsole();
  const [{ operation, result, key }, setView] = useQueryStates(auditParams);
  const pager = useCursorPager();
  const after = pager.after;
  // The key filter's options: this app's keys, searched server-side as the user types (the same
  // query the Keys page runs for its first page). A key outside the list can still be typed.
  const [keySearch, setKeySearch] = useState('');
  const search = useDeferredValue(keySearch.trim());
  const keyOptions = useQuery({
    queryKey: ['keys', partition, 1, search],
    queryFn: () => api.keys(partition, { page: 1, size: 50, ...(search ? { search } : {}) }),
  });
  const query = useQuery({
    queryKey: ['audit', partition, after, operation, result, key],
    queryFn: () =>
      api.audit(partition, {
        size: 50,
        ...(after ? { after } : {}),
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
        description={query.data ? `page ${pager.page}` : undefined}
        flush
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ComboSelect
              aria-label="Filter by key"
              placeholder="key"
              className="h-7 w-40 text-[11px]"
              options={keyOptions.data?.data.map((entry) => entry.name) ?? []}
              loading={keyOptions.isPending}
              creatable
              value={key || null}
              onQueryChange={setKeySearch}
              onValueChange={(next) =>
                void setView({ key: next ?? '', after: null }, { history: 'replace' })
              }
            />
            <ComboSelect
              aria-label="Operation"
              placeholder="every operation"
              className="h-7 w-40 text-[11px]"
              options={OPERATIONS}
              value={operation || null}
              onValueChange={(next) => void setView({ operation: next ?? '', after: null })}
            />
            <select
              aria-label="Result"
              className="h-7 rounded-md border border-border bg-panel-2 px-1.5 text-[11px] text-dim"
              value={result}
              onChange={(event) => void setView({ result: event.target.value, after: null })}
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
              <CursorPager
                meta={data.meta}
                page={pager.page}
                onNext={() => pager.next(data.meta.nextCursor)}
                onPrevious={pager.previous}
              />
            </div>
          )}
        </QueryBoundary>
      </Panel>
    </>
  );
}
