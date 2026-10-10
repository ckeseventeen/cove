import { ChevronRight, Film, FolderOpen, HardDrive, Music2, Play, Plus } from "lucide-react";
import type { Route } from "../app/navigation";
import type { Library } from "../app/useLibrary";
import { formatRemaining, plural } from "../lib/format";
import { containingFolder, episodeLabel, providerLabel, songParts, type MediaWork } from "../lib/media";
import { showContextMenu } from "../lib/native";
import type { MediaFile, RecentPlayback } from "../lib/nimbus";
import { usePlayer } from "../player/PlayerProvider";
import { ProviderGlyph } from "../ui/glyphs";

type Props = {
  library: Library;
  onNavigate: (route: Route) => void;
  onOpenWork: (work: MediaWork) => void;
  onAddStorage: () => void;
};

export function HomeView({ library, onNavigate, onOpenWork, onAddStorage }: Props) {
  const player = usePlayer();
  const history = library.recent.flatMap((item) => {
    const file = library.filesById.get(item.fileId);
    return file ? [{ ...item, file }] : [];
  });
  const cloudCount = library.accounts.filter((account) => account.provider !== "local").length;
  const isNew = library.loaded && !library.sources.length && !cloudCount;

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
            <p>把本机磁盘和云盘里的影片、剧集与音乐放在一处。连接一个存储位置，再选择要放进资料库的文件夹。</p>
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
              <span className="glyph purple small">2</span>把文件夹设为影视或音乐
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
            {history.slice(0, 6).map((item) => (
              <ResumeCard
                key={item.fileId}
                item={item}
                file={item.file}
                library={library}
                onPlay={(fromStart) => void player.play(item.file, { fromStart, queue: [item.file] })}
                onOpenWork={onOpenWork}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <div className="section-header">
          <h2 className="section-title">资料库</h2>
        </div>
        <div className="tile-grid">
          <button className="tile" onClick={() => onNavigate({ name: "movies" })}>
            <span className="glyph purple large">
              <Film size={20} />
            </span>
            <span className="tile-title">影视</span>
            <span className="tile-detail">{plural(library.works.length, "部作品")}</span>
          </button>
          <button className="tile" onClick={() => onNavigate({ name: "music" })}>
            <span className="glyph pink large">
              <Music2 size={20} />
            </span>
            <span className="tile-title">音乐</span>
            <span className="tile-detail">{plural(library.songs.length, "首歌曲")}</span>
          </button>
          <button className="tile" onClick={() => onNavigate({ name: "files" })}>
            <span className="glyph blue large">
              <FolderOpen size={20} />
            </span>
            <span className="tile-title">文件</span>
            <span className="tile-detail">{plural(library.accounts.length, "个位置")}</span>
          </button>
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <h2 className="section-title">位置</h2>
          <button className="btn plain" onClick={() => onNavigate({ name: "files" })}>
            显示全部
          </button>
        </div>
        <div className="group-box">
          {library.accounts.slice(0, 5).map((account) => (
            <button
              key={account.id}
              className="group-row"
              onClick={() => onNavigate({ name: "storage", accountId: account.id, path: "/" })}
            >
              <ProviderGlyph provider={account.provider} />
              <span className="row-main">
                <span className="row-title">{account.label}</span>
                <span className="row-subtitle">{providerLabel(account.provider)}</span>
              </span>
              <ChevronRight className="chevron" size={14} />
            </button>
          ))}
          {!library.accounts.length && (
            <button className="group-row" onClick={onAddStorage}>
              <span className="glyph gray">
                <HardDrive size={15} />
              </span>
              <span className="row-main row-title">添加存储…</span>
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function ResumeCard({
  item,
  file,
  library,
  onPlay,
  onOpenWork,
  onNavigate,
}: {
  item: RecentPlayback;
  file: MediaFile;
  library: Library;
  onPlay: (fromStart: boolean) => void;
  onOpenWork: (work: MediaWork) => void;
  onNavigate: (route: Route) => void;
}) {
  const music = file.mediaKind === "music";
  const work = music ? undefined : library.workByFileId.get(file.id);
  const metadata = work ? library.movieMetadata[work.id] : undefined;
  const title = music ? songParts(file).title : metadata?.title || work?.title || file.displayName;
  const detail = music
    ? songParts(file).artist || "歌曲"
    : work?.isSeries
      ? episodeLabel(file, Math.max(0, work.files.indexOf(file)))
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
          { label: music ? "播放" : "继续播放", action: () => onPlay(false) },
          { label: "从头播放", enabled: !music, action: () => onPlay(true) },
          "separator",
          ...(work ? [{ label: "显示简介", action: () => onOpenWork(work) }] : []),
          {
            label: "在文件中显示",
            enabled: !!folder,
            action: () => folder && onNavigate({ name: "storage", accountId: file.accountId, path: folder }),
          },
        ])
      }
    >
      <span className={`resume-art ${music ? "square" : ""}`}>
        {metadata?.posterUrl ? (
          <img src={metadata.posterUrl} alt="" loading="lazy" draggable={false} />
        ) : music ? (
          <Music2 size={20} strokeWidth={1.6} />
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
        {!music && progress > 0 && (
          <>
            <span className="progress">
              <span style={{ width: `${progress}%` }} />
            </span>
            <span className="resume-detail">{formatRemaining(item.position, item.duration)}</span>
          </>
        )}
      </span>
    </button>
  );
}
