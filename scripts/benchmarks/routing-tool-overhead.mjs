import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createGateway, createGatewayMetrics, createGatewayCircuitBreaker } from '../../packages/gateway/dist/index.js';
import { createAgent, runAgent, tool } from '../../packages/core/dist/index.js';
import { createMockLanguageModel } from '../../packages/core/dist/testing.js';
import { z } from 'zod';
import assert from 'node:assert/strict';
const response={text:'correct',messages:[{role:'assistant',parts:[{type:'text',text:'correct'}]}],finishReason:'stop'};
const rows=[];
for(const variant of ['legacy','metrics','circuit','adaptive','serial-tools','independent-tools']){
 const trials=[];
 for(let trial=0;trial<6;trial++){
  const start=performance.now(),cpuStart=process.cpuUsage();
  let correct=0;
  if(variant.endsWith('tools')){
   let effects=0;
   const model=createMockLanguageModel({responses:[{messages:[{role:'assistant',parts:['a','b'].map(name=>({type:'tool-call',toolCall:{id:name,name,input:{}}}))}],finishReason:'tool-calls'},response]});
   const read=name=>tool({name,independent:true,schema:z.object({}),execute:async()=>{await new Promise(r=>setTimeout(r,5));effects++;return 'fixture';}});
   const agent=createAgent({model,maxSteps:2,tools:{a:read('a'),b:read('b')},subagents:[{name:'child',agent:createAgent({model:createMockLanguageModel()})}],toolExecution:{parallel:true,independentOnly:variant==='independent-tools',maxConcurrency:2}});
   assert.equal((await runAgent(agent,{prompt:'fixture'})).outputText,'correct');assert.equal(effects,2);correct=1;
  }else{
   const gateway=createGateway({adapters:{gemini:{name:'fixture',languageModel:()=>createMockLanguageModel({responses:[response]})}},...(variant==='metrics'||variant==='adaptive'?{metrics:createGatewayMetrics()}:{}),...(variant==='circuit'?{circuitBreaker:createGatewayCircuitBreaker()}:{}),...(variant==='adaptive'?{adaptiveRouting:{version:'fixture-1',weights:{latency:1,cost:0,quality:0,load:1,errorRate:1},latencyScaleMs:100,costScale:1,coldStart:'allow',unknownCost:'reject',missingQuality:'reject'}}:{})});
   for(let i=0;i<100;i++){assert.equal((await gateway.generate({primary:{provider:'gemini',modelId:'fixture'},messages:[{role:'user',content:'fixture'}]})).text,'correct');correct++;}
  }
  const cpu=process.cpuUsage(cpuStart);if(trial)trials.push({wallMs:performance.now()-start,cpuMs:(cpu.user+cpu.system)/1000,correctTasks:correct,rssAfter:process.memoryUsage().rss});
 }
 const times=trials.map(x=>x.wallMs).sort((a,b)=>a-b);rows.push({variant,trials,p50Ms:times[2],p95Ms:times[4]});
}
const hashes={};for(const name of ['core/dist/agent.js','core/dist/generate-text.js','gateway/dist/index.js'])hashes[name]=createHash('sha256').update(await readFile(new URL('../../packages/'+name,import.meta.url))).digest('hex');
await writeFile(process.argv[2],JSON.stringify({schemaVersion:1,mode:'offline',runtime:process.version,hashes,limitations:['Sequential local fixture batches; timings include harness work and host noise','Gateway batches contain 100 tasks; tool batches contain one task with two synthetic 5ms tools','No live providers or competitive performance claim'],rows},null,2)+'\n');
console.log(JSON.stringify(rows.map(({variant,p50Ms,p95Ms})=>({variant,p50Ms,p95Ms}))));
