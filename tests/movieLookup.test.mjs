import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const output = ts.transpileModule(readFileSync(new URL('../src/lib/movieLookup.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { createMovieLookups, compareWorks, needsAllDetails, workYear } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

/** Mirrors movie_metadata: a manual lookup saves the name for every file sent, and later lookups use it. */
function fakeBackend() {
  const overrides = new Map();
  const calls = [];
  const answer = (name) => (name === 'The Day of the Jackal' ? '豺狼的日子 (2024 剧集)' : '豺狼末日 (1973 电影)');
  const load = async (request) => {
    calls.push(request);
    if (request.refresh) request.fileIds.forEach((id) => overrides.set(id, request.lookupName));
    const saved = request.fileIds.map((id) => overrides.get(id)).find(Boolean);
    return { title: answer(request.refresh ? request.lookupName : saved ?? request.lookupName) };
  };
  return { load, calls };
}

const jackal = { fileIds: ['e01-1080p', 'e02-1080p'], lookupName: '豺狼的日子', series: true };

test('reopening the detail sheet after 修正匹配 keeps the chosen match', async () => {
  const backend = fakeBackend();
  const { lookup } = createMovieLookups(backend.load);
  assert.equal((await lookup(jackal)).title, '豺狼末日 (1973 电影)');
  assert.equal((await lookup({ ...jackal, lookupName: 'The Day of the Jackal', refresh: true })).title, '豺狼的日子 (2024 剧集)');
  assert.equal((await lookup(jackal)).title, '豺狼的日子 (2024 剧集)');
  // Lookups under the work's own name are memoized again after that.
  const calls = backend.calls.length;
  await lookup(jackal);
  assert.equal(backend.calls.length, calls);
});

test('a lookup already under way gives way to a manual match that lands first', async () => {
  const pending = deferred();
  const { lookup } = createMovieLookups((request) => (request.refresh ? Promise.resolve({ title: 'manual' }) : pending.promise));
  const automatic = lookup(jackal);
  await settle();
  assert.equal((await lookup({ ...jackal, lookupName: 'The Day of the Jackal', refresh: true })).title, 'manual');
  pending.resolve({ title: 'automatic' });
  assert.equal((await automatic).title, 'manual');
  // A failed automatic lookup does not hide the manual match either.
  const failing = deferred();
  const second = createMovieLookups((request) => (request.refresh ? Promise.resolve({ title: 'manual' }) : failing.promise));
  const pendingLookup = second.lookup(jackal);
  await settle();
  await second.lookup({ ...jackal, lookupName: 'x', refresh: true });
  failing.reject(new Error('TMDB 未找到'));
  assert.equal((await pendingLookup).title, 'manual');
});

test('a failed manual match keeps earlier answers', async () => {
  let fail = true;
  let loads = 0;
  const { lookup } = createMovieLookups(async (request) => {
    loads++;
    if (request.refresh && fail) throw new Error('TMDB 未找到');
    return { title: request.lookupName };
  });
  assert.equal((await lookup(jackal)).title, '豺狼的日子');
  await assert.rejects(lookup({ ...jackal, lookupName: '不存在', refresh: true }));
  assert.equal((await lookup(jackal)).title, '豺狼的日子');
  assert.equal(loads, 2);
});

test('every file of the work is sent, so a larger copy that now comes first keeps the match', async () => {
  const backend = fakeBackend();
  const { lookup } = createMovieLookups(backend.load);
  await lookup({ ...jackal, lookupName: 'The Day of the Jackal', refresh: true });
  // A 4K copy of the first episode is added and sorts first.
  const regrouped = { ...jackal, fileIds: ['e01-2160p', ...jackal.fileIds] };
  assert.equal((await lookup(regrouped)).title, '豺狼的日子 (2024 剧集)');
  assert.deepEqual(backend.calls.at(-1).fileIds, ['e01-2160p', 'e01-1080p', 'e02-1080p']);
});

test('failures are retried after a short wait, answers are kept longer', async () => {
  let clock = 0;
  let loads = 0;
  const { lookup } = createMovieLookups(
    async () => {
      loads++;
      if (loads === 1) throw new Error('offline');
      return { title: 'ok' };
    },
    { ttl: 1000, retryAfter: 100, now: () => clock },
  );
  await assert.rejects(lookup(jackal));
  await assert.rejects(lookup(jackal));
  assert.equal(loads, 1);
  clock = 150;
  assert.equal((await lookup(jackal)).title, 'ok');
  clock = 900;
  await lookup(jackal);
  assert.equal(loads, 2);
});

test('at most three lookups run, and background prefetches leave one for what is on screen', async () => {
  const gates = new Map();
  let running = 0;
  let most = 0;
  const started = [];
  const { lookup } = createMovieLookups(async (request) => {
    const name = request.lookupName;
    started.push(name);
    running++;
    most = Math.max(most, running);
    const gate = deferred();
    gates.set(name, gate);
    try {
      return await gate.promise;
    } finally {
      running--;
    }
  });
  const work = (name, background) => lookup({ fileIds: [name], lookupName: name, series: false, background });
  const prefetches = ['b1', 'b2', 'b3', 'b4', 'b5'].map((name) => work(name, true));
  await settle();
  assert.deepEqual(started, ['b1', 'b2']);
  const card = work('card');
  await settle();
  assert.deepEqual(started, ['b1', 'b2', 'card']);
  // b5 scrolls into view while it waits: it goes ahead of b3 and b4.
  const promoted = work('b5');
  assert.equal(promoted, prefetches[4]);
  gates.get('b1').resolve({ title: 'b1' });
  await settle();
  assert.deepEqual(started, ['b1', 'b2', 'card', 'b5']);
  for (const name of ['b2', 'card', 'b5']) gates.get(name).resolve({ title: name });
  await settle();
  assert.deepEqual(started, ['b1', 'b2', 'card', 'b5', 'b3', 'b4']);
  for (const name of ['b3', 'b4']) gates.get(name).resolve({ title: name });
  await Promise.all([...prefetches, card]);
  assert.equal(most, 3);
});

const film = (id, title, year) => ({ id, title, year, files: [], seasons: [], isSeries: false });
const show = (id, title) => ({ id, title, files: [], seasons: [1], isSeries: true });

test('ordering by year uses the year in the file name until details arrive', () => {
  const works = [film('dune', '沙丘', '2021'), show('jackal', '豺狼的日子'), film('alien', '异形', '1979'), film('her', 'Her')];
  const metadata = { jackal: { title: '豺狼的日子', year: 2024, rating: 7.6 } };
  assert.deepEqual([...works].sort(compareWorks('recent', metadata)).map((work) => work.id), ['jackal', 'dune', 'alien', 'her']);
  assert.deepEqual([...works].sort(compareWorks('oldest', metadata)).map((work) => work.id), ['alien', 'dune', 'jackal', 'her']);
  assert.equal(workYear(works[0]), 2021);
  assert.equal(workYear(works[0], { year: 2020 }), 2020);
  assert.equal(workYear(works[1]), undefined);
});

test('ties and works without a rating are ordered by title', () => {
  const works = [film('b', '第10集'), film('a', '第2集'), film('c', '异形', '1979')];
  const metadata = { c: { title: 'Alien', year: 1979, rating: 8.1 } };
  assert.deepEqual([...works].sort(compareWorks('rating', metadata)).map((work) => work.id), ['c', 'a', 'b']);
  assert.deepEqual([...works].sort(compareWorks('title', {})).map((work) => work.id), ['a', 'b', 'c']);
});

test('category filters and the year and rating orders need every work\'s details', () => {
  assert.equal(needsAllDetails('all', 'title'), false);
  for (const category of ['movie', 'tv', 'documentary', 'animation']) assert.equal(needsAllDetails(category, 'title'), true);
  for (const sort of ['recent', 'oldest', 'rating']) assert.equal(needsAllDetails('all', sort), true);
});
