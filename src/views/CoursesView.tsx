import { useMemo, useState } from "react";
import { Check, Ellipsis, FileText, GraduationCap, LoaderCircle, Play } from "lucide-react";
import type { Route } from "../app/navigation";
import type { Library } from "../app/useLibrary";
import { courseHue, courseProgress, lessonLabel, type Chapter, type Course, type CourseProgress } from "../lib/courses";
import { plural } from "../lib/format";
import { showContextMenu } from "../lib/native";
import { setPlayerPlaylist, type MediaFile } from "../lib/nimbus";
import { usePlayer } from "../player/PlayerProvider";
import { EmptyState, Segmented } from "../ui/controls";
import type { Notify } from "../ui/Toasts";
import { useOpenDocument } from "./DocumentsView";

type Props = { library: Library; sourceId?: string; course?: string; onNavigate: (route: Route) => void; notify: Notify };

/** Play a lesson with its course as the queue: the next lesson follows, and 选集 lists the course. */
export function usePlayLesson() {
  const player = usePlayer();
  return (course: Course, lesson: MediaFile, fromStart = false) => {
    void setPlayerPlaylist(course.lessons.map((file) => file.id))
      .catch(() => undefined)
      .then(() => player.play(lesson, { fromStart }));
  };
}

/** A typographic cover: courses have no artwork. */
export function CourseCover({ course, size = "large" }: { course: Course; size?: "large" | "small" }) {
  const hue = courseHue(course.title);
  return (
    <span className={`course-cover ${size}`} style={{ background: `linear-gradient(145deg, hsl(${hue} 52% 46%), hsl(${(hue + 40) % 360} 48% 30%))` }}>
      <GraduationCap size={size === "large" ? 22 : 14} strokeWidth={1.7} />
      {size === "large" && <span className="course-cover-title">{course.title}</span>}
    </span>
  );
}

/** "已学 3 / 48 节" or "已学完"; null before the first lesson. */
export function courseStatus(course: Course, progress: CourseProgress) {
  const learned = progress.finished.size;
  if (progress.done) return "已学完";
  if (!learned && !progress.next) return null;
  return `已学 ${learned} / ${course.lessons.length} 节`;
}

