import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { createAgent, createInMemoryAgentRunStore, runAgent, tool } from '../../packages/core/dist/index.js';
import { createMockLanguageModel } from '../../packages/core/dist/testing.js';
const rows=[];
for (const steps of [1,10,100]) {
 const trials=[];
 for(let repeat=0;repeat<4;repeat++) {
  let calls=0,effects=0,serializations=0,bytes=0,writes=0;
  const model=createMockLanguageModel();
  model.generate=async()=> ++calls < steps ? {messages:[{role:'assistant',parts:[{type:'tool-call',toolCall:{id:'call-'+calls,name:'effect',input:{}}}]}],finishReason:'tool-calls'} : {messages:[{role:'assistant',parts:[{type:'text',text:'done'}]}],text:'done',finishReason:'stop'};
  const store=createInMemoryAgentRunStore();const save=store.save.bind(store);
  store.save=async(state,options)=>{writes++;bytes+=Buffer.byteLength(JSON.stringify(state));return save(state,options);};
  const agent=createAgent({id:'serialization',model,store,maxSteps:steps,policy:{maxStateBytes:64*1024*1024},tools:{effect:tool({name:'effect',schema:z.object({}),execute:()=>{effects++;return 'x'.repeat(1024);}})}});
  const stringify=JSON.stringify;JSON.stringify=function(value,...args){if(value?.schemaVersion===1 && value?.runId && Array.isArray(value.messages)) serializations++;return stringify.call(JSON,value,...args);};
  const start=performance.now(),cpuStart=process.cpuUsage(),rssBefore=process.memoryUsage().rss;
  try{const output=await runAgent(agent,{prompt:'fixture'});assert.equal(output.status,'completed');assert.equal(effects,steps-1);assert.equal(calls,steps);}
  finally{JSON.stringify=stringify;}
  const cpu=process.cpuUsage(cpuStart);
  if(repeat)trials.push({wallMs:performance.now()-start,cpuMs:(cpu.user+cpu.system)/1000,rssBefore,rssAfter:process.memoryUsage().rss,serializations,writes,logicalCheckpointBytes:bytes});
 }
 rows.push({steps,payloadBytes:1024,trials});
}
const agentHash=createHash('sha256').update(await readFile(new URL('../../packages/core/dist/agent.js',import.meta.url))).digest('hex');
await writeFile(process.argv[2],JSON.stringify({schemaVersion:1,mode:'offline-instrumented',runtime:process.version,agentHash,limitations:['JSON.stringify instrumentation adds overhead; compare work counts, not uninstrumented production speed','In-memory store, compact JSON logical bytes, process RSS endpoints'],rows},null,2)+'\n');
console.log(JSON.stringify(rows.map(x=>({steps:x.steps,serializations:x.trials[0].serializations,writes:x.trials[0].writes}))));
