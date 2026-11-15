import type { HttpContext } from '@adonisjs/core/http';

/*
 * The console switcher registry, version 1, declared here STRUCTURALLY: every `@adonis-agora`
 * console declares the same shapes and binds the same plain value at `'agora.consoles'` when it is
 * the first to boot. No lib imports another; whichever copy creates the registry, the others append
 * to it.
 */

/** The container binding the registry lives at. */
export const AGORA_CONSOLES_BINDING = 'agora.consoles';

/** Bound as a VALUE under `'agora.consoles'`. Data only. */
export interface AgoraConsoleRegistry {
  readonly version: 1;
  readonly entries: AgoraConsoleEntry[];
  account?: { signOut?: string | { action: string } | { href: string } };
}

/** The icon a console shows in the switcher. An unknown value renders as `generic`. */
export type AgoraConsoleIcon =
  | 'workflow'
  | 'telescope'
  | 'media'
  | 'payments'
  | 'agent'
  | 'identity'
  | 'flags'
  | 'cms'
  | 'generic';

export interface AgoraConsoleSearchHit {
  title: string;
  subtitle?: string;
  href: string;
}

export interface AgoraConsoleEntry {
  id: string;
  title: string;
  package?: string;
  icon: AgoraConsoleIcon;
  path: string;
  order: number;
  authorize(ctx: HttpContext): Promise<{ allowed: boolean; reason?: string; redirectTo?: string }>;
  search?(ctx: HttpContext, q: string, limit: number): Promise<AgoraConsoleSearchHit[]>;
}

export interface VisibleConsole {
  id: string;
  title: string;
  package?: string;
  icon: AgoraConsoleIcon;
  href: string;
}

export interface VisibleConsoles {
  version: 1;
  current: string;
  consoles: VisibleConsole[];
}

export interface ConsoleSearchResults {
  version: 1;
  q: string;
  results: Array<{
    id: string;
    title: string;
    icon: AgoraConsoleIcon;
    hits: AgoraConsoleSearchHit[];
  }>;
}

const ID = /^[a-z][a-z0-9-]*$/;
const ICONS = new Set<AgoraConsoleIcon>([
  'workflow',
  'telescope',
  'media',
  'payments',
  'agent',
  'identity',
  'flags',
  'cms',
  'generic',
]);
export const PROBE_TIMEOUT_MS = 300;
export const SEARCH_HITS_PER_CONSOLE = 5;

export function isSameOriginPath(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//');
}

interface ContainerLike {
  hasBinding(binding: string): boolean;
  bindValue(binding: string, value: unknown): void;
  make(binding: string): Promise<unknown>;
}

interface LoggerLike {
  warn(message: string): void;
}

/** Add a console to the registry, creating it when this is the first console to boot. */
export async function registerAgoraConsole(
  container: ContainerLike,
  entry: AgoraConsoleEntry,
  logger?: LoggerLike,
): Promise<boolean> {
  if (!ID.test(entry.id)) {
    throw new Error(`[@adonis-agora/crypto] console id ${JSON.stringify(entry.id)} is invalid`);
  }
  if (!isSameOriginPath(entry.path)) {
    throw new Error(
      `[@adonis-agora/crypto] console path ${JSON.stringify(entry.path)} must start with a single "/"`,
    );
  }
  if (!container.hasBinding(AGORA_CONSOLES_BINDING)) {
    const fresh: AgoraConsoleRegistry = { version: 1, entries: [] };
    container.bindValue(AGORA_CONSOLES_BINDING, fresh);
  }
  const registry = (await container.make(AGORA_CONSOLES_BINDING)) as
    | Partial<AgoraConsoleRegistry>
    | undefined;
  if (registry?.version !== 1 || !Array.isArray(registry.entries)) return false;
  if (registry.entries.some((existing) => existing.id === entry.id)) {
    logger?.warn(`[@adonis-agora/crypto] console id "${entry.id}" already registered`);
    return false;
  }
  registry.entries.push(entry);
  return true;
}

export async function readAgoraConsoles(
  container: Pick<ContainerLike, 'hasBinding' | 'make'>,
): Promise<AgoraConsoleRegistry | undefined> {
  if (!container.hasBinding(AGORA_CONSOLES_BINDING)) return undefined;
  const registry = (await container.make(AGORA_CONSOLES_BINDING)) as
    | Partial<AgoraConsoleRegistry>
    | undefined;
  if (registry?.version !== 1 || !Array.isArray(registry.entries)) return undefined;
  return registry as AgoraConsoleRegistry;
}

export function otherConsoles(registry: AgoraConsoleRegistry | undefined, selfId: string): number {
  return registry ? registry.entries.filter((entry) => entry.id !== selfId).length : 0;
}

async function within<T>(work: () => Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(work)
        .catch(() => fallback),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function probing<T>(ctx: HttpContext, fn: () => Promise<T>): Promise<T> {
  const marked = ctx as HttpContext & { agoraProbe?: boolean };
  const previous = marked.agoraProbe;
  marked.agoraProbe = true;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete marked.agoraProbe;
    else marked.agoraProbe = previous;
  }
}

