// Bridges to native macOS behaviour: menus, context menus and window state.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { isWindows, platform, windowsMenuShortcut } from "./platform";

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type MenuEntry =
  | {
      label: string;
      action: () => void;
      enabled?: boolean;
      checked?: boolean;
      destructive?: boolean;
    }
  | { label: string; submenu: MenuEntry[]; enabled?: boolean }
  | "separator";

type NativeItem = MenuItem | CheckMenuItem | PredefinedMenuItem | Submenu;

async function buildNative(entry: MenuEntry): Promise<NativeItem> {
  if (entry === "separator") return PredefinedMenuItem.new({ item: "Separator" });
  if ("submenu" in entry) {
    const items = await Promise.all(tidy(entry.submenu).map(buildNative));
    return Submenu.new({ text: entry.label, enabled: entry.enabled ?? items.length > 0, items });
  }
  if (entry.checked !== undefined) {
    return CheckMenuItem.new({ text: entry.label, enabled: entry.enabled ?? true, checked: entry.checked, action: () => entry.action() });
  }
  return MenuItem.new({ text: entry.label, enabled: entry.enabled ?? true, action: () => entry.action() });
}

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
      const built = await Promise.all(entries.map(buildNative));
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
  // Styles that differ by system key off this: fonts, the window buttons' space, scroll bars.
  root.dataset.platform = platform;
  // Only the macOS window draws the sidebar material behind the page.
  if (vibrancy && isTauri() && !isWindows) root.dataset.nativeVibrancy = "";
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
  if (isWindows && isTauri()) blockBrowserKeys();
}

/**
 * WebView2 keeps Edge's own shortcuts: F5 and Ctrl+R reload the whole app, Ctrl+P prints, F3
 * searches the page, and Alt+← / Alt+→ and the mouse's side buttons step through the web view's
 * history. None belongs in Cove; the library window maps the history ones to its own back and
 * forward (MainWindow).
 */
function blockBrowserKeys() {
  window.addEventListener(
    "keydown",
    (event) => {
      const key = event.key.toLowerCase();
      const reload = key === "f5" || (event.ctrlKey && key === "r");
      const browser = (event.ctrlKey && (key === "p" || key === "g")) || key === "f3" || key === "f7";
      const history = event.altKey && (key === "arrowleft" || key === "arrowright");
      if (reload || browser || key === "browserback" || key === "browserforward") event.preventDefault();
      // Left for the page to use, but never as the web view's own back and forward.
      if (history && !isEditableTarget(event.target)) event.preventDefault();
    },
    true,
  );
  // The side buttons navigate when released; the press is left for the page to see.
  window.addEventListener("mouseup", (event) => {
    if (event.button === 3 || event.button === 4) event.preventDefault();
  });
}

/**
 * The library window's menu shortcuts on Windows. WebView2 keeps the keyboard while the page has
 * focus, so the menu bar never sees Ctrl+1, Ctrl+, or F11; the page hands them to the menu, which
 * runs them as if clicked. A control that used the key itself (arrows in Files) keeps it, and
 * arrows stay the text field's while one is focused.
 */
export function installWindowsMenuKeys() {
  if (!isWindows || !isTauri()) return;
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.repeat) return;
    const id = windowsMenuShortcut(event);
    if (!id || (event.key.startsWith("Arrow") && isEditableTarget(event.target))) return;
    event.preventDefault();
    void invoke("menu_shortcut", { id }).catch(() => undefined);
  });
}

/** True when keyboard shortcuts should be left to the focused control. */
export function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest('input:not([type="range"]), textarea, select, [contenteditable="true"]')
  );
}
