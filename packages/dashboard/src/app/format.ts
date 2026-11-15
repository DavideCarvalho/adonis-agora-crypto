/** Small presentation helpers shared by the pages. */

export function relativeTime(iso: string | undefined): string {
  if (iso === undefined) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function exactTime(iso: string | undefined): string {
  if (iso === undefined) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** A `kid` (base64url thumbprint) shown short enough for a table cell. */
export function shortKid(kid: string | undefined, max = 14): string {
  if (kid === undefined || kid === '') return '—';
  return kid.length <= max ? kid : `${kid.slice(0, max)}…`;
}

/** The status badge tone of a key version. */
export function versionTone(
  status: 'latest' | 'decryptable' | 'retired',
): 'good' | 'info' | 'outline' {
  if (status === 'latest') return 'good';
  if (status === 'decryptable') return 'info';
  return 'outline';
}

/** The status badge tone of an audit result. */
export function resultTone(result: 'ok' | 'denied' | 'error'): 'good' | 'warn' | 'destructive' {
  if (result === 'ok') return 'good';
  if (result === 'denied') return 'warn';
  return 'destructive';
}

/** `1` → `1 key`, `3` → `3 keys`. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
