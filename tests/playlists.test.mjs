import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const output = ts.transpileModule(readFileSync(new URL('../src/lib/playlists.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { appendUnique, moveIds, untitledName } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

test('adding songs skips ones already in the playlist and duplicates in the request', () => {
  assert.deepEqual(appendUnique(['a', 'b'], ['b', 'c', 'c', 'd']), { order: ['a', 'b', 'c', 'd'], added: 2 });
  assert.deepEqual(appendUnique(['a'], ['a']), { order: ['a'], added: 0 });
});

test('dragging a selection keeps its relative order and lands before the target', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(moveIds(order, ['d', 'b'], 'a'), ['b', 'd', 'a', 'c', 'e']);
  assert.deepEqual(moveIds(order, ['a'], null), ['b', 'c', 'd', 'e', 'a']);
  assert.deepEqual(moveIds(order, ['a', 'b'], 'e'), ['c', 'd', 'a', 'b', 'e']);
});

test('dropping onto itself or an unknown row changes nothing', () => {
  const order = ['a', 'b', 'c'];
  assert.equal(moveIds(order, ['b'], 'b'), order);
  assert.equal(moveIds(order, ['b'], 'c'), order);
  assert.equal(moveIds(order, ['b'], 'zz'), order);
  assert.equal(moveIds(order, ['zz'], 'a'), order);
});

test('new playlists get the next free untitled name', () => {
  assert.equal(untitledName([]), '未命名播放列表');
  assert.equal(untitledName(['未命名播放列表', '未命名播放列表 2']), '未命名播放列表 3');
});