function sorted(entries: readonly AgoraConsoleEntry[]): AgoraConsoleEntry[] {
  return [...entries].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

async function allowedEntries(
  entries: AgoraConsoleEntry[],
  ctx: HttpContext,
  timeoutMs: number,
): Promise<AgoraConsoleEntry[]> {
  const verdicts = await probing(ctx, () =>
    Promise.all(
      entries.map((entry) =>
        within(async () => (await entry.authorize(ctx)).allowed === true, timeoutMs, false),
      ),
    ),
  );
  return entries.filter((_, index) => verdicts[index]);
}

function iconOf(icon: unknown): AgoraConsoleIcon {
  return ICONS.has(icon as AgoraConsoleIcon) ? (icon as AgoraConsoleIcon) : 'generic';
}

/** The consoles other than `selfId` the viewer may open. */
export async function listVisibleConsoles(
  registry: AgoraConsoleRegistry | undefined,
  selfId: string,
  ctx: HttpContext,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<VisibleConsoles> {
  const others = registry
    ? sorted(
        registry.entries.filter((entry) => entry.id !== selfId && isSameOriginPath(entry.path)),
      )
    : [];
  const allowed = await allowedEntries(others, ctx, timeoutMs);
  return {
    version: 1,
    current: selfId,
    consoles: allowed.map((entry) => ({
      id: entry.id,
      title: entry.title,
      ...(entry.package !== undefined ? { package: entry.package } : {}),
      icon: iconOf(entry.icon),
      href: entry.path,
    })),
  };
}

/** ⌘K: `q` goes to every console the viewer may open that has a `search`. */
export async function searchConsoles(
  registry: AgoraConsoleRegistry | undefined,
  selfId: string,
  ctx: HttpContext,
  q: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ConsoleSearchResults> {
  const query = q.trim().slice(0, 200);
  if (!registry || query === '') return { version: 1, q: query, results: [] };
  const searchable = sorted(
    registry.entries.filter(
      (entry) => typeof entry.search === 'function' && isSameOriginPath(entry.path),
    ),
  );
  const self = searchable.filter((entry) => entry.id === selfId);
  const others = await allowedEntries(
    searchable.filter((entry) => entry.id !== selfId),
    ctx,
    timeoutMs,
  );
  const targets = sorted([...self, ...others]);
  const hits = await probing(ctx, () =>
    Promise.all(
      targets.map((entry) =>
        within(
          async () => (await entry.search?.(ctx, query, SEARCH_HITS_PER_CONSOLE)) ?? [],
          timeoutMs,
          [] as AgoraConsoleSearchHit[],
        ),
      ),
    ),
  );
  const results: ConsoleSearchResults['results'] = [];
  targets.forEach((entry, index) => {
    const safe = (hits[index] ?? [])
      .filter(
        (hit) =>
          typeof hit === 'object' &&
          hit !== null &&
          typeof hit.title === 'string' &&
          isSameOriginPath(hit.href),
      )
      .slice(0, SEARCH_HITS_PER_CONSOLE)
      .map((hit) => ({
        title: hit.title,
        ...(typeof hit.subtitle === 'string' ? { subtitle: hit.subtitle } : {}),
        href: hit.href,
      }));
    if (safe.length > 0) {
      results.push({ id: entry.id, title: entry.title, icon: iconOf(entry.icon), hits: safe });
    }
  });
  return { version: 1, q: query, results };
}

/** What {@link cryptoConsoleSearch} reads. */
export interface CryptoSearchSource {
  keys(): Promise<string[]>;
}

/** 0 = exact, 1 = prefix, 2 = contains, -1 = no match (case-insensitive). */
function rank(value: string, q: string): number {
  const v = value.toLowerCase();
  if (v === q) return 0;
  if (v.startsWith(q)) return 1;
  return v.includes(q) ? 2 : -1;
}

/**
 * The crypto console's global search: key names open that key's page.
 * `base` is the console's mount path (`''` at the root).
 */
export function cryptoConsoleSearch(
  source: (ctx: HttpContext) => Promise<CryptoSearchSource>,
  base: string,
): (ctx: HttpContext, q: string, limit: number) => Promise<AgoraConsoleSearchHit[]> {
  const shell = base === '' ? '/' : base;
  return async (ctx, q, limit) => {
    const needle = q.trim().toLowerCase();
    if (needle === '') return [];
    const reader = await source(ctx);
    const keys = await reader.keys().catch(() => []);
    return keys
      .map((key) => ({ key, score: rank(key, needle) }))
      .filter((hit) => hit.score !== -1)
      .sort((a, b) => a.score - b.score || a.key.localeCompare(b.key))
      .slice(0, limit)
      .map(({ key }) => ({
        title: key,
        subtitle: 'key',
        href: `${shell}#/keys?key=${encodeURIComponent(key)}`,
      }));
  };
}