export function CoursesView({ library, sourceId, course: courseId, onNavigate, notify }: Props) {
  // Folders of nothing but PDFs are reading, not courses: they are in 文档.
  const courses = useMemo(
    () => library.courses.filter((course) => course.lessons.length > 0 && (!sourceId || course.sourceId === sourceId)),
    [library.courses, sourceId],
  );
  const course = courseId ? library.courses.find((item) => item.id === courseId) : undefined;
  if (courseId) {
    return course ? (
      <CoursePage course={course} library={library} onNavigate={onNavigate} notify={notify} />
    ) : (
      <div className="page">
        <EmptyState title={library.loaded ? "这门课程已不在资料库中" : "正在载入…"} />
      </div>
    );
  }
  const source = library.sources.find((item) => item.id === sourceId);
  // Courses being studied first, most recent first; then the rest A–Z.
  const ordered = courses
    .map((item) => ({ course: item, progress: courseProgress(item, library.savedById) }))
    .sort((left, right) => right.progress.lastStudied - left.progress.lastStudied);
  return (
    <div className="page">
      <header className="page-header">
        <div className="heading">
          <h1 className="large-title">{source?.label ?? "课程"}</h1>
          <p className="page-subtitle">
            {plural(courses.length, "门课程")}
            {source && (
              <>
                {" · "}
                <button className="btn plain inline" onClick={() => onNavigate({ name: "courses" })}>
                  显示全部课程
                </button>
              </>
            )}
          </p>
        </div>
      </header>
      {ordered.length ? (
        <div className="course-grid">
          {ordered.map(({ course: item, progress }) => (
            <button
              key={item.id}
              className="course-card"
              onClick={() => onNavigate({ name: "courses", sourceId, course: item.id })}
              title={item.tags.length ? `${item.title}（${item.tags.join(" · ")}）` : item.title}
            >
              <CourseCover course={item} />
              <span className="poster-title truncate">{item.title}</span>
              <span className={`poster-subtitle truncate ${progress.next && !progress.done ? "in-progress" : ""}`}>
                {courseStatus(item, progress) ?? plural(item.lessons.length, "节课")}
              </span>
              {item.lessons.length > 0 && (progress.finished.size > 0 || progress.partial.size > 0) && (
                <span className="course-bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(3, (progress.finished.size / item.lessons.length) * 100)}%` }} />
                </span>
              )}
            </button>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<GraduationCap size={44} strokeWidth={1.3} />}
          title="还没有课程"
          message="在左侧“位置”中打开存放网课的文件夹（比如网盘里的“大模型”），选择“添加到资料库 ▸ 设为课程文件夹”。每个子文件夹会成为一门课程。"
        >
          <button className="btn" onClick={() => onNavigate({ name: "storage", accountId: library.accounts.find((account) => account.provider === "baidu")?.id ?? "local", path: "/" })}>
            打开网盘
          </button>
        </EmptyState>
      )}
    </div>
  );
}

type CourseTab = "lessons" | "materials";

function CoursePage({ course, library, onNavigate, notify }: { course: Course; library: Library; onNavigate: (route: Route) => void; notify: Notify }) {
  const player = usePlayer();
  const playLesson = usePlayLesson();
  const { open: openDocument, openingId } = useOpenDocument(notify);
  const progress = courseProgress(course, library.savedById);
  const start = progress.next ?? course.lessons[0];
  const number = (lesson: MediaFile) => course.lessons.indexOf(lesson) + 1;
  const [tab, setTab] = useState<CourseTab>(course.lessons.length ? "lessons" : "materials");
  // A large course opens on the part being studied.
  const [moduleKey, setModuleKey] = useState(
    () => course.modules.find((module) => progress.next && module.lessons.includes(progress.next))?.key ?? course.modules[0]?.key ?? "",
  );
  const module = course.modules.find((item) => item.key === moduleKey) ?? course.modules[0];
  // Only a large course whose parts hold a fair number of lessons needs a table of contents; a short
  // one, or one of many tiny chapters, reads best as one list with chapter headings.
  const byModule = course.modules.length > 1 && course.lessons.length > 30 && course.lessons.length / course.modules.length >= 8;

  const lessonMenu = (event: React.MouseEvent, lesson: MediaFile) => {
    const index = course.lessons.indexOf(lesson);
    const learned = progress.finished.has(lesson.id);
    void showContextMenu(event, [
      { label: "播放", action: () => playLesson(course, lesson) },
      ...(progress.partial.has(lesson.id) ? [{ label: "从头播放", action: () => playLesson(course, lesson, true) }] : []),
      "separator",
      learned
        ? { label: "标记为未学", action: () => void library.markWatched([lesson.id], false) }
        : { label: "标记为已学", action: () => void library.markWatched([lesson.id], true) },
      { label: "将之前各节标记为已学", enabled: index > 0, action: () => void library.markWatched(course.lessons.slice(0, index).map((file) => file.id), true) },
    ]);
  };

  const lessonRows = (chapters: Chapter[]) =>
    chapters.map((chapter) => (
      <section key={chapter.key} className="course-chapter">
        {chapter.title && <h2 className="course-chapter-title">{chapter.title}</h2>}
        <ol className="course-lessons">
          {chapter.items.map((item) => {
            const partial = progress.partial.get(item.file.id);
            const learned = progress.finished.has(item.file.id);
            const current = progress.next?.id === item.file.id;
            const label = lessonLabel(item.title);
            return (
              <li key={item.file.id} className={`course-row ${learned ? "learned" : ""} ${current ? "current" : ""}`} onContextMenu={(event) => lessonMenu(event, item.file)}>
                <button className="course-row-main" onClick={() => playLesson(course, item.file)} title={item.file.displayName}>
                  <span className="course-row-index tabular">
                    {player.openingId === item.file.id ? <LoaderCircle className="spin" size={13} /> : (label.number ?? number(item.file))}
                  </span>
                  <span className="course-row-title truncate">{label.text}</span>
                  {learned && <Check className="episode-check" size={13} strokeWidth={2.5} aria-label="已学" />}
                  {partial && partial.duration > 0 && (
                    <span className="episode-progress" title={`看到 ${Math.round((partial.position / partial.duration) * 100)}%`}>
                      <span style={{ width: `${Math.max(6, (partial.position / partial.duration) * 100)}%` }} />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      </section>
    ));

  const materialRows = course.materialChapters.map((chapter) => (
    <section key={chapter.key} className="course-chapter">
      {chapter.title && <h2 className="course-chapter-title">{chapter.title}</h2>}
      <ol className="course-lessons">
        {chapter.items.map((item) => (
          <li key={item.file.id} className="course-row material">
            <button className="course-row-main" onClick={() => void openDocument(item.file)} title={item.file.displayName}>
              <span className="course-row-index">{openingId === item.file.id ? <LoaderCircle className="spin" size={13} /> : <FileText size={14} />}</span>
              <span className="course-row-title truncate">{item.title}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  ));

  return (
    <div className="page">
      <header className="course-hero">
        <CourseCover course={course} />
        <div className="course-facts">
          {course.tags.length > 0 && <p className="course-tags">{course.tags.join(" · ")}</p>}
          <h1 className="large-title selectable">{course.title}</h1>
          <p className="secondary">
            {plural(course.lessons.length, "节课")}
            {course.materials.length > 0 && ` · ${plural(course.materials.length, "份资料")}`}
            {courseStatus(course, progress) && ` · ${courseStatus(course, progress)}`}
          </p>
          <div className="page-actions">
            <button className="btn prominent large" disabled={!start} onClick={() => start && playLesson(course, start)}>
              {start && player.openingId === start.id ? <LoaderCircle className="spin" size={13} /> : <Play size={12} fill="currentColor" strokeWidth={0} />}
              {progress.done ? "从第一节重新学" : progress.next ? `继续学习：第 ${number(progress.next)} 节` : "开始学习"}
            </button>
            <button
              className="btn large more-btn"
              title="更多"
              aria-label="更多操作"
              onClick={(event) =>
                void showContextMenu(event, [
                  { label: "在文件中显示", action: () => onNavigate({ name: "storage", accountId: course.lessons[0]?.accountId ?? course.materials[0]?.accountId ?? "local", path: course.folder }) },
                  "separator",
                  { label: "全部标记为已学", action: () => void library.markWatched(course.lessons.map((file) => file.id), true) },
                  { label: "清除学习记录", action: () => void library.markWatched(course.lessons.map((file) => file.id), false) },
                ])
              }
            >
              <Ellipsis size={15} />
            </button>
          </div>
        </div>
      </header>

      {course.lessons.length > 0 && course.materials.length > 0 && (
        <div className="filter-bar">
          <Segmented<CourseTab>
            ariaLabel="内容"
            value={tab}
            onChange={setTab}
            options={[
              { value: "lessons", label: `课程视频 ${course.lessons.length}` },
              { value: "materials", label: `资料 ${course.materials.length}` },
            ]}
          />
        </div>
      )}

      {tab === "materials" ? (
        materialRows
      ) : byModule && module ? (
        <div className="course-browser">
          <nav className="course-modules" aria-label="课程目录">
            {course.modules.map((item) => {
              const learned = item.lessons.filter((lesson) => progress.finished.has(lesson.id)).length;
              const here = !!progress.next && item.lessons.includes(progress.next);
              return (
                <button
                  key={item.key}
                  className="course-module-row"
                  aria-current={item.key === module.key ? "true" : undefined}
                  onClick={() => setModuleKey(item.key)}
                  title={item.title}
                >
                  <span className="course-module-title truncate">{item.title || "其他"}</span>
                  <span className={`course-module-count ${here ? "here" : ""}`}>
                    {learned === item.lessons.length ? <Check size={12} strokeWidth={2.5} /> : `${learned}/${item.lessons.length}`}
                  </span>
                </button>
              );
            })}
          </nav>
          <div className="course-module-body">
            <h2 className="course-module-heading">{module.title}</h2>
            {lessonRows(module.chapters)}
          </div>
        </div>
      ) : (
        lessonRows(course.chapters)
      )}
    </div>
  );
}
