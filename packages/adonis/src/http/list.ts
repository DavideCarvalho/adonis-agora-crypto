import {
  InvalidColumnFilterError,
  parseFilterRequest,
  parsePageParams,
  type SortItem,
} from '@adonis-agora/filter';

/** The parsed list query: the Agora wire format (`_1x/LIST-API-SPEC.md`). */
export interface ListQuery {
  page: number;
  size: number;
  search?: string;
  sort: SortItem;
  /** Equality / `in` filters, already validated against the endpoint's allow-list. */
  filters: Record<string, string | string[]>;
}

export interface ListQueryOptions {
  /** Fields `sort` may name. A field outside it is a 400. */
  sortable: readonly string[];
  defaultSort: SortItem;
  /** Fields `filter[field]` may name. A field outside it is a 400. */
  filterable: readonly string[];
  defaultSize?: number;
  maxSize?: number;
}

/** `{ 'filter[action]': 'set' }` → `{ filter: { action: 'set' } }`, the shape Adonis's `qs()` gives. */
function nest(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    const match = /^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/.exec(key);
    if (!match) {
      out[key] = value;
      continue;
    }
    const [, field, operator] = match;
    const filter = (out.filter as Record<string, unknown> | undefined) ?? {};
    if (operator === undefined) {
      filter[field!] = value;
    } else {
      const entry = filter[field!];
      filter[field!] =
        typeof entry === 'object' && entry !== null
          ? { ...(entry as Record<string, unknown>), [operator]: value }
          : { [operator]: value };
    }
    out.filter = filter;
  }
  return out;
}

/**
 * Parses `page`/`size`, `search`, `sort` and `filter[field]` from a request query, rejecting an
 * unknown sort or filter field with the filter library's error (the HTTP layer answers 400).
 */
export function parseListQuery(
  query: Record<string, unknown>,
  options: ListQueryOptions,
): ListQuery {
  const parsed = parseFilterRequest(nest(query));
  const { page, size } = parsePageParams(query, {
    defaultSize: options.defaultSize ?? 50,
    maxSize: options.maxSize ?? 200,
  });
  const sort = parsed.sort?.[0];
  if (sort) {
    if (!options.sortable.includes(sort.field)) {
      throw new InvalidColumnFilterError(
        `Unknown sort field "${sort.field}" (sortable: ${options.sortable.join(', ')})`,
      );
    }
  }
  const filters: Record<string, string | string[]> = {};
  for (const filter of parsed.filters ?? []) {
    if (!options.filterable.includes(filter.field)) {
      throw new InvalidColumnFilterError(
        `Unknown filter field "${filter.field}" (filterable: ${options.filterable.join(', ')})`,
      );
    }
    if (filter.operator !== 'equals' && filter.operator !== 'in' && filter.operator !== 'isAnyOf') {
      throw new InvalidColumnFilterError(
        `Unsupported operator "${filter.operator}" for "${filter.field}" (equals, in)`,
      );
    }
    const value = filter.value;
    if (Array.isArray(value)) filters[filter.field] = value.map(String);
    else if (value !== undefined) filters[filter.field] = String(value);
  }
  return {
    page,
    size,
    ...(parsed.search !== undefined && parsed.search !== '' ? { search: parsed.search } : {}),
    sort: sort ?? options.defaultSort,
    filters,
  };
}

/** `'true'`/`'false'`/`'1'`/`'0'` → boolean; anything else → undefined. */
export function booleanFilter(value: string | string[] | undefined): boolean | undefined {
  if (value === undefined || Array.isArray(value)) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}
