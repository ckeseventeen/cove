BEGIN IMMEDIATE;
CREATE TABLE source_files (
 source_id TEXT NOT NULL REFERENCES media_sources(id) ON DELETE CASCADE,
 file_id TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
 present INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(source_id,file_id)
);
CREATE INDEX idx_source_files_file ON source_files(file_id,present);
INSERT OR IGNORE INTO source_files(source_id,file_id,present)
 SELECT f.source_id,f.id,CASE WHEN f.scan_state='ready' THEN 1 ELSE 0 END
 FROM media_files f JOIN media_sources s ON s.id=f.source_id;
CREATE TRIGGER metadata_cleanup AFTER DELETE ON media_files BEGIN
 DELETE FROM metadata_cache WHERE file_id=OLD.id;
END;
PRAGMA user_version=2;
COMMIT;
