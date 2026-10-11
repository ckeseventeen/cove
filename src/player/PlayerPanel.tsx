import { AudioLines, ChevronDown, ChevronUp, ListMusic, X } from "lucide-react";
import { songParts } from "../lib/media";
import type { MediaFile } from "../lib/nimbus";
import { showContextMenu } from "../lib/native";
import { EmptyState, Segmented } from "../ui/controls";
import { Lyrics } from "./Lyrics";
import { Artwork, RepeatButton, ShuffleButton } from "./MiniPlayer";
import { usePlayer, type PanelKind } from "./PlayerProvider";

/** Right-hand inspector, like the Lyrics / Playing Next panel in Music. */
export function PlayerPanel() {
  const player = usePlayer();
  if (!player.panel) return null;
  return (
    <aside className="panel player-panel" aria-label={player.panel === "lyrics" ? "歌词" : "待播清单"}>
      <div className="panel-header">
        <Segmented<PanelKind>
          className="stretch"
          ariaLabel="面板内容"
          value={player.panel}
          onChange={player.setPanel}
          options={[
            { value: "lyrics", label: "歌词" },
            { value: "queue", label: "待播清单" },
          ]}
        />
      </div>
      <div className="panel-body">{player.panel === "lyrics" ? <Lyrics variant="panel" /> : <QueueList />}</div>
    </aside>
  );
}

function QueueList() {
  const player = usePlayer();
  const current = player.nowPlaying && !player.isVideo ? player.nowPlaying : null;
  if (!current) {
    return (
      <EmptyState
        compact
        icon={<ListMusic size={36} strokeWidth={1.5} />}
        title="待播清单为空"
        message="在音乐中播放歌曲后，接下来的歌曲会显示在这里。"
      />
    );
  }
  const upcoming = player.queue.slice(player.currentIndex + 1);
  const parts = songParts(current);
  return (
    <div className="queue">
      <p className="queue-heading">正在播放</p>
      <div className="queue-now">
        <Artwork url={player.metadata?.artworkUrl} size={40} />
        <div className="queue-text">
          <div className="truncate">{player.metadata?.title || parts.title}</div>
          <div className="truncate secondary">{player.metadata?.artist || parts.artist || "未知艺人"}</div>
        </div>
        <AudioLines size={15} className="queue-playing" />
      </div>
      <div className="queue-heading row">
        <span>接下来播放</span>
        <ShuffleButton size={14} />
        <RepeatButton size={14} />
        <button className="btn plain" disabled={!upcoming.length} onClick={player.clearUpcoming}>
          清除
        </button>
      </div>
      {upcoming.length ? (
        <ol className="queue-list">
          {upcoming.map((file, offset) => (
            <QueueRow key={file.id} file={file} index={player.currentIndex + 1 + offset} last={offset === upcoming.length - 1} />
          ))}
        </ol>
      ) : (
        <p className="queue-end secondary">{player.repeat === "all" ? "播放完毕后将从头重复。" : player.repeat === "one" ? "单曲重复已打开。" : "这是最后一首歌曲。"}</p>
      )}
    </div>
  );
}

function QueueRow({ file, index, last }: { file: MediaFile; index: number; last: boolean }) {
  const player = usePlayer();
  const parts = songParts(file);
  const first = index === player.currentIndex + 1;
  return (
    <li
      className="queue-row"
      onDoubleClick={() => void player.play(file, { fromStart: true, keepQueue: true })}
      onContextMenu={(event) =>
        void showContextMenu(event, [
          { label: "播放", action: () => void player.play(file, { fromStart: true, keepQueue: true }) },
          { label: "移到最前", enabled: !first, action: () => player.playNext(file) },
          "separator",
          { label: "从待播清单中移除", action: () => player.removeFromQueue(file.id) },
        ])
      }
    >
      <div className="queue-text">
        <div className="truncate" title={parts.title}>
          {parts.title}
        </div>
        {parts.artist && <div className="truncate secondary">{parts.artist}</div>}
      </div>
      <div className="queue-actions">
        <button className="icon-btn small" title="提前" aria-label={`提前 ${parts.title}`} disabled={first} onClick={() => player.moveInQueue(index, -1)}>
          <ChevronUp size={13} />
        </button>
        <button className="icon-btn small" title="延后" aria-label={`延后 ${parts.title}`} disabled={last} onClick={() => player.moveInQueue(index, 1)}>
          <ChevronDown size={13} />
        </button>
        <button className="icon-btn small" title="移除" aria-label={`移除 ${parts.title}`} onClick={() => player.removeFromQueue(file.id)}>
          <X size={13} />
        </button>
      </div>
    </li>
  );
}
