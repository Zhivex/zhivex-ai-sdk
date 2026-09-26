import assert from 'node:assert/strict';
import { createQwen } from '@zhivex-ai/qwen';
import { ProviderToolCallError, createTextMessage } from '@zhivex-ai/core';
const input = { messages: [createTextMessage('user', 'fixture')], providerOptions: { apiMode: 'responses' } };
const usage = { input_tokens: 2, output_tokens: 1, total_tokens: 3 };
let checked = 0;
for (const mode of ['generate','stream']) {
  for (const args of ['{"value":1}', '{"PRIVATE_SENTINEL":', 'null', '[]']) {
    const item = { type:'function_call', id:'fc_1', call_id:'call_1', name:'fixture', arguments:args };
    const events = [{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{status:'completed',usage}}];
    const model = createQwen({apiKey:'fixture', fetch:async()=> mode==='generate'
      ? Response.json({status:'completed',output:[item],usage})
      : new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n')})('qwen3.8-flash');
    let error, result; const emitted=[];
    try {
      if(mode==='generate') result=await model.generate(input);
      else for await(const event of await model.stream(input)) emitted.push(event);
    } catch(e) { error=e; }
    if(args==='{"value":1}') {
      assert.equal(error,undefined);
      const call=mode==='generate' ? result.messages[0].parts.find(p=>p.type==='tool-call') : emitted.find(p=>p.type==='tool-call');
      assert.equal(call.toolCall.id,'call_1');
    } else {
      assert(error instanceof ProviderToolCallError);
      assert.equal(error.cause,undefined);
      assert.equal(error.usage.totalTokens,3);
      assert(!JSON.stringify(error).includes('PRIVATE_SENTINEL'));
      assert(!emitted.some(e=>e.type==='tool-call'));
    }
    checked++;
  }
}
for(const apiMode of ['responses','chat']) {
  const model=createQwen({apiKey:'fixture',fetch:async()=>new Response('data: {PRIVATE_SENTINEL\n\n')})('qwen3.8-flash');
  let error;
  try { for await(const e of await model.stream({...input,providerOptions:{apiMode,enable_thinking:false}})) {} }
  catch(e) {error=e;}
  assert.equal(error.diagnosticCode,'QWEN_SSE_EVENT_INVALID');
  assert.equal(error.cause,undefined);
  checked++;
}
console.log(JSON.stringify({source:'local packed tarballs, not registry publication',checked,passed:true}));
