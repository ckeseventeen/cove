// Course folders (网络课程, 教学视频) as courses, chapters and lessons. Pure and unit-tested; only types
// come from other modules.
import type { MediaFile, MediaSource } from "./nimbus";

export type CourseItem = { file: MediaFile; kind: "lesson" | "material"; title: string };
export type Chapter = { key: string; title: string; items: CourseItem[] };
export type Course = {
  /** "<source id>:<course folder>", stable across scans. */
  id: string;
  sourceId: string;
  title: string;
  /** Bracketed tags in the folder name, such as the school: "金程教育". */
  tags: string[];
  /** The course's folder, for 在文件中显示. */
  folder: string;
  chapters: Chapter[];
  /** Video lessons in study order. */
  lessons: MediaFile[];
  materials: MediaFile[];
};

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const DOCUMENT = /\.pdf$/i;
/** Folders that only wrap the lessons: "视频教程", "Videos". */
const WRAPPER = /^(?:视频|视频教程|教程视频|课程视频|录播|回放|课程|video|videos|lessons?|lectures?|recordings?)$/i;
/** Folders named like a chapter rather than a course: "01量化投资前导", "第3章", "Week 2". */
const CHAPTER_LIKE = /^(?:\d|第[零一二两三四五六七八九十百\d]+[章节讲课部篇单周天]|(?:chapter|lesson|part|module|unit|week|day|section)\s*\d)/i;
/** Other folders that sit beside the lessons of one course: "课件", "代码", "资料". */
const COURSE_PARTS = /^(?:课件|讲义|资料|代码|源码|笔记|作业|习题|附件|课程资料|配套资料|slides?|code|notes?|materials?|exercises?|homework)$/i;

const stem = (name: string) => name.replace(/\.[^.]+$/, "");

/** "【金程教育】【Python基础+量化进阶】基于Python的量化学习" → title and its tags. */
export function courseTitle(folder: string): { title: string; tags: string[] } {
  const tags: string[] = [];
  let rest = folder.trim();
  for (;;) {
    const match = rest.match(/^[【\[]([^】\]]+)[】\]]\s*/);
    if (!match) break;
    tags.push(match[1].trim());
    rest = rest.slice(match[0].length);
  }
  return { title: rest.trim() || tags.pop() || folder, tags };
}

function relativeSegments(file: MediaFile, root: string) {
  const path = file.cloudPath || file.remotePath || "";
  const base = root.replace(/\/+$/, "");
  const relative = path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path.replace(/^\/+/, "");
  return relative.split("/").filter(Boolean);
}

/**
 * Whether a course folder holds one course (its subfolders are chapters, wrappers or parts) or a
 * collection of courses (one per subfolder).
 */
function isSingleCourse(firstFolders: string[], looseFiles: number) {
  // Videos right in the folder, or nothing but files: the folder is the course. A lone subfolder is
  // a course unless it is named like a chapter or a wrapper.
  if (looseFiles > 0 || !firstFolders.length) return true;
  const chapterish = firstFolders.filter((name) => CHAPTER_LIKE.test(name) || WRAPPER.test(name) || COURSE_PARTS.test(name));
  return chapterish.length * 2 >= firstFolders.length;
}

