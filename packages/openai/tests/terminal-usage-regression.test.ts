import {test, expect} from 'vitest';
import {createOpenAI} from '../src/index.js';
const item=(status: string, args='{"value":1}')=>({type:'response.output_item.done', output_index:0,item:{type:'function_call',id:'item',call_id:'call',name:'fixture',arguments:args,status}});
const terminal=(status: string, usage: unknown={input_tokens:12,output_tokens:8})=>({type:`response.${status}`,response:{id:'response',status,usage,output:[]}});
async function run(events: unknown[]) {
 const model=createOpenAI({apiKey:'fixture',fetch:(async()=>new Response(events.map((e:any)=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}})) as unknown as typeof fetch})('gpt-5.6-luna');
 const emitted: any[]=[]; let error:any;
 try {for await(const event of await model.stream!({messages:[{role:'user',parts:[{type:'text',text:'fixture'}]}],providerOptions:{apiMode:'responses'}})) emitted.push(event);}catch(e){error=e;}
 return {emitted,error};
}
for(const status of ['incomplete','failed']) test(`rejects ${status} call with exact terminal accounting`,async()=>{
 const result=await run([item(status),terminal(status)]);
 expect(result.error.usage).toEqual({inputTokens:12,outputTokens:8});
 expect(result.emitted).toEqual([]);
 expect(result.error.effectsPossible).toBe(false);
 expect(JSON.stringify(result.error)).not.toContain('"value"');
});
test('rejects a deferred error even if terminal claims completion',async()=>{
 const r=await run([item('incomplete'),item('completed'),terminal('completed')]);
 expect(r.error.reason).toBe('incomplete_arguments'); expect(r.emitted).toEqual([]);
});
test('missing terminal does not invent usage',async()=>{
 const r=await run([item('incomplete')]); expect(r.error).toBeDefined(); expect(r.error.usage).toBeUndefined(); expect(r.emitted).toEqual([]);
});
for(const usage of [undefined,{input_tokens:-1,output_tokens:8},{input_tokens:12.5,output_tokens:8},{input_tokens:12,output_tokens:'8'}]) test('invalid terminal accounting stays unknown',async()=>{
 const r=await run([item('incomplete'),{type:'response.incomplete',response:{status:'incomplete',usage}}]); expect(r.error.usage).toBeUndefined(); expect(r.emitted).toEqual([]);
});
test('valid completed call is emitted once with usage',async()=>{
 const r=await run([item('completed'),terminal('completed')]); expect(r.error).toBeUndefined();
 expect(r.emitted.filter(e=>e.type==='tool-call')).toHaveLength(1); expect(r.emitted.find(e=>e.type==='finish').usage.inputTokens).toBe(12);
});
test('invalid JSON on completed terminal has usage and no executable call',async()=>{
 const r=await run([item('completed','{"value":'),terminal('completed')]); expect(r.error.reason).toBe('invalid_json'); expect(r.error.usage).toEqual({inputTokens:12,outputTokens:8}); expect(r.emitted).toEqual([]);
});

test('preserves optional numeric accounting without arbitrary payloads',async()=>{
 const r=await run([item('incomplete'),terminal('incomplete',{input_tokens:12,output_tokens:8,total_tokens:20,input_tokens_details:{cached_tokens:4},output_tokens_details:{reasoning_tokens:2},secret:'must-not-copy'})]);
 expect(r.error.usage).toEqual({inputTokens:12,outputTokens:8,totalTokens:20,cachedInputTokens:4,reasoningTokens:2});
 expect(JSON.stringify(r.error)).not.toContain('must-not-copy');
});
