import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const code = ts.transpileModule(readFileSync(new URL('../src/lib/storage.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const storage = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
test('cloud previews never call local text reader',()=>{for(const provider of ['webdav','baidu','google_drive','onedrive']) assert.equal(storage.storageCapabilities(provider).textPreview,false);assert.equal(storage.storageCapabilities('local').textPreview,true);});
test('copy provider pairs match supported backend routes',()=>{const local={id:'local',provider:'local'}, a={id:'a',provider:'baidu'}, b={id:'b',provider:'baidu'}, drive={id:'g',provider:'google_drive'};for(const [from,to,allowed] of [[local,local,true],[a,local,true],[local,a,true],[a,a,true],[a,b,false],[drive,local,false],[local,drive,false]]) assert.equal(storage.canCopyBetween(from,to),allowed);});
test('folder names reject traversal and preserve Unicode',()=>{for(const name of ['', ' ', '.', '..', 'a/b', 'a\0b']) assert.equal(storage.validFolderName(name),false);assert.equal(storage.validFolderName('  我的文件  '),true);});
test('PDFs are their own kind and groups follow Finder order',()=>{
  assert.deepEqual(storage.classifyEntry('报告.PDF',false),{kind:'pdf',label:'PDF 文稿'});
  assert.equal(storage.classifyEntry('a.docx',false).kind,'document');
  const groups=storage.groupByKind([{name:'b.pdf',isDir:false},{name:'z',isDir:true},{name:'a.mkv',isDir:false},{name:'a.pdf',isDir:false},{name:'x.bin',isDir:false}]);
  assert.deepEqual(groups.map(g=>g.title),['文件夹','影片','PDF 文稿','其他']);
  assert.deepEqual(groups[2].entries.map(e=>e.name),['b.pdf','a.pdf']);
});
