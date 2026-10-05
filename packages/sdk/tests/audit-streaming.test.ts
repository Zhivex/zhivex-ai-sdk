import { expect, it } from "vitest";
import { streamObject, streamText, toTextStreamResponse, type LanguageModel, type StreamEvent } from "../src/index.js";
import { z } from "zod";
const capabilities:LanguageModel["capabilities"]={streaming:true,tools:false,structuredOutput:true,jsonMode:true,toolChoice:false,parallelToolCalls:false,vision:false,files:false,audioInput:false,audioOutput:false,embeddings:false,reasoning:false,webSearch:false};
it("the public SDK forwards HTTP cancellation to model execution",async()=>{
 let signal:AbortSignal|undefined;
 const model:LanguageModel={provider:"fixture",modelId:"sdk",capabilities,generate:async()=>({text:""}),async stream(input){signal=input.abortSignal;return(async function*(){yield {type:"text-delta",textDelta:"first"} as StreamEvent;await new Promise<void>((_,reject)=>{if(signal!.aborted)reject(signal!.reason);else signal!.addEventListener("abort",()=>reject(signal!.reason),{once:true});});})();}};
 const result=streamText({model,prompt:"test"});const reader=toTextStreamResponse(result).body!.getReader();await reader.read();await reader.cancel();expect(signal?.aborted).toBe(true);await expect(result.collect()).rejects.toMatchObject({name:"AbortError"});
});
it("the public SDK agrees on completed and collected structured values",async()=>{
 const model:LanguageModel={provider:"fixture",modelId:"sdk",capabilities,generate:async()=>({text:""}),async stream(){return(async function*(){yield {type:"text-delta",textDelta:'{"value":4'} as StreamEvent;yield {type:"text-delta",textDelta:'2}'} as StreamEvent;yield {type:"finish",finishReason:"stop"} as StreamEvent;})();}};
 const result=streamObject({model,prompt:"test",schema:z.object({value:z.number()})});const completed=[];for await(const event of result.eventStream)if(event.type==="object-complete")completed.push(event.object);expect(completed).toEqual([(await result.collect()).object]);expect(completed).toEqual([{value:42}]);expect(result.cancel).toBeTypeOf("function");
});
