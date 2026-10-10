import { useSyncExternalStore } from "react";
import { subscribePlayer, type PlayerStatus } from "../lib/nimbus";

/**
 * Player status arrives twice a second. Keeping it outside React state means only
 * the components that read position (progress bars, lyrics) re-render on each tick.
 */
export const EMPTY_STATUS: PlayerStatus = {
  fileId: null,
  running: false,
  paused: false,
  eofReached: false,
  position: 0,
  duration: 0,
  speed: 1,
  volume: 100,
  tracks: [],
};

let current: PlayerStatus = EMPTY_STATUS;
const listeners = new Set<() => void>();
let started = false;

function ensureStarted() {
  if (started) return;
  started = true;
  subscribePlayer((next) => {
    current = next;
    listeners.forEach((listener) => listener());
  });
}

function subscribe(listener: () => void) {
  ensureStarted();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readStatus() {
  ensureStarted();
  return current;
}

export function onStatus(listener: (status: PlayerStatus) => void) {
  return subscribe(() => listener(current));
}

export function usePlayerStatus<T>(select: (status: PlayerStatus) => T): T {
  return useSyncExternalStore(subscribe, () => select(readStatus()));
}
