// Layout for Cove's PDF reader (the Windows one; macOS reads in PDFKit): zoom steps, which page
// is being read and which pages to draw. Pure and unit-tested.

export const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
/** Space around each page, in pixels. */
export const PAGE_GAP = 16;

/** The next zoom step up (+1) or down (−1) from any scale, staying put at either end. */
export function stepZoom(current: number, direction: 1 | -1) {
  if (direction > 0) return ZOOMS.find((zoom) => zoom > current + 0.001) ?? ZOOMS[ZOOMS.length - 1];
  return [...ZOOMS].reverse().find((zoom) => zoom < current - 0.001) ?? ZOOMS[0];
}

/** The scale that fits a page `pageWidth` points wide across `available` pixels, within the zoom range. */
export function fitWidthScale(pageWidth: number, available: number) {
  if (pageWidth <= 0 || available <= 0) return 1;
  const scale = (available - PAGE_GAP * 2) / pageWidth;
  return Math.min(ZOOMS[ZOOMS.length - 1], Math.max(ZOOMS[0], scale));
}

/** Where each page starts, top to bottom, for pages of these heights. */
export function pageTops(heights: number[]) {
  const tops: number[] = [];
  let top = PAGE_GAP;
  for (const height of heights) {
    tops.push(top);
    top += height + PAGE_GAP;
  }
  return tops;
}

/** The page being read: the last one whose top has passed a line 40% down the window. */
export function pageAt(tops: number[], scrollTop: number, viewport: number) {
  const line = scrollTop + viewport * 0.4;
  let low = 0;
  let high = tops.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (tops[middle] <= line) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, low);
}

/** The first and last page (inclusive) within `ahead` pixels of the window: the ones to draw. */
export function pagesToDraw(tops: number[], heights: number[], scrollTop: number, viewport: number, ahead: number): [number, number] {
  if (!tops.length) return [0, -1];
  const from = scrollTop - ahead;
  const to = scrollTop + viewport + ahead;
  let first = pageAt(tops, from, 0);
  if (tops[first] + heights[first] < from) first = Math.min(tops.length - 1, first + 1);
  let last = pageAt(tops, to, 0);
  if (last < first) last = first;
  return [first, last];
}

export type ReaderParams = { key: string; title: string; file: string; page: number; src?: string };

/** What the reader window was opened with (documents.rs puts it in the address). */
export function readerParams(search: string): ReaderParams {
  const query = new URLSearchParams(search);
  const page = Number.parseInt(query.get("page") ?? "0", 10);
  return {
    key: query.get("key") ?? "",
    title: query.get("title") ?? "",
    file: query.get("file") ?? "",
    page: Number.isFinite(page) && page > 0 ? page : 0,
    src: query.get("src") ?? undefined,
  };
}