export function buildCourses(files: MediaFile[], sources: MediaSource[]): Course[] {
  const courses: Course[] = [];
  for (const source of sources.filter((item) => item.kind === "course")) {
    const own = files.filter((file) => file.sourceIds?.includes(source.id) || file.sourceId === source.id);
    if (!own.length) continue;
    const segments = new Map(own.map((file) => [file.id, relativeSegments(file, source.remoteRoot)]));
    const firstFolders = [...new Set(own.map((file) => segments.get(file.id)!).filter((parts) => parts.length > 1).map((parts) => parts[0]))];
    const looseFiles = own.filter((file) => segments.get(file.id)!.length === 1).length;
    const single = isSingleCourse(firstFolders, looseFiles);
    const groups = new Map<string, { folder: string; name: string; files: { file: MediaFile; chapterPath: string[] }[] }>();
    for (const file of own) {
      const parts = segments.get(file.id)!;
      const courseName = single ? source.label : parts[0];
      const chapterPath = (single ? parts : parts.slice(1)).slice(0, -1);
      const folder = single ? source.remoteRoot : `${source.remoteRoot.replace(/\/+$/, "")}/${parts[0]}`;
      const group = groups.get(courseName) ?? { folder, name: courseName, files: [] };
      group.files.push({ file, chapterPath });
      groups.set(courseName, group);
    }
    for (const group of groups.values()) {
      const chapters = new Map<string, Chapter>();
      const ordered = [...group.files].sort((left, right) => {
        const a = [...left.chapterPath, left.file.displayName];
        const b = [...right.chapterPath, right.file.displayName];
        for (let index = 0; index < Math.min(a.length, b.length); index++) {
          // Handouts, code and other side folders come after the lessons.
          const side = Number(COURSE_PARTS.test(a[index])) - Number(COURSE_PARTS.test(b[index]));
          const order = side || collator.compare(a[index], b[index]);
          if (order) return order;
        }
        return a.length - b.length;
      });
      for (const { file, chapterPath } of ordered) {
        const visible = chapterPath.filter((name) => !WRAPPER.test(name));
        const key = chapterPath.join("/");
        const chapter = chapters.get(key) ?? { key, title: visible.join(" › "), items: [] };
        chapter.items.push({ file, kind: DOCUMENT.test(file.displayName) ? "material" : "lesson", title: stem(file.displayName) });
        chapters.set(key, chapter);
      }
      const list = [...chapters.values()];
      const { title, tags } = courseTitle(group.name);
      courses.push({
        id: `${source.id}:${group.name}`,
        sourceId: source.id,
        title,
        tags,
        folder: group.folder,
        chapters: list,
        lessons: list.flatMap((chapter) => chapter.items.filter((item) => item.kind === "lesson").map((item) => item.file)),
        materials: list.flatMap((chapter) => chapter.items.filter((item) => item.kind === "material").map((item) => item.file)),
      });
    }
  }
  return courses.sort((left, right) => collator.compare(left.title, right.title));
}

type Saved = { fileId: string; position: number; duration: number; updatedAt: number };
export type CourseProgress = {
  finished: ReadonlySet<string>;
  partial: ReadonlyMap<string, Saved>;
  /** The lesson to continue with: the one begun, or the one after the last finished. */
  next: MediaFile | null;
  resume: Saved | null;
  done: boolean;
  /** When the course was last studied (unix seconds), 0 if never. */
  lastStudied: number;
};

const finishedSave = (saved: Saved) => saved.position <= 0 || (saved.duration > 0 && saved.position >= saved.duration * 0.95);

export function courseProgress(course: Course, savedById: ReadonlyMap<string, Saved>): CourseProgress {
  const finished = new Set<string>();
  const partial = new Map<string, Saved>();
  let latest: { file: MediaFile; saved: Saved } | null = null;
  for (const file of course.lessons) {
    const saved = savedById.get(file.id);
    if (!saved) continue;
    if (finishedSave(saved)) finished.add(file.id);
    else partial.set(file.id, saved);
    if (!latest || saved.updatedAt > latest.saved.updatedAt) latest = { file, saved };
  }
  let next: MediaFile | null = null;
  let resume: Saved | null = null;
  let done = false;
  if (latest && !finishedSave(latest.saved)) {
    next = latest.file;
    resume = latest.saved;
  } else if (latest) {
    const after = course.lessons[course.lessons.indexOf(latest.file) + 1];
    if (after) {
      next = after;
      resume = partial.get(after.id) ?? null;
    } else done = true;
  }
  return { finished, partial, next, resume, done, lastStudied: latest?.saved.updatedAt ?? 0 };
}

/** "1.变量与类型" → number "1", text "变量与类型"; names without their own number keep it all. */
export function lessonLabel(title: string): { number?: string; text: string } {
  const match = title.match(/^(\d{1,3})(?:[.、_\-\s]+)(.+)$/);
  return match ? { number: String(Number(match[1])), text: match[2].trim() } : { text: title };
}

/** A steady colour for a course's cover. */
export function courseHue(title: string) {
  return [...title].reduce((sum, character) => (sum * 31 + character.charCodeAt(0)) % 360, 7);
}
