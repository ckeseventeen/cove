import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const output = ts.transpileModule(readFileSync(new URL('../src/lib/aiSubtitles.ts', import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {aiEndpoint,savedKeyOwner} = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
test('a remembered custom address is never sent for a built-in service',()=>{const stale=' http://192.168.1.10:8000/v1/audio/transcriptions ';for(const provider of ['siliconflow','groq','openai'])assert.equal(aiEndpoint(provider,stale),undefined);assert.equal(aiEndpoint('custom',stale),'http://192.168.1.10:8000/v1/audio/transcriptions');assert.equal(aiEndpoint('custom','  '),undefined);});
test('the saved key is offered only to the service it was saved for',()=>{assert.equal(savedKeyOwner('groq','custom'),'groq');assert.equal(savedKeyOwner('custom','siliconflow'),'custom');});
test('a key saved before owners were recorded never reaches a custom endpoint',()=>{assert.equal(savedKeyOwner(null,'openai'),'openai');assert.equal(savedKeyOwner(null,null),'siliconflow');assert.equal(savedKeyOwner(null,'custom'),null);assert.equal(savedKeyOwner('bogus','bogus'),null);});
