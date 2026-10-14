# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Cove is a local-first macOS media center (Tauri 2 + React/TypeScript + Rust) that aggregates local disks, WebDAV, Baidu Netdisk, Google Drive and OneDrive into movie / music / document libraries. Internal identifiers still use the old name **Nimbus** (`nimbus_lib`, `NIMBUS_*` env vars, `nimbus-player-state` events, `src/lib/nimbus.ts`) — keep that naming for compatibility. README, docs and UI strings are in Chinese.

The app is macOS-only in practice: `build.rs` compiles Objective-C (`mpv_view.m`, `now_playing.m`, `pdf_view.m`) and links libmpv, Cocoa, MediaPlayer and PDFKit. On Linux, only the frontend (`npm run dev`, `npm run build`, `npm test`) is reliably workable.

## Commands

```bash
npm install
npm run dev                 # Vite frontend only, port 1420 (strict); open /?demo=1 for fixture data
npm run tauri dev           # full desktop app (needs Rust 1.80+, Xcode, libmpv)
npm run build               # tsc typecheck + vite build
npm test                    # node --test tests/*.test.mjs
node --test tests/media.test.mjs                          # one test file
node --test --test-name-pattern="dotted title" tests/media.test.mjs   # one test
cargo test --manifest-path src-tauri/Cargo.toml           # Rust tests
cargo test --manifest-path src-tauri/Cargo.toml <name>    # single Rust test
npm run bundle:mac          # tauri build + scripts/bundle-mac.py (collects dylibs, fixes paths, ad-hoc signs)
```

There is no linter configured; `npm run build` (tsc, `strict`) is the type check.

Environment knobs:
- `NIMBUS_MPV_PREFIX` — libmpv location (default `/opt/homebrew`, else `/usr/local`).
- `NIMBUS_DATA_DIR` — isolate the SQLite database directory (for testing).
- `NIMBUS_TEST_MEDIA=/abs/path` — on launch, opens that local file through the normal playback / PDF path (native self-test, `run_self_test` in `lib.rs`).
- `.env` (`NIMBUS_BAIDU_APP_KEY`, `NIMBUS_BAIDU_SECRET_KEY`, `NIMBUS_BAIDU_REDIRECT_URI`, `NIMBUS_TMDB_READ_ACCESS_TOKEN`) is read at runtime in dev. It is embedded into the binary **only** with `NIMBUS_BUNDLE_PERSONAL_CONFIG=1` (`npm run bundle:mac:personal`); such builds must not be distributed.

## Testing approach

JS tests don't use a bundler: each `tests/*.test.mjs` reads a pure TS module from `src/lib` or `src/app` (e.g. `media.ts`, `navigation.ts`, `playback.ts`, `playlists.ts`, `storage.ts`), transpiles it with `ts.transpileModule`, and imports it as a `data:` URL. Consequently those modules must stay self-contained — no imports of other project files or Tauri APIs — or the tests break. Put testable logic in such pure modules.

Rust tests live inline (`#[cfg(test)] mod tests`) in `webdav.rs`, `metadata.rs`, `direct.rs`, and in `src-tauri/src/tests/{player,store}.rs`.

Browser-only verification: `/?demo=1` serves fixture data from `src/lib/preview.ts` (mock player, no cloud, no video); `/tests/music-layout.html` auto-plays a demo song with long lyrics; `/?player-controls&demo=1&fixture=video` renders the video control overlay.

## Architecture

**Frontend ↔ backend bridge.** `src/lib/nimbus.ts` is the single typed wrapper around Tauri `invoke`/`listen`. When not running inside Tauri (`isTauri()` in `src/lib/native.ts`) and `?demo=1` is set, it returns fixtures from `preview.ts` instead. Adding a backend command means: implement it in `src-tauri/src/commands/*` (or a module like `documents.rs`), register it in `generate_handler!` in `src-tauri/src/lib.rs`, and add the typed wrapper + demo fallback in `nimbus.ts`.

**Frontend layout.** `src/app` (window shell `MainWindow`, `Sidebar`, Finder-style back/forward history in `navigation.ts`, library data in `useLibrary.ts`), `src/player` (`PlayerProvider` state, music Now Playing / lyrics, video overlay), `src/views` (one per route), `src/ui` (shared controls, native menu host, sheets, toasts), `src/styles` (`tokens.css` design tokens). Native menus and context menus go through `src/lib/native.ts` (real `NSMenu` via Tauri menu API).

**Two webview windows** (`tauri.conf.json`): `main`, and a hidden transparent `player-controls` window (`index.html?player-controls=1`) layered over the native mpv view for video controls. `lib.rs` keeps it attached to `main` on move/resize. Closing `main` while video plays stops the video; while music plays it hides the window and keeps playing.

**Backend (`src-tauri/src`).**
- `lib.rs` — app setup, `AppState { store, proxy, credentials, player }`, command registration, and a 500 ms poll loop that reads player status, renews proxy sessions, syncs macOS Now Playing, emits `nimbus-player-state`, and saves playback progress every 30 s.
- `store.rs` — SQLite (WAL) via rusqlite. Schema: `migrations/001_initial.sql`, `002_*.sql`, then further migrations are inline in `Store::open`, gated by `PRAGMA user_version` (currently up to 6). New migrations follow that pattern: `if version < N { ... PRAGMA user_version = N ... }`.
- `direct.rs` — cloud provider clients (Baidu OAuth/token refresh/scan/download URLs, Google Drive, OneDrive) and media-extension classification; `webdav.rs` (PROPFIND, recursive scan; non-HTTPS remote endpoints rejected except localhost); `local_storage.rs`.
- `credentials.rs` — secrets live in macOS Keychain (`keyring`); SQLite stores only references. Secrets are wrapped in `Zeroizing`.
- `proxy.rs` — axum HTTP Range proxy bound to `127.0.0.1` only, with short-lived per-file token sessions; mpv streams through it. Cached direct URLs are refreshed per session.
- `player.rs` + `mpv_view.m` — libmpv embedded as a native view, controlled over a JSON IPC Unix socket.
- `now_playing.rs/.m` (MPRemoteCommandCenter / MPNowPlayingInfoCenter), `documents.rs` + `pdf_view.m` (native PDFKit reader with page memory), `menu.rs` (native menu bar), `metadata.rs` (TMDB / music metadata, cached in `metadata_cache`), `ai_subtitles.rs`.

**Library model.** Users add *media sources*: a specific directory on an account designated as a movie, music or document library. Each source scans and reconciles incrementally on its own; only explicitly chosen directories appear in the aggregated library (legacy whole-drive scans are not shown). Movie/series grouping (title extraction, season/episode parsing incl. Chinese numerals, edition handling, dedup across qualities) is done client-side in `src/lib/media.ts` and is heavily unit-tested.

## Docs

`docs/` holds dated design / QA / acceptance records (e.g. `PERSONAL-SPACE-ACCEPTANCE.md`, `NATIVE-REDESIGN-*.md`, `SERIES-GROUPING-2026-10-11.md`). Read the relevant one before reworking an area; they record intended interaction behavior (Finder-like file browser, single control bar for video, Music-app-like window close, etc.).
