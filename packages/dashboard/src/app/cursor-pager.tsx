import { parseAsArrayOf, parseAsString, useQueryState } from 'nuqs';
import { ChevronLeftIcon, ChevronRightIcon } from '../agora-kit/icons';
import { Button } from '../agora-kit/ui/button';
import type { CursorMeta } from '../client/crypto-client';

/**
 * Keyset paging in the URL: `?after=<c1>,<c2>` holds the `after` cursor of every page walked so far
 * (page N carries N-1 cursors), so a shared link opens on the same page and back/forward step
 * through pages. Page 1 has no param.
 */
export function useCursorPager(key = 'after') {
  const [cursors, setCursors] = useQueryState(
    key,
    parseAsArrayOf(parseAsString).withDefault([]).withOptions({ history: 'push' }),
  );
  return {
    page: cursors.length + 1,
    /** The `after` cursor of the current page (absent on page 1). */
    after: cursors.at(-1),
    next: (nextCursor: string | null) => {
      if (nextCursor) void setCursors([...cursors, nextCursor]);
    },
    previous: () => void setCursors(cursors.length <= 1 ? null : cursors.slice(0, -1)),
  };
}

/** Previous / next over a cursor page: no total, the page number is how far you walked. */
export function CursorPager({
  meta,
  page,
  onNext,
  onPrevious,
}: {
  meta: CursorMeta;
  page: number;
  onNext: () => void;
  onPrevious: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1 px-1 py-2">
      <Button
        variant="ghost"
        size="sm"
        aria-label="Previous page"
        disabled={page <= 1}
        onClick={onPrevious}
      >
        <ChevronLeftIcon />
        <span className="hidden sm:inline">Previous</span>
      </Button>
      <span className="mono tnum px-2 text-[11px] text-fg-2">page {page}</span>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Next page"
        disabled={!meta.hasNext}
        onClick={onNext}
      >
        <span className="hidden sm:inline">Next</span>
        <ChevronRightIcon />
      </Button>
    </div>
  );
}
