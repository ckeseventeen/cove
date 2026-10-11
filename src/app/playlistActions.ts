import { createContext, useContext } from "react";
import type { MediaFile, Playlist } from "../lib/nimbus";

/** What song lists need to offer "Add to Playlist", without threading the library through every view. */
export type PlaylistActions = {
  playlists: Playlist[];
  add: (playlist: Playlist, songs: MediaFile[]) => void;
  /** Make a new playlist from these songs and start naming it in the sidebar. */
  create: (songs: MediaFile[]) => void;
};

export const PlaylistActionsContext = createContext<PlaylistActions | null>(null);
export const usePlaylistActions = () => useContext(PlaylistActionsContext);

/** Drag type for songs dragged out of a song list; the payload is a JSON array of file ids. */
export const SONGS_DRAG_TYPE = "application/x-cove-songs";
