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

/** What this system's own parts are called, for text that names them. */
export function systemWords(on: Platform = platform) {
  return on === "windows"
    ? { keychain: "凭据管理器", systemKeychain: "Windows 凭据管理器", fileManager: "资源管理器", thisComputer: "这台电脑", system: "Windows" }
    : { keychain: "钥匙串", systemKeychain: "macOS 钥匙串", fileManager: "访达", thisComputer: "这台 Mac", system: "macOS" };
}

export const SYSTEM = systemWords();
