import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const source = readFileSync(new URL('../src/lib/media.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const media = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const file = (name, folder = '/影视', size = 100, mediaKind = 'movie') =>
  ({ id: name, accountId: 'test', sourceId: 'source', mediaKind, displayName: name, cloudPath: `${folder}/${name}`, size });
const library = (files) => {
  const works = media.buildMovieWorks(files.filter((item) => item.mediaKind === 'movie'));
  const workByFileId = new Map();
  for (const work of works) for (const item of work.files) workByFileId.set(item.id, work);
  return { filesById: new Map(files.map((item) => [item.id, item])), workByFileId };
};
const saved = (fileId, position, duration, updatedAt) => ({ fileId, position, duration, updatedAt });
const resume = (files, recent, limit) => {
  const { filesById, workByFileId } = library(files);
  return media.continueWatching(recent, filesById, workByFileId, limit)
    .map((item) => ({ id: item.file.id, position: item.position, upNext: item.upNext }));
};

test('songs and finished films never take a 继续播放 slot', () => {
  const files = [file('海边的信.2024.mkv'), file('远山来客.2021.mkv'), ...Array.from({ length: 8 }, (_, index) => file(`歌 ${index}.flac`, '/音乐', 10, 'music'))];
  const recent = [
    ...Array.from({ length: 8 }, (_, index) => saved(`歌 ${index}.flac`, 40, 200, 100 + index)),
    saved('远山来客.2021.mkv', 0, 6000, 50),
    saved('海边的信.2024.mkv', 3000, 6000, 10),
  ];
  assert.deepEqual(resume(files, recent), [{ id: '海边的信.2024.mkv', position: 3000, upNext: false }]);
});

test('a binge of one series is one card for the episode in progress, newest work first', () => {
  const episodes = [1, 2, 3, 4, 5].map((episode) => file(`云上旅行.S01E0${episode}.mkv`));
  const files = [...episodes, file('慢慢走.2022.mkv')];
  const recent = [
    saved('慢慢走.2022.mkv', 600, 6000, 5),
    saved('云上旅行.S01E01.mkv', 0, 2700, 10),
    saved('云上旅行.S01E02.mkv', 0, 2700, 20),
    saved('云上旅行.S01E03.mkv', 0, 2700, 30),
    saved('云上旅行.S01E04.mkv', 1200, 2700, 40),
  ];
  assert.deepEqual(resume(files, recent), [
    { id: '云上旅行.S01E04.mkv', position: 1200, upNext: false },
    { id: '慢慢走.2022.mkv', position: 600, upNext: false },
  ]);
});

test('a finished episode is followed by the next one, keeping its own saved position', () => {
  const files = [1, 2, 3, 4].map((episode) => file(`云上旅行.S01E0${episode}.mkv`));
  assert.deepEqual(resume(files, [saved('云上旅行.S01E02.mkv', 0, 2700, 20)]), [{ id: '云上旅行.S01E03.mkv', position: 0, upNext: true }]);
  // Watched to 96% but saved before the library reset it: still finished.
  assert.deepEqual(resume(files, [saved('云上旅行.S01E02.mkv', 2600, 2700, 20)]).map((item) => item.id), ['云上旅行.S01E03.mkv']);
  const older = [saved('云上旅行.S01E03.mkv', 300, 2700, 5), saved('云上旅行.S01E02.mkv', 0, 2700, 20)];
  assert.deepEqual(resume(files, older), [{ id: '云上旅行.S01E03.mkv', position: 300, upNext: true }]);
});

test('the next episode crosses into the next season, and a finished finale leaves the series out', () => {
  const files = [file('示例剧.S01E01.mkv'), file('示例剧.S01E02.mkv'), file('示例剧.S02E01.mkv')];
  assert.deepEqual(resume(files, [saved('示例剧.S01E02.mkv', 0, 2700, 1)]).map((item) => item.id), ['示例剧.S02E01.mkv']);
  assert.deepEqual(resume(files, [saved('示例剧.S02E01.mkv', 0, 2700, 1), saved('示例剧.S01E01.mkv', 900, 2700, 0)]), []);
});

test('finishing another copy of an episode still moves on to the next episode', () => {
  const files = [file('示例剧.S01E01.2160p.mkv', '/影视', 900), file('示例剧.S01E01.1080p.mkv', '/影视', 300), file('示例剧.S01E02.mkv')];
  assert.deepEqual(resume(files, [saved('示例剧.S01E01.1080p.mkv', 0, 2700, 1)]).map((item) => item.id), ['示例剧.S01E02.mkv']);
});

test('the next episode resumes the copy already begun, not the first copy listed', () => {
  const files = [file('示例剧.S01E01.mkv'), file('示例剧.S01E02.2160p.mkv', '/影视', 900), file('示例剧.S01E02.1080p.mkv', '/影视', 300)];
  const recent = [saved('示例剧.S01E02.1080p.mkv', 600, 2700, 1), saved('示例剧.S01E01.mkv', 0, 2700, 2)];
  assert.deepEqual(resume(files, recent), [{ id: '示例剧.S01E02.1080p.mkv', position: 600, upNext: true }]);
});

test('removed files are skipped and the list stops at the limit', () => {
  const files = Array.from({ length: 8 }, (_, index) => file(`影片${index}.20${10 + index}.mkv`));
  const recent = [saved('已移除.2001.mkv', 100, 6000, 99), ...files.map((item, index) => saved(item.id, 100, 6000, index))];
  const items = resume(files, recent);
  assert.equal(items.length, 6);
  assert.equal(items[0].id, '影片7.2017.mkv');
  assert.equal(resume(files, recent, 2).length, 2);
});

test('series progress: resume the episode begun, else the one after the last finished', () => {
  const files = ['剧.S01E01.mkv', '剧.S01E02.mkv', '剧.S01E03.mkv'].map((name) => file(name, '/影视/剧'));
  const [work] = media.buildMovieWorks(files);
  const saved = (entries) => new Map(entries.map(([id, position, duration, updatedAt]) => [id, { fileId: id, position, duration, updatedAt }]));
  const none = media.workProgress(work, new Map());
  assert.deepEqual([none.next, none.done, none.fraction, media.progressLabel(work, none)], [null, false, 0, null]);
  const begun = media.workProgress(work, saved([['剧.S01E01.mkv', 0, 2400, 1], ['剧.S01E02.mkv', 600, 2400, 2]]));
  assert.equal(begun.next.id, '剧.S01E02.mkv');
  assert.equal(begun.resume.position, 600);
  assert.equal(media.progressLabel(work, begun), '看到第 2 集');
  assert.ok(begun.watched.has(media.episodeKeyOf(files[0])));
  assert.equal(Math.round(begun.fraction * 3), 1);
  const finished = media.workProgress(work, saved([['剧.S01E02.mkv', 0, 2400, 5]]));
  assert.equal(finished.next.id, '剧.S01E03.mkv');
  assert.equal(media.progressLabel(work, finished), '下一集：第 3 集');
  const all = media.workProgress(work, saved([['剧.S01E01.mkv', 0, 2400, 1], ['剧.S01E02.mkv', 0, 2400, 2], ['剧.S01E03.mkv', 0, 2400, 3]]));
  assert.deepEqual([all.done, all.fraction, media.progressLabel(work, all)], [true, 1, '已看完']);
});

test('film progress: time left, then watched', () => {
  const [film] = media.buildMovieWorks([file('影片.2019.mkv')]);
  const at = (position) => new Map([['影片.2019.mkv', { fileId: '影片.2019.mkv', position, duration: 6000, updatedAt: 1 }]]);
  assert.equal(media.progressLabel(film, media.workProgress(film, at(3960))), '还剩 34 分钟');
  assert.equal(media.workProgress(film, at(3000)).fraction, 0.5);
  assert.equal(media.progressLabel(film, media.workProgress(film, at(0))), '已看过');
});
