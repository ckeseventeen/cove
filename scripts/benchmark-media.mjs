import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import ts from 'typescript';
const output=ts.transpileModule(readFileSync(new URL('../src/lib/media.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {buildMovieWorks}=await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
for(const count of [1000,10000,50000]) {
 const files=Array.from({length:count},(_,index)=>({id:String(index),accountId:'benchmark',sourceId:'source',mediaKind:'movie',displayName:`示例剧${Math.floor(index/100)}.S01E${String(index%100+1).padStart(2,'0')}.mkv`,cloudPath:'/benchmark/',size:1}));
 const samples=[];let works;
 for(let repeat=0;repeat<5;repeat++){const start=performance.now();works=buildMovieWorks(files);samples.push(performance.now()-start);}
 samples.sort((a,b)=>a-b);
 console.log(JSON.stringify({files:count,works:works.length,medianMs:Number(samples[2].toFixed(2)),minMs:Number(samples[0].toFixed(2)),maxMs:Number(samples[4].toFixed(2))}));
}
