import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const output = ts.transpileModule(readFileSync(new URL('../src/app/navigation.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const nav = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const storage = (path, accountId = 'local') => ({ name: 'storage', accountId, path });

test('navigating to the current page keeps history unchanged', () => {
  const start = nav.initialHistory;
  assert.equal(nav.navigate(start, { name: 'home' }), start);
  const deep = nav.navigate(start, storage('/a'));
  assert.equal(nav.navigate(deep, storage('/a')), deep);
  assert.notEqual(nav.navigate(deep, storage('/b')), deep);
});

test('back and forward move through entries; a new page drops forward history', () => {
  let history = nav.initialHistory;
  history = nav.navigate(history, { name: 'movies' });
  history = nav.navigate(history, { name: 'music' });
  history = nav.goBack(history);
  assert.equal(nav.currentRoute(history).name, 'movies');
  assert.ok(nav.canGoForward(history));
  history = nav.goForward(history);
  assert.equal(nav.currentRoute(history).name, 'music');
  history = nav.goBack(nav.goBack(history));
  assert.equal(nav.goBack(history), history);
  history = nav.navigate(history, { name: 'settings' });
  assert.equal(nav.canGoForward(history), false);
  assert.deepEqual(history.entries.map((route) => route.name), ['home', 'settings']);
});

test('replace swaps the current entry without growing history', () => {
  const history = nav.navigate(nav.navigate(nav.initialHistory, { name: 'settings' }), { name: 'search' }, { replace: true });
  assert.deepEqual(history.entries.map((route) => route.name), ['home', 'search']);
});

test('media folder filters are distinct pages', () => {
  assert.equal(nav.sameRoute({ name: 'music' }, { name: 'music', sourceId: undefined }), true);
  assert.equal(nav.sameRoute({ name: 'music', sourceId: 'a' }, { name: 'music' }), false);
  assert.equal(nav.sidebarKey({ name: 'movies', sourceId: 'x' }), 'source:x');
  assert.equal(nav.sidebarKey(storage('/deep/folder', 'acc')), 'account:acc');
});

test('removing an account prunes its pages and merges neighbours that become equal', () => {
  let history = nav.initialHistory;
  history = nav.navigate(history, storage('/', 'gone'));
  history = nav.navigate(history, { name: 'settings' });
  history = nav.navigate(history, storage('/x', 'gone'));
  const pruned = nav.pruneHistory(history, (route) => route.name === 'storage' && route.accountId === 'gone');
  assert.deepEqual(pruned.entries.map((route) => route.name), ['home', 'settings']);
  assert.equal(nav.currentRoute(pruned).name, 'settings');
  const all = nav.pruneHistory(history, () => true);
  assert.equal(nav.currentRoute(all).name, 'home');
});

test('parent paths stop at the root', () => {
  assert.equal(nav.parentPath('/'), null);
  assert.equal(nav.parentPath('/Users'), '/');
  assert.equal(nav.parentPath('/Users/me/Movies/'), '/Users/me');
});

test('each playlist is its own page and sidebar row', () => {
  const one = { name: 'playlist', id: 'a' };
  let history = nav.navigate(nav.initialHistory, one);
  assert.equal(nav.navigate(history, { name: 'playlist', id: 'a' }), history);
  history = nav.navigate(history, { name: 'playlist', id: 'b' });
  assert.equal(history.entries.length, 3);
  assert.equal(nav.sidebarKey(nav.currentRoute(history)), 'playlist:b');
});
