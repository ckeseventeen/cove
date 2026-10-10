// Bridges to native macOS behaviour: menus, context menus and window state.
import { listen } from "@tauri-apps/api/event";
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type MenuEntry =
  | {
      label: string;
      action: () => void;
      enabled?: boolean;
      checked?: boolean;
      destructive?: boolean;
    }
  | "separator";

export type FallbackMenuRequest = { x: number; y: number; items: MenuEntry[] };
type MenuEvent = { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void };

const fallbackListeners = new Set<(request: FallbackMenuRequest) => void>();

/** The HTML menu host registers here; it is only used outside the native app. */
export function onFallbackMenu(listener: (request: FallbackMenuRequest) => void) {
  fallbackListeners.add(listener);
  return () => {
    fallbackListeners.delete(listener);
  };
}

function tidy(items: MenuEntry[]) {
  const result: MenuEntry[] = [];
  for (const item of items) {
    if (item === "separator" && (!result.length || result.at(-1) === "separator")) continue;
    result.push(item);
  }
  while (result.at(-1) === "separator") result.pop();
  return result;
}

/** Show a native NSMenu at the pointer, or an equivalent HTML menu in the browser preview. */
export async function showContextMenu(event: MenuEvent, items: MenuEntry[]) {
  event.preventDefault();
  event.stopPropagation();
  const entries = tidy(items);
  if (!entries.length) return;
  if (isTauri()) {
    try {
      const built = await Promise.all(
        entries.map((entry) => {
          if (entry === "separator") return PredefinedMenuItem.new({ item: "Separator" });
          if (entry.checked !== undefined) {
            return CheckMenuItem.new({
              text: entry.label,
              enabled: entry.enabled ?? true,
              checked: entry.checked,
              action: () => entry.action(),
            });
          }
          return MenuItem.new({ text: entry.label, enabled: entry.enabled ?? true, action: () => entry.action() });
        }),
      );
      const menu = await Menu.new({ items: built });
      await menu.popup();
      // Item actions arrive asynchronously; release the native resources afterwards.
      window.setTimeout(() => void menu.close().catch(() => undefined), 2000);
      return;
    } catch {
      // Fall through to the HTML menu if the native menu is unavailable.
    }
  }
  const request = { x: event.clientX, y: event.clientY, items: entries };
  fallbackListeners.forEach((listener) => listener(request));
}

/** Menu bar and remote-control commands emitted by the native shell. */
export function onMenuAction(handler: (id: string) => void) {
  if (!isTauri()) return () => undefined;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  listen<string>("menu-action", (event) => handler(event.payload))
    .then((off) => {
      if (disposed) off();
      else unlisten = off;
    })
    .catch(() => undefined);
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/** Window-level native conventions shared by every Cove window. */
export function installWindowBehaviour({ vibrancy }: { vibrancy: boolean }) {
  const root = document.documentElement;
  if (vibrancy && isTauri()) root.dataset.nativeVibrancy = "";
  const update = () => {
    if (document.hasFocus()) delete root.dataset.windowInactive;
    else root.dataset.windowInactive = "";
  };
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  update();
  // Web "Reload / Inspect" menus never appear in a native app.
  window.addEventListener("contextmenu", (event) => {
    const target = event.target as Element | null;
    if (target?.closest("input, textarea, .selectable")) return;
    event.preventDefault();
  });
  // Dropping files onto the window must not navigate the web view away.
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());
}

/** True when keyboard shortcuts should be left to the focused control. */
export function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest('input:not([type="range"]), textarea, select, [contenteditable="true"]')
  );
}
