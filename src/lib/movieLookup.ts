// Film and series details for the 影视 library: one shared, bounded queue of lookups, and the orders
// that use the details. Pure and unit-tested; only types come from other modules.
import type { MediaWork } from "./media";
import type { MovieMetadata } from "./nimbus";

export type MovieLookup = {
  /** The work's files, first file first. Details are cached against the first; a manual match is kept for all. */
  fileIds: string[];
  lookupName: string;
  series: boolean;
  /** A manual match (修正匹配): look the work up again under the name the user typed. */
  refresh?: boolean;
  /** Prefetch for a filter or an order: waits behind lookups for posters on screen and the detail sheet. */
  background?: boolean;
};

type Options = { limit?: number; ttl?: number; retryAfter?: number; now?: () => number };

/**
 * Lookups shared by every poster, the detail sheet and the library's filters: answers are kept for `ttl`
 * (failures for `retryAfter`), at most `limit` run at once, and background prefetches leave one slot free.
 * A manual match replaces every earlier answer for the work, under whatever name it was asked for,
 * including lookups still under way.
 */
export function createMovieLookups<T>(
  load: (request: MovieLookup) => Promise<T>,
  { limit = 3, ttl = 600_000, retryAfter = 30_000, now = () => Date.now() }: Options = {},
) {
  type Waiter = { start: () => void; background: boolean };
  type Entry = { fileIds: string[]; expires: number; value: Promise<T>; waiter?: Waiter };
  const entries = new Map<string, Entry>();
  /** The latest manual match for each file, numbered so lookups that started before it can give way. */
  const matches = new Map<string, { serial: number; value: T }>();
  const waiting: Waiter[] = [];
  let active = 0;
  let serial = 0;

  const pump = () => {
    while (waiting.length) {
      const index = waiting.findIndex((waiter) => !waiter.background);
      if (active >= (index < 0 ? Math.max(1, limit - 1) : limit)) return;
      const [next] = waiting.splice(Math.max(index, 0), 1);
      active++;
      next.start();
    }
  };

  const run = async (request: MovieLookup, entry: { waiter?: Waiter }) => {
    await new Promise<void>((start) => {
      entry.waiter = { start, background: !!request.background };
      waiting.push(entry.waiter);
      pump();
    });
    entry.waiter = undefined;
    try {
      return await load(request);
    } finally {
      active--;
      pump();
    }
  };

  const matchedSince = (fileIds: string[], since: number) => {
    let latest: { serial: number; value: T } | undefined;
    for (const id of fileIds) {
      const match = matches.get(id);
      if (match && match.serial > since && (!latest || match.serial > latest.serial)) latest = match;
    }
    return latest;
  };

  function lookup(request: MovieLookup): Promise<T> {
    if (request.refresh) {
      return run(request, {}).then((value) => {
        serial++;
        for (const id of request.fileIds) matches.set(id, { serial, value });
        const ids = new Set(request.fileIds);
        for (const [key, entry] of entries) if (entry.fileIds.some((id) => ids.has(id))) entries.delete(key);
        return value;
      });
    }
    const key = `${request.fileIds[0]}:${request.series}:${request.lookupName}`;
    const cached = entries.get(key);
    if (cached && cached.expires > now()) {
      // A poster scrolled into view no longer waits behind the prefetch that asked first.
      if (!request.background && cached.waiter?.background) {
        cached.waiter.background = false;
        pump();
      }
      return cached.value;
    }
    const since = serial;
    const entry = { fileIds: request.fileIds, expires: now() + ttl } as Entry;
    entry.value = run(request, entry).then(
      (value) => matchedSince(request.fileIds, since)?.value ?? value,
      (cause) => {
        const match = matchedSince(request.fileIds, since);
        if (match) return match.value;
        entry.expires = now() + retryAfter;
        throw cause;
      },
    );
    entries.set(key, entry);
    return entry.value;
  }

  return { lookup, clear: () => entries.clear() };
}

export type MovieSort = "title" | "recent" | "oldest" | "rating";

/**
 * Category filters other than 全部 depend on genres and kind (纪录片, 动画, a film matched as a series),
 * and the year and rating orders on details: they need every work's details, not only the posters in view.
 */
export function needsAllDetails(category: string, sort: MovieSort) {
  return category !== "all" || sort !== "title";
}

/** The year a work is ordered by: its details', else the year in a film's file name ("沙丘.2021"). */
export function workYear(work: MediaWork, metadata?: MovieMetadata) {
  return metadata?.year ?? (work.year ? Number(work.year) : undefined);
}

const collator = new Intl.Collator("zh-CN", { numeric: true });

/** Library order; works without a year or rating come last, and ties go by title. */
export function compareWorks(sort: MovieSort, metadata: Record<string, MovieMetadata | undefined>) {
  return (a: MediaWork, b: MediaWork) => {
    const left = metadata[a.id];
    const right = metadata[b.id];
    const byTitle = () => collator.compare(left?.title ?? a.title, right?.title ?? b.title);
    if (sort === "oldest") return (workYear(a, left) ?? 9999) - (workYear(b, right) ?? 9999) || byTitle();
    if (sort === "recent") return (workYear(b, right) ?? 0) - (workYear(a, left) ?? 0) || byTitle();
    if (sort === "rating") return (right?.rating ?? -1) - (left?.rating ?? -1) || byTitle();
    return byTitle();
  };
}
