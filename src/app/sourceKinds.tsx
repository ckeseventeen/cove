import { Clapperboard, FileText, Film, GraduationCap, Music, Music2 } from "lucide-react";
import type { MediaSource } from "../lib/nimbus";
import type { Route } from "./navigation";

type Kind = MediaSource["kind"];
type Icon = typeof Clapperboard;

/** What each kind of media folder is called, how it looks and where it opens. */
export const SOURCE_KINDS: Record<Kind, { label: string; contents: string; icon: Icon; smallIcon: Icon; glyph: string; route: "movies" | "music" | "documents" | "courses" }> = {
  movie: { label: "影视", contents: "影片与剧集", icon: Clapperboard, smallIcon: Film, glyph: "purple", route: "movies" },
  music: { label: "音乐", contents: "歌曲", icon: Music, smallIcon: Music2, glyph: "pink", route: "music" },
  document: { label: "文档", contents: "文档", icon: FileText, smallIcon: FileText, glyph: "orange", route: "documents" },
  course: { label: "课程", contents: "课程", icon: GraduationCap, smallIcon: GraduationCap, glyph: "green", route: "courses" },
};

export const SOURCE_KIND_ORDER: Kind[] = ["movie", "music", "document", "course"];

/** The library page that shows a media folder. */
export function routeForSource(source: MediaSource): Route {
  return { name: SOURCE_KINDS[source.kind].route, sourceId: source.id } as Route;
}
