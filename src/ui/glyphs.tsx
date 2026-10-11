import {
  Archive,
  Cloud,
  File,
  FileText,
  FileType2,
  Film,
  Folder,
  HardDrive,
  Image,
  Music2,
  Server,
} from "lucide-react";
import type { EntryKind } from "../lib/storage";

type LucideIcon = typeof Cloud;

const PROVIDER_GLYPHS: Record<string, { icon: LucideIcon; color: string }> = {
  local: { icon: HardDrive, color: "gray" },
  webdav: { icon: Server, color: "teal" },
  baidu: { icon: Cloud, color: "blue" },
  google_drive: { icon: Cloud, color: "green" },
  onedrive: { icon: Cloud, color: "indigo" },
};

export function providerIcon(provider: string): LucideIcon {
  return PROVIDER_GLYPHS[provider]?.icon ?? Cloud;
}

export function ProviderGlyph({ provider, size = "" }: { provider: string; size?: "" | "small" | "large" }) {
  const glyph = PROVIDER_GLYPHS[provider] ?? { icon: Cloud, color: "gray" };
  const Icon = glyph.icon;
  return (
    <span className={`glyph ${glyph.color} ${size}`} aria-hidden="true">
      <Icon size={size === "large" ? 22 : size === "small" ? 12 : 15} strokeWidth={2} />
    </span>
  );
}

const ENTRY_ICONS: Record<EntryKind, LucideIcon> = {
  folder: Folder,
  video: Film,
  audio: Music2,
  pdf: FileType2,
  image: Image,
  text: FileText,
  document: FileText,
  archive: Archive,
  other: File,
};

/** File icons tinted like Finder: blue folders, coloured media. */
export function EntryIcon({ kind, size = 16 }: { kind: EntryKind; size?: number }) {
  const Icon = ENTRY_ICONS[kind];
  return (
    <Icon
      className={`entry-icon kind-${kind}`}
      size={size}
      strokeWidth={kind === "folder" ? 1.6 : 1.7}
      fill={kind === "folder" ? "currentColor" : "none"}
      fillOpacity={kind === "folder" ? 0.18 : undefined}
    />
  );
}
