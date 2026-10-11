// Window navigation with Finder-style back/forward history. Pure and unit-tested.

export type Route =
  | { name: "home" }
  | { name: "storage"; accountId: string; path: string }
  | { name: "movies"; sourceId?: string }
  | { name: "music"; sourceId?: string }
  | { name: "documents"; sourceId?: string }
  | { name: "playlist"; id: string }
  | { name: "search" }
  | { name: "settings" }
  | { name: "help" };

export type History = { entries: Route[]; index: number };

const LIMIT = 60;

export const initialHistory: History = { entries: [{ name: "home" }], index: 0 };

export function currentRoute(history: History): Route {
  return history.entries[history.index] ?? { name: "home" };
}

export function sameRoute(left: Route, right: Route) {
  if (left.name !== right.name) return false;
  if (left.name === "storage" && right.name === "storage") {
    return left.accountId === right.accountId && left.path === right.path;
  }
  if ((left.name === "movies" || left.name === "music" || left.name === "documents") && left.name === right.name) {
    return (left.sourceId ?? null) === ((right as { sourceId?: string }).sourceId ?? null);
  }
  if (left.name === "playlist" && right.name === "playlist") return left.id === right.id;
  return true;
}

export function navigate(history: History, route: Route, options: { replace?: boolean } = {}): History {
  const current = currentRoute(history);
  if (sameRoute(current, route)) return history;
  const kept = history.entries.slice(0, options.replace ? history.index : history.index + 1);
  const entries = [...kept, route].slice(-LIMIT);
  return { entries, index: entries.length - 1 };
}

export function goBack(history: History): History {
  return history.index > 0 ? { ...history, index: history.index - 1 } : history;
}

export function goForward(history: History): History {
  return history.index < history.entries.length - 1 ? { ...history, index: history.index + 1 } : history;
}

export const canGoBack = (history: History) => history.index > 0;
export const canGoForward = (history: History) => history.index < history.entries.length - 1;

/** Drop routes that point at something removed (an account or a media folder). */
export function pruneHistory(history: History, isGone: (route: Route) => boolean): History {
  const entries: Route[] = [];
  let index = 0;
  history.entries.forEach((route, position) => {
    if (isGone(route)) return;
    if (entries.length && sameRoute(entries[entries.length - 1], route)) {
      if (position <= history.index) index = entries.length - 1;
      return;
    }
    entries.push(route);
    if (position <= history.index) index = entries.length - 1;
  });
  if (!entries.length) return initialHistory;
  return { entries, index: Math.min(index, entries.length - 1) };
}

/** The sidebar row that should look selected for a route. */
export function sidebarKey(route: Route) {
  switch (route.name) {
    case "storage":
      return `account:${route.accountId}`;
    case "movies":
    case "music":
    case "documents":
      return route.sourceId ? `source:${route.sourceId}` : route.name;
    case "playlist":
      return `playlist:${route.id}`;
    default:
      return route.name;
  }
}

export function parentPath(path: string) {
  if (!path || path === "/") return null;
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}
