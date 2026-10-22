import { useMemo, useState } from "react";
import { FileType2, Film, LoaderCircle, Play, Plus } from "lucide-react";
import type { Route } from "../app/navigation";
import type { Library } from "../app/useLibrary";
import { courseProgress } from "../lib/courses";
import { CourseCover, courseStatus, usePlayLesson } from "./CoursesView";
import { formatRelative, formatRemaining } from "../lib/format";
import {
  containingFolder,
  continueWatching,
  displayTitleOf,
  episodeLabel,
  seasonLabel,
  seasonOf,
  type MediaWork,
  type ResumeItem,
} from "../lib/media";
import { showContextMenu } from "../lib/native";
import { openDocument, type ReadingProgress } from "../lib/nimbus";
import type { Notify } from "../ui/Toasts";
import { readingLabel } from "./DocumentsView";
import { usePlayer } from "../player/PlayerProvider";
import { EmptyState } from "../ui/controls";

type Props = {
  library: Library;
  notify: Notify;
  onNavigate: (route: Route) => void;
  onOpenWork: (work: MediaWork) => void;
  onAddStorage: () => void;
};

export function HomeView({ library, notify, onNavigate, onOpenWork, onAddStorage }: Props) {
  const player = usePlayer();
  const history = useMemo(
    () => continueWatching(library.recent, library.filesById, library.workByFileId),
    [library.recent, library.filesById, library.workByFileId],
  );
  const cloudCount = library.accounts.filter((account) => account.provider !== "local").length;
  const isNew = library.loaded && !library.sources.length && !cloudCount;
  // A document whose storage was removed can no longer be opened. Until the accounts have loaded
  // (or if loading them failed) the list is unknown, and the native side already leaves those out.
  const accountIds = new Set(library.accounts.map((account) => account.id));
  const reading = library.reading.filter(
    (item) => item.pageCount > 0 && (!accountIds.size || accountIds.has(item.accountId)),
  );
  // Courses under way, most recently studied first.
  const studying = useMemo(
    () =>
      library.courses
        .map((course) => ({ course, progress: courseProgress(course, library.savedById) }))
        .filter(({ progress }) => progress.next && !progress.done)
        .sort((left, right) => right.progress.lastStudied - left.progress.lastStudied)
        .slice(0, 6),
    [library.courses, library.savedById],
  );
  const playLesson = usePlayLesson();

  return (
    <div className="page home">
      <header className="page-header">
        <div className="heading">
          <h1 className="large-title">首页</h1>
        </div>
      </header>

      {isNew && (
        <section className="welcome">
          <div className="welcome-copy">
            <h2>欢迎使用 Cove</h2>
            <p>把本机磁盘和云盘里的影片、剧集、音乐与文档放在一处。连接一个存储位置，再选择要放进资料库的文件夹。</p>
            <div className="welcome-actions">
              <button className="btn prominent large" onClick={onAddStorage}>
                <Plus size={14} />
                添加存储…
              </button>
              <button className="btn large" onClick={() => onNavigate({ name: "storage", accountId: "local", path: "/" })}>
                浏览本地磁盘
              </button>
            </div>
          </div>
          <ol className="welcome-steps">
            <li>
              <span className="glyph blue small">1</span>连接本地磁盘、WebDAV 或网盘
            </li>
            <li>
              <span className="glyph purple small">2</span>把文件夹设为影视、音乐或文档
            </li>
            <li>
              <span className="glyph pink small">3</span>Cove 整理作品、剧集和歌词
            </li>
          </ol>
        </section>
      )}

      {history.length > 0 && (
        <section className="section">
          <div className="section-header">
            <h2 className="section-title">继续播放</h2>
          </div>
          <div className="resume-grid">
            {history.map((item) => (
              <ResumeCard
                key={item.work.id}
                item={item}
                library={library}
                onPlay={(fromStart) => void player.play(item.file, { fromStart })}
                onOpenWork={onOpenWork}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </section>
      )}

      {studying.length > 0 && (
        <section className="section">
          <div className="section-header">
            <h2 className="section-title">继续学习</h2>
          </div>
          <div className="resume-grid">
            {studying.map(({ course, progress }) => (
              <button
                key={course.id}
                className="resume-card"
                onClick={() => progress.next && playLesson(course, progress.next)}
                onContextMenu={(event) =>
                  void showContextMenu(event, [
                    { label: "继续学习", action: () => progress.next && playLesson(course, progress.next) },
                    { label: "打开课程", action: () => onNavigate({ name: "courses", course: course.id }) },
                  ])
                }
              >
                <span className="resume-art course">
                  <CourseCover course={course} size="small" />
                  <span className="resume-play">
                    <Play size={14} fill="currentColor" strokeWidth={0} />
                  </span>
                </span>
                <span className="resume-text">
                  <span className="resume-title truncate">{course.title}</span>
                  <span className="resume-detail truncate">
                    第 {course.lessons.indexOf(progress.next!) + 1} 节 · {progress.next!.displayName.replace(/\.[^.]+$/, "")}
                  </span>
                  <span className="progress">
                    <span style={{ width: `${(progress.finished.size / Math.max(course.lessons.length, 1)) * 100}%` }} />
                  </span>
                  <span className="resume-detail">{courseStatus(course, progress)}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {reading.length > 0 && (
        <section className="section">
          <div className="section-header">
            <h2 className="section-title">继续阅读</h2>
          </div>
          <div className="resume-grid">
            {reading.slice(0, 6).map((item) => (
              <ReadingCard key={item.docKey} item={item} notify={notify} />
            ))}
          </div>
        </section>
      )}

      {!isNew && !history.length && !reading.length && !studying.length && (
        <EmptyState
          icon={<Play size={40} strokeWidth={1.3} />}
          title="没有可以继续的内容"
          message="播放影视或阅读 PDF 后，可以在这里从上次停下的地方继续。"
        />
      )}
    </div>
  );
}

function ResumeCard({
  item,
  library,
  onPlay,
  onOpenWork,
  onNavigate,
}: {
  item: ResumeItem;
  library: Library;
  onPlay: (fromStart: boolean) => void;
  onOpenWork: (work: MediaWork) => void;
  onNavigate: (route: Route) => void;
}) {
  const { file, work } = item;
  const metadata = library.movieMetadata[work.id];
  const title = displayTitleOf(work, metadata);
  const detail = work.isSeries
    ? `${work.seasons.length > 1 ? `${seasonLabel(seasonOf(file))} · ` : ""}${episodeLabel(file, Math.max(0, work.files.indexOf(file)))}`
    : metadata?.year
      ? String(metadata.year)
      : "影片";
  const progress = item.duration > 0 ? Math.min(100, (item.position / item.duration) * 100) : 0;
  const folder = containingFolder(file);
  return (
    <button
      className="resume-card"
      onClick={() => onPlay(false)}
      onContextMenu={(event) =>
        void showContextMenu(event, [
          { label: progress > 0 ? "继续播放" : "播放", action: () => onPlay(false) },
          { label: "从头播放", enabled: progress > 0, action: () => onPlay(true) },
          "separator",
          { label: "显示简介", action: () => onOpenWork(work) },
          {
            label: "在文件中显示",
            enabled: !!folder,
            action: () => folder && onNavigate({ name: "storage", accountId: file.accountId, path: folder }),
          },
        ])
      }
    >
      <span className="resume-art">
        {metadata?.posterUrl ? (
          <img src={metadata.posterUrl} alt="" loading="lazy" draggable={false} />
        ) : (
          <Film size={20} strokeWidth={1.6} />
        )}
        <span className="resume-play">
          <Play size={14} fill="currentColor" strokeWidth={0} />
        </span>
      </span>
      <span className="resume-text">
        <span className="resume-title truncate">{title}</span>
        <span className="resume-detail truncate">{detail}</span>
        {progress > 0 ? (
          <>
            <span className="progress">
              <span style={{ width: `${progress}%` }} />
            </span>
            <span className="resume-detail">{formatRemaining(item.position, item.duration)}</span>
          </>
        ) : (
          item.upNext && <span className="resume-detail">下一集</span>
        )}
      </span>
    </button>
  );
}

function ReadingCard({ item, notify }: { item: ReadingProgress; notify: Notify }) {
  const [opening, setOpening] = useState(false);
  const ratio = item.pageCount ? Math.min(1, (item.page + 1) / item.pageCount) : 0;
  const open = async () => {
    if (opening) return;
    setOpening(true);
    try {
      await openDocument(item.accountId, item.path, item.name, item.entryId, item.size);
    } catch (cause) {
      notify(`无法打开“${item.name}”：${cause instanceof Error ? cause.message : String(cause)}`, "error");
    } finally {
      setOpening(false);
    }
  };
  return (
    <button className="resume-card" onClick={() => void open()}>
      <span className="resume-art document">
        {opening ? <LoaderCircle className="spin" size={18} /> : <FileType2 size={20} strokeWidth={1.6} />}
      </span>
      <span className="resume-text">
        <span className="resume-title truncate">{item.name.replace(/\.pdf$/i, "")}</span>
        <span className="resume-detail truncate">{readingLabel(item)}</span>
        <span className="progress">
          <span style={{ width: `${ratio * 100}%` }} />
        </span>
        <span className="resume-detail">{formatRelative(item.updatedAt)}</span>
      </span>
    </button>
  );
}
