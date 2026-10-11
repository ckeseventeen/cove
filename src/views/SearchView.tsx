import { useMemo, useState } from "react";
import { ChevronRight, Film, LoaderCircle, Search } from "lucide-react";
import type { Route } from "../app/navigation";
import type { Library } from "../app/useLibrary";
import { plural } from "../lib/format";
import { matchesMusicQuery, providerLabel, type MediaWork } from "../lib/media";
import { EmptyState } from "../ui/controls";
import { EntryIcon, ProviderGlyph } from "../ui/glyphs";
import type { Notify } from "../ui/Toasts";
import { documentKey, readingLabel, useOpenDocument } from "./DocumentsView";
import { SongTable } from "./MusicView";
import { workSubtitle } from "./MoviesView";

type Props = {
  query: string;
  library: Library;
  notify: Notify;
  onNavigate: (route: Route) => void;
  onOpenWork: (work: MediaWork) => void;
};

/** Search across the whole library — works, songs and storage locations. */
export function SearchView({ query, library, notify, onNavigate, onOpenWork }: Props) {
  const { open: openDocument, openingId } = useOpenDocument(notify);
  const [workLimit, setWorkLimit] = useState(12);
  const [songLimit, setSongLimit] = useState(30);
  const needle = query.trim().toLocaleLowerCase();
  const matches = (value?: string) => !!value && value.toLocaleLowerCase().includes(needle);

  const works = useMemo(
    () =>
      needle
        ? library.works.filter((work) => {
            const metadata = library.movieMetadata[work.id];
            return (
              matches(work.title) ||
              matches(metadata?.title) ||
              matches(metadata?.originalTitle) ||
              metadata?.cast.some(matches) ||
              work.files.some((file) => matches(file.displayName))
            );
          })
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [library.movieMetadata, library.works, needle],
  );
  const songs = useMemo(() => (needle ? library.songs.filter((file) => matchesMusicQuery(file, query)) : []), [library.songs, needle, query]);
  const documents = needle
    ? library.documents.filter((file) => matches(file.displayName) || matches(file.cloudPath) || matches(file.remotePath))
    : [];
  const locations = needle
    ? library.accounts.filter(
        (account) =>
          matches(account.label) || library.sources.some((source) => source.accountId === account.id && matches(source.label)),
      )
    : [];

  if (!needle) {
    return (
      <div className="page">
        <EmptyState icon={<Search size={40} strokeWidth={1.4} />} title="搜索资料库" message="输入片名、演员、歌曲或文件夹名称。" />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div className="heading">
          <h1 className="large-title">“{query.trim()}”</h1>
          <p className="page-subtitle">搜索已整理的影视、音乐、文档和存储位置。</p>
        </div>
      </header>

      {!works.length && !songs.length && !documents.length && !locations.length && (
        <EmptyState icon={<Search size={40} strokeWidth={1.4} />} title="无结果" message={`没有找到与“${query.trim()}”相关的内容。试试更短的关键词。`} />
      )}

      {works.length > 0 && (
        <section className="section">
          <div className="section-header">
            <h2 className="section-title">影视</h2>
            {works.length > workLimit && (
              <button className="btn plain" onClick={() => setWorkLimit((value) => value + 24)}>
                显示更多（{works.length - workLimit}）
              </button>
            )}
          </div>
          <div className="result-grid">
            {works.slice(0, workLimit).map((work) => {
              const metadata = library.movieMetadata[work.id];
              return (
                <button key={work.id} className="result-card" onClick={() => onOpenWork(work)}>
                  <span className="result-art">
                    {metadata?.posterUrl ? <img src={metadata.posterUrl} alt="" loading="lazy" draggable={false} /> : <Film size={18} strokeWidth={1.5} />}
                  </span>
                  <span className="result-text">
                    <span className="truncate">{metadata?.title || work.title}</span>
                    <span className="truncate secondary">{workSubtitle(work, metadata)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {songs.length > 0 && (
        <section className="section">
          <div className="section-header">
            <h2 className="section-title">歌曲 · {plural(songs.length, "首")}</h2>
            {songs.length > songLimit && (
              <button className="btn plain" onClick={() => setSongLimit((value) => value + 60)}>
                显示更多（{songs.length - songLimit}）
              </button>
            )}
          </div>
          <SongTable songs={songs} onNavigate={onNavigate} resetKey={query} limit={songLimit} />
        </section>
      )}

      {documents.length > 0 && (
        <section className="section">
          <div className="section-header">
            <h2 className="section-title">文档 · {plural(documents.length, "份")}</h2>
          </div>
          <div className="group-box">
            {documents.slice(0, 30).map((file) => (
              <button key={file.id} className="group-row" onClick={() => void openDocument(file)}>
                {openingId === file.id ? <LoaderCircle className="spin" size={16} /> : <EntryIcon kind="pdf" size={18} />}
                <span className="row-main">
                  <span className="row-title">{file.displayName.replace(/\.pdf$/i, "")}</span>
                  <span className="row-subtitle">{readingLabel(library.readingByKey.get(documentKey(file)))}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {locations.length > 0 && (
        <section className="section">
          <div className="section-header">
            <h2 className="section-title">位置</h2>
          </div>
          <div className="group-box">
            {locations.map((account) => (
              <button key={account.id} className="group-row" onClick={() => onNavigate({ name: "storage", accountId: account.id, path: "/" })}>
                <ProviderGlyph provider={account.provider} />
                <span className="row-main">
                  <span className="row-title">{account.label}</span>
                  <span className="row-subtitle">{providerLabel(account.provider)}</span>
                </span>
                <ChevronRight className="chevron" size={14} />
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
