PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  username TEXT,
  secret_ref TEXT NOT NULL UNIQUE,
  caps_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ok',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media_files (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  remote_path TEXT NOT NULL,
  cloud_path TEXT,
  display_name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  modified_at INTEGER,
  etag TEXT,
  mime_type TEXT,
  scan_state TEXT NOT NULL DEFAULT 'new',
  UNIQUE (account_id, remote_path)
);

CREATE INDEX IF NOT EXISTS idx_media_files_account_path ON media_files(account_id, remote_path);

CREATE TABLE IF NOT EXISTS media_sources (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('movie', 'music')),
  remote_root TEXT NOT NULL,
  label TEXT NOT NULL,
  last_scan_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, kind, remote_root)
);

CREATE TABLE IF NOT EXISTS media_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('movie', 'series', 'episode')),
  title TEXT NOT NULL,
  original_title TEXT,
  year INTEGER,
  overview TEXT,
  rating REAL,
  poster_path TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media_editions (
  media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  label TEXT,
  PRIMARY KEY (media_id, file_id)
);

CREATE TABLE IF NOT EXISTS watch_progress (
  media_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
  position_sec REAL NOT NULL,
  duration_sec REAL NOT NULL,
  playback_state_json TEXT NOT NULL DEFAULT '{}',
  completed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playback_progress (
  file_id TEXT PRIMARY KEY REFERENCES media_files(id) ON DELETE CASCADE,
  position_sec REAL NOT NULL DEFAULT 0,
  duration_sec REAL NOT NULL DEFAULT 0,
  speed REAL NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
