import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const code = ts.transpileModule(readFileSync(new URL('../src/lib/scan.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const scan = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const result = (mediaFiles, extra = {}) => ({visitedDirectories: 3, discoveredFiles: 9, mediaFiles, truncated: false, skippedDirectories: [], ...extra});

test('each folder kind is counted in its own unit', () => {
  assert.deepEqual(scan.scanSummary('读书', 'document', result(12)), {message: '“读书”已更新，共 12 份文档', tone: 'success'});
  assert.equal(scan.scanSummary('歌曲', 'music', result(3)).message, '“歌曲”已更新，共 3 首歌曲');
  assert.equal(scan.scanSummary('影视', 'movie', result(5)).message, '“影视”已更新，共 5 个视频');
});

test('unreadable subfolders are named instead of blaming the folder size', () => {
  const one = scan.scanSummary('影视', 'movie', result(4, {skippedDirectories: ['/Volumes/NAS/Movies/#recycle']}));
  assert.equal(one.tone, 'info');
  assert.equal(one.message, '“影视”已更新，共 4 个视频。“#recycle”无法读取，已跳过，原有条目保留。');
  const many = scan.scanSummary('影视', 'movie', result(4, {skippedDirectories: ['/a/私人/', '/a/b', '/a/c']}));
  assert.match(many.message, /“私人”等 3 个文件夹无法读取/);
  assert.doesNotMatch(many.message, /更小的文件夹/);
});

test('a scan stopped by the size limit keeps the index and says so', () => {
  const summary = scan.scanSummary('影视', 'movie', result(0, {truncated: true}));
  assert.equal(summary.tone, 'info');
  assert.match(summary.message, /只扫描了一部分，已保留原有索引/);
});

test('results without the skipped list still read as a plain update', () => {
  assert.equal(scan.scanSummary('影视', 'movie', {mediaFiles: 2, truncated: false}).tone, 'success');
});

test('background rescans mention only what arrived', () => {
  assert.equal(scan.backgroundScanSummary('影视', 'movie', 3), '“影视”新增 3 个视频');
  assert.equal(scan.backgroundScanSummary('普听音乐', 'music', 1), '“普听音乐”新增 1 首歌曲');
  assert.equal(scan.backgroundScanSummary('影视', 'movie', 0), null);
});
