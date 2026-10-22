import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const output = ts.transpileModule(readFileSync(new URL('../src/lib/offline.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const offline = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const state = new Map([
  ['a', { fileId: 'a', state: 'done', received: 10, total: 10 }],
  ['b', { fileId: 'b', state: 'downloading', received: 4, total: 10 }],
  ['c', { fileId: 'c', state: 'failed', received: 0, total: 10 }],
]);

test('a season counts what is downloaded and what is still coming', () => {
  assert.deepEqual(offline.offlineSummary(['a', 'b', 'c', 'd'], state), { done: 1, active: 1, total: 4 });
});

test('the menu offers only what applies: failed ones can be downloaded again', () => {
  const actions = offline.offlineActions(['a', 'b', 'c', 'd'], state, { download: '下载这一季', remove: '移除这一季的下载' });
  assert.deepEqual(actions.map((action) => [action.kind, action.ids]), [['download', ['c', 'd']], ['cancel', ['b']], ['remove', ['a']]]);
  assert.deepEqual(offline.offlineActions(['a'], state, { download: '下载', remove: '移除下载' }).map((action) => action.label), ['移除下载']);
});

test('progress is a fraction of the size', () => {
  assert.equal(offline.offlineFraction(state.get('b')), 0.4);
  assert.equal(offline.offlineFraction(undefined), 0);
});
