import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const output = ts.transpileModule(readFileSync(new URL('../src/lib/platform.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const platform = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

test('the system is read from the web view', () => {
  assert.equal(platform.platformOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/130.0'), 'windows');
  assert.equal(platform.platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'), 'mac');
});

test('shortcuts are written the Windows way on Windows', () => {
  const win = (text) => platform.shortcutLabel(text, 'windows');
  assert.equal(win('⌘F'), 'Ctrl+F');
  assert.equal(win('⌥⌘L / ⌥⌘U'), 'Ctrl+Alt+L / Ctrl+Alt+U');
  assert.equal(win('⌃⌘S'), 'Ctrl+Alt+S');
  assert.equal(win('⇧⌘N'), 'Ctrl+Shift+N');
  assert.equal(win('⌘1 – ⌘5'), 'Ctrl+1 – Ctrl+5');
  assert.equal(win('⌘→ / ⌘←'), 'Ctrl+→ / Ctrl+←');
  assert.equal(win('⌘ / ⇧ 点按歌曲'), 'Ctrl / Shift 点按歌曲');
  assert.equal(win('也可以在“显示”菜单中调整：⌘= 放大，⌘− 缩小，⌘0 恢复实际大小。'), '也可以在“显示”菜单中调整：Ctrl+= 放大，Ctrl+− 缩小，Ctrl+0 恢复实际大小。');
  assert.equal(platform.shortcutLabel('⌥⌘L', 'mac'), '⌥⌘L');
});

test('the shortcut key is ⌘ on macOS and Ctrl on Windows', () => {
  const keys = (extra) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra });
  assert.equal(platform.primaryKey(keys({ ctrlKey: true }), 'windows'), true);
  assert.equal(platform.primaryKey(keys({ ctrlKey: true }), 'mac'), false);
  assert.equal(platform.onlyPrimaryKey(keys({ metaKey: true }), 'mac'), true);
  assert.equal(platform.onlyPrimaryKey(keys({ metaKey: true, ctrlKey: true }), 'mac'), false);
  assert.equal(platform.onlyPrimaryKey(keys({ ctrlKey: true, shiftKey: true }), 'windows'), false);
});

test('Windows menu shortcuts are read from the key press', () => {
  const press = (code, key, extra) => platform.windowsMenuShortcut({ metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, code, key, ...extra });
  assert.equal(press('Digit2', '2'), 'cove.go.movies');
  assert.equal(press('Comma', ','), 'cove.settings');
  assert.equal(press('KeyN', 'n'), 'cove.add-storage');
  assert.equal(press('KeyN', 'N', { shiftKey: true }), 'cove.new-folder');
  assert.equal(press('KeyS', 's', { altKey: true }), 'cove.toggle-sidebar');
  assert.equal(press('BracketLeft', '['), 'cove.back');
  assert.equal(press('Equal', '='), 'cove.zoom-in');
  assert.equal(press('ArrowRight', 'ArrowRight'), 'cove.next');
  assert.equal(press('F11', 'F11', { ctrlKey: false }), 'cove.fullscreen');
  // Ctrl+Shift+= is "Ctrl++", which the page zooms itself; plain keys and Ctrl+C stay the page's.
  assert.equal(press('Equal', '+', { shiftKey: true }), undefined);
  assert.equal(press('Digit2', '2', { ctrlKey: false }), undefined);
  assert.equal(press('KeyC', 'c'), undefined);
});
