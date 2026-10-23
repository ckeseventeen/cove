import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const output = ts.transpileModule(readFileSync(new URL('../src/lib/reader.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const reader = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

test('zoom steps from any scale and stops at either end', () => {
  assert.equal(reader.stepZoom(1, 1), 1.1);
  assert.equal(reader.stepZoom(1.18, 1), 1.25);
  assert.equal(reader.stepZoom(1.18, -1), 1.1);
  assert.equal(reader.stepZoom(4, 1), 4);
  assert.equal(reader.stepZoom(0.5, -1), 0.5);
});

test('fit width leaves the page gap on both sides', () => {
  assert.equal(reader.fitWidthScale(600, 632), 1);
  assert.equal(reader.fitWidthScale(600, 10), 0.5);
  assert.equal(reader.fitWidthScale(0, 800), 1);
});

test('the page being read is the last one past the reading line', () => {
  const tops = reader.pageTops([1000, 1000, 1000]);
  assert.deepEqual(tops, [16, 1032, 2048]);
  assert.equal(reader.pageAt(tops, 0, 800), 0);
  // The line sits 320px down: page 2 counts once its top passes it.
  assert.equal(reader.pageAt(tops, 700, 800), 0);
  assert.equal(reader.pageAt(tops, 720, 800), 1);
  assert.equal(reader.pageAt(tops, 99999, 800), 2);
});

test('only pages near the window are drawn', () => {
  const heights = Array(100).fill(1000);
  const tops = reader.pageTops(heights);
  assert.deepEqual(reader.pagesToDraw(tops, heights, 0, 800, 800), [0, 1]);
  assert.deepEqual(reader.pagesToDraw(tops, heights, 50_000, 800, 800), [48, 50]);
  assert.deepEqual(reader.pagesToDraw([], [], 0, 800, 800), [0, -1]);
});

test('the reader reads what it was opened with', () => {
  const params = reader.readerParams('?reader=1&key=local%3A%2FBooks%2Fa.pdf&title=%E8%AF%BE%E4%BB%B6&file=C%3A%5Ca.pdf&page=12');
  assert.deepEqual(params, { key: 'local:/Books/a.pdf', title: '课件', file: 'C:\\a.pdf', page: 12, src: undefined });
  assert.equal(reader.readerParams('?page=-3').page, 0);
});
