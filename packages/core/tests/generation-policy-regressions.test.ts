import { expect, it, vi } from "vitest";
import { z } from "zod";
import { generateObject, streamObject, streamText, tool, type LanguageModel, type StreamEvent } from "../src/index.js";
const caps = { streaming:true, tools:true, structuredOutput:true, jsonMode:true, toolChoice:true, parallelToolCalls:false, vision:false, files:false, audioInput:false, audioOutput:false, embeddings:false, reasoning:false, webSearch:false };
const model = (overrides: Partial<LanguageModel> = {}): LanguageModel => ({ provider:"test", modelId:"test", capabilities:caps, generate:async()=>({text:'{"ok":true}',messages:[],finishReason:"stop"}), ...overrides });

it.each([false,true])("object generation preserves approval policy and toolChoice, streaming=%s", async streaming => {
  const execute = vi.fn(()=>({written:true}));
  const policy = vi.fn(()=>false);
  const choices:unknown[]=[];
  let step=0;
  const m=model({
    generate:async input=>{choices.push(input.toolChoice);return step++===0 ? {messages:[{role:"assistant",parts:[{type:"tool-call",toolCall:{id:"c1",name:"write",input:{}}}]}],finishReason:"tool-calls"} : {text:'{"ok":true}',messages:[],finishReason:"stop"};},
    stream:async input=>{choices.push(input.toolChoice);return(async function*():AsyncGenerator<StreamEvent>{
      if(step++===0){yield {type:"tool-call",toolCall:{id:"c1",name:"write",input:{}}};yield {type:"finish",finishReason:"tool-calls"};}
      else {yield {type:"text-delta",textDelta:'{"ok":true}'};yield {type:"finish",finishReason:"stop"};}
    })();}
  });
  const options={model:m,prompt:"hello",schema:z.object({ok:z.boolean()}),maxSteps:2,toolChoice:"auto" as const,toolApprovalPolicy:policy,tools:{write:tool({name:"write",schema:z.object({}),execute})}};
  const result=streaming?await streamObject(options).collect():await generateObject(options);
  expect(result.object).toEqual({ok:true});
  expect(policy).toHaveBeenCalledTimes(1);
  expect(execute).not.toHaveBeenCalled();
  expect(choices).toEqual(["auto","auto"]);
});

it("streamText rejects partial output after a provider error event", async()=>{
  const stream=streamText({model:model({stream:async()=> (async function*():AsyncGenerator<StreamEvent>{
    yield {type:"text-delta",textDelta:"partial"};
    yield {type:"error",error:new Error("provider failed")};
  })()}),prompt:"hello"});
  await expect(stream.collect()).rejects.toThrow("provider failed");
});

it("streamText does not execute buffered tools after an error event",async()=>{
  const execute=vi.fn(()=>({written:true}));
  const stream=streamText({model:model({stream:async()=> (async function*():AsyncGenerator<StreamEvent>{
    yield {type:"tool-call",toolCall:{id:"c1",name:"write",input:{}}};
    yield {type:"error",error:new Error("provider failed")};
    yield {type:"finish",finishReason:"tool-calls"};
  })()}),prompt:"hello",maxSteps:1,tools:{write:tool({name:"write",schema:z.object({}),execute})}});
  await expect(stream.collect()).rejects.toThrow("provider failed");
  expect(execute).not.toHaveBeenCalled();

});
