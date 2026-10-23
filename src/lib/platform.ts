// Which system Cove runs on, and how its keyboard shortcuts are held and written there.
// Pure and unit-tested; the shortcuts are written once, the macOS way, and turned into Windows'.

export type Platform = "mac" | "windows";

export function platformOf(userAgent: string): Platform {
  return /Windows/i.test(userAgent) ? "windows" : "mac";
}

export const platform: Platform = typeof navigator === "undefined" ? "mac" : platformOf(navigator.userAgent);
export const isWindows = platform === "windows";

type Modifiers = { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

/** The key held for shortcuts: ⌘ on macOS, Ctrl on Windows. */
export function primaryKey(event: Pick<Modifiers, "metaKey" | "ctrlKey">, on: Platform = platform) {
  return on === "windows" ? event.ctrlKey : event.metaKey;
}

/** Only the shortcut key is held: ⌘W, Ctrl+W — not ⇧⌘W or Ctrl+Alt+W. */
export function onlyPrimaryKey(event: Modifiers, on: Platform = platform) {
  const other = on === "windows" ? event.metaKey : event.ctrlKey;
  return primaryKey(event, on) && !other && !event.altKey && !event.shiftKey;
}

const NAMES: Record<string, string> = { "⌃": "Ctrl", "⌥": "Alt", "⇧": "Shift", "⌘": "Ctrl" };
const ORDER = ["Ctrl", "Alt", "Shift"];

/**
 * A shortcut as the system writes it: "⌘F" stays on macOS and is "Ctrl+F" on Windows; "⌥⌘L" is
 * "Ctrl+Alt+L", and "⌃⌘S" "Ctrl+Alt+S", as the Windows menu has it. Works inside longer text too.
 */
export function shortcutLabel(mac: string, on: Platform = platform): string {
  if (on === "mac") return mac;
  return mac.replace(/([⌃⌥⇧⌘]+)(\S?)/gu, (_, glyphs: string, key: string) => {
    const held = new Set([...glyphs].map((glyph) => NAMES[glyph]));
    // ⌃⌘ is two keys on a Mac; Windows has one Ctrl, so the menu adds Alt instead.
    if (glyphs.includes("⌃") && glyphs.includes("⌘")) held.add("Alt");
    const names = ORDER.filter((name) => held.has(name)).join("+");
    return key ? `${names}+${key}` : names;
  });
}

type KeyEvent = Modifiers & { key: string; code: string };

/** The Windows menu bar's shortcuts (src-tauri/src/menu.rs), as Ctrl/Alt/Shift + a key. */
const WINDOWS_MENU_KEYS: Record<string, string> = {
  "Ctrl+,": "cove.settings",
  "Ctrl+N": "cove.add-storage",
  "Ctrl+Shift+N": "cove.new-folder",
  "Ctrl+Alt+N": "cove.new-playlist",
  "Ctrl+F": "cove.find",
  "Ctrl+1": "cove.go.home",
  "Ctrl+2": "cove.go.movies",
  "Ctrl+3": "cove.go.music",
  "Ctrl+4": "cove.go.documents",
  "Ctrl+5": "cove.go.courses",
  "Ctrl+[": "cove.back",
  "Ctrl+]": "cove.forward",
  "Ctrl+Alt+S": "cove.toggle-sidebar",
  "Ctrl+Alt+L": "cove.show-lyrics",
  "Ctrl+Alt+U": "cove.show-queue",
  "Ctrl+0": "cove.zoom-reset",
  "Ctrl+=": "cove.zoom-in",
  "Ctrl+-": "cove.zoom-out",
  F11: "cove.fullscreen",
  "Ctrl+Right": "cove.next",
  "Ctrl+Left": "cove.previous",
  "Ctrl+Up": "cove.volume-up",
  "Ctrl+Down": "cove.volume-down",
  "Ctrl+.": "cove.stop",
};

/** Keys by their place on the keyboard, so Shift or the layout does not change what they are. */
const CODE_KEYS: Record<string, string> = {
  Comma: ",",
  Period: ".",
  BracketLeft: "[",
  BracketRight: "]",
  Equal: "=",
  Minus: "-",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  F11: "F11",
};

/**
 * The menu item a key press means on Windows. WebView2 keeps the keyboard while the page has
 * focus, so the window's menu bar never sees its own shortcuts there; the page passes them on.
 */
export function windowsMenuShortcut(event: KeyEvent): string | undefined {
  if (event.metaKey) return undefined;
  const key = CODE_KEYS[event.code] ?? (/^(Key|Digit)/.test(event.code) ? event.code.slice(-1) : event.key.toUpperCase());
  const held = [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift"].filter(Boolean);
  return WINDOWS_MENU_KEYS[[...held, key].join("+")];
}

/** What this system's own parts are called, for text that names them. */
export function systemWords(on: Platform = platform) {
  return on === "windows"
    ? { keychain: "凭据管理器", systemKeychain: "Windows 凭据管理器", fileManager: "资源管理器", thisComputer: "这台电脑", system: "Windows", copy: "复制", viewMenu: "查看" }
    : { keychain: "钥匙串", systemKeychain: "macOS 钥匙串", fileManager: "访达", thisComputer: "这台 Mac", system: "macOS", copy: "拷贝", viewMenu: "显示" };
}

export const SYSTEM = systemWords();
