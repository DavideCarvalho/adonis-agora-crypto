import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ActionDialog,
  EmptyState,
  PageHeader,
  Pager,
  Panel,
  QueryBoundary,
  Toolbar,
} from '../agora-kit';
import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { Badge } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import { Input } from '../agora-kit/ui/input';
import { Skeleton } from '../agora-kit/ui/skeleton';
import type { Key, KeyType } from '../client/crypto-client';
import { useConsole } from './console-context';
import { relativeTime } from './format';

const TYPES: KeyType[] = ['aes256-gcm', 'x25519', 'ed25519', 'hmac-sha256'];

interface Form {
  name: string;
  type: KeyType;
  description: string;
  deletionAllowed: boolean;
  exportable: boolean;
}

const emptyForm: Form = {
  name: '',
  type: 'aes256-gcm',
  description: '',
  deletionAllowed: false,
  exportable: false,
};

function Flag({ on, children }: { on: boolean; children: React.ReactNode }) {
  return on ? <Badge variant="warn">{children}</Badge> : null;
}

export function KeysPage({ onOpen }: { onOpen: (name: string) => void }) {
  const { api, partition } = useConsole();
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Form>(emptyForm);
  const [deleting, setDeleting] = useState<Key | null>(null);
  const [error, setError] = useState<string | null>(null);

  const keys = useQuery({
    queryKey: ['keys', partition, page, search],
    queryFn: () => api.keys(partition, { page, size: 50, ...(search ? { search } : {}) }),
  });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['keys', partition] });
    void client.invalidateQueries({ queryKey: ['overview', partition] });
    void client.invalidateQueries({ queryKey: ['audit', partition] });
  };

  const create = useMutation({
    mutationFn: () =>
      api.createKey(partition, {
        name: form.name.trim(),
        type: form.type,
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        ...(form.deletionAllowed ? { deletionAllowed: true } : {}),
        ...(form.exportable ? { exportable: true } : {}),
      }),
    onSuccess: (key) => {
      setCreating(false);
      setForm(emptyForm);
      setError(null);
      refresh();
      onOpen(key.name);
    },
    onError: (failure: Error) => setError(failure.message),
  });

  const rotate = useMutation({
    mutationFn: (name: string) => api.rotateKey(partition, name),
    onSuccess: refresh,
    onError: (failure: Error) => setError(failure.message),
  });

  const remove = useMutation({
    mutationFn: (name: string) => api.deleteKey(partition, name),
    onSuccess: () => {
      setDeleting(null);
      setError(null);
      refresh();
    },
    onError: (failure: Error) => setError(failure.message),
  });

  const columns: Column<Key>[] = [
    {
      id: 'name',
      header: 'Key',
      cell: (key) => (
        <div className="min-w-0">
          <div className="mono text-[11.5px] text-fg">{key.name}</div>
          {key.description ? (
            <div className="truncate text-[10.5px] text-faint">{key.description}</div>
          ) : null}
        </div>
      ),
    },
    {
      id: 'type',
      header: 'Type',
      cell: (key) => <span className="mono text-[10.5px] text-dim">{key.type}</span>,
    },
    {
      id: 'version',
      header: 'Version',
      hideBelow: 'sm',
      cell: (key) => (
        <span className="mono tnum text-[11px] text-dim">
          v{key.latestVersion}
          <span className="text-faint"> · {key.versions.length} total</span>
        </span>
      ),
    },
    {
      id: 'floor',
      header: 'Floor',
      hideBelow: 'md',
      cell: (key) => (
        <span className="mono tnum text-[11px] text-faint">min v{key.minDecryptionVersion}</span>
      ),
    },
    {
      id: 'flags',
      header: 'Policy',
      hideBelow: 'md',
      cell: (key) => (
        <div className="flex flex-wrap gap-1">
          {key.deletedAt ? <Badge variant="destructive">deleted</Badge> : null}
          <Flag on={key.deletionAllowed}>deletable</Flag>
          <Flag on={key.exportable}>exportable</Flag>
        </div>
      ),
    },
    {
      id: 'created',
      header: 'Created',
      hideBelow: 'lg',
      cell: (key) => (
        <span className="text-[11px] text-faint">
          {relativeTime(key.createdAt)} by {key.createdBy}
        </span>
      ),
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (key) => (
        <div className="flex justify-end gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={key.deletedAt !== undefined || rotate.isPending}
            onClick={(event) => {
              event.stopPropagation();
              rotate.mutate(key.name);
            }}
          >
            Rotate
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={key.deletedAt !== undefined || !key.deletionAllowed}
            onClick={(event) => {
              event.stopPropagation();
              setDeleting(key);
            }}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Keys"
        description="Named keys of this app. Rotate adds a version; old data keeps opening until the floor moves."
        actions={<Button onClick={() => setCreating(true)}>New key</Button>}
      />

      {error ? (
        <div className="rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-[11.5px] text-bad">
          {error}
        </div>
      ) : null}

      <Panel
        title="Keys"
        description={keys.data ? `${keys.data.meta.total} in ${partition}` : undefined}
        flush
        action={
          <Toolbar label="Keys filters">
            <Input
              aria-label="Search keys"
              placeholder="search name or description"
              className="h-7 w-52 text-[11.5px]"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </Toolbar>
        }
      >
        <QueryBoundary
          label="Keys"
          query={keys}
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
              title={search ? 'No key matches' : 'No keys yet'}
              description={
                search
                  ? 'Try another name, or clear the search.'
                  : 'Create the first key: encrypt, sign and hmac live here.'
              }
              action={
                search ? undefined : <Button onClick={() => setCreating(true)}>New key</Button>
              }
            />
          }
        >
          {(data) => (
            <div className="p-2">
              <DataTable
                label="Keys"
                columns={columns}
                rows={data.data}
                rowKey={(key) => key.name}
                onRowClick={(key) => onOpen(key.name)}
                rowClassName={(key) => (key.deletedAt ? 'opacity-60' : undefined)}
              />
              <Pager meta={data.meta} onPage={setPage} />
            </div>
          )}
        </QueryBoundary>
      </Panel>

      <ActionDialog
        open={creating}
        onOpenChange={(open) => {
          setCreating(open);
          if (!open) setError(null);
        }}
        title="New key"
        description={`${partition} · version 1 is created now`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              disabled={!form.name.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              Create key
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <label htmlFor="crypto-key-name" className="grid gap-1 text-[11px] text-faint">
            Name
            <Input
              id="crypto-key-name"
              placeholder="media"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </label>
          <label htmlFor="crypto-key-type" className="grid gap-1 text-[11px] text-faint">
            Type
            <select
              id="crypto-key-type"
              className="h-8 rounded-md border border-border bg-panel-2 px-2 text-[11.5px] text-dim"
              value={form.type}
              onChange={(event) => setForm({ ...form, type: event.target.value as KeyType })}
            >
              {TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="crypto-key-description" className="grid gap-1 text-[11px] text-faint">
            Description
            <Input
              id="crypto-key-description"
              placeholder="media URLs"
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </label>
          <div className="grid gap-2">
            <label className="flex items-center gap-2 text-[11.5px] text-dim">
              <input
                type="checkbox"
                checked={form.deletionAllowed}
                onChange={(event) => setForm({ ...form, deletionAllowed: event.target.checked })}
              />
              Allow deleting this key later
            </label>
            <label className="flex items-center gap-2 text-[11.5px] text-dim">
              <input
                type="checkbox"
                checked={form.exportable}
                onChange={(event) => setForm({ ...form, exportable: event.target.checked })}
              />
              Allow exporting its material later
            </label>
          </div>
        </div>
      </ActionDialog>

      <ActionDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete key"
        description={deleting ? `${deleting.partition}/${deleting.name}` : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.name)}
            >
              Delete for good
            </Button>
          </>
        }
      >
        <p className="text-[11.5px] text-dim">
          Every version’s material is destroyed and the name stays reserved. Ciphertext made with
          this key will never open again.
        </p>
      </ActionDialog>
    </>
  );
}
