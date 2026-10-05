import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCachedGenerateMiddleware, createCircuitBreakerMiddleware, createInMemoryGenerateCache, wrapLanguageModel } from "../src/middleware-runtime.js";
import { streamObject } from "../src/generate-object.js";
import { streamText } from "../src/generate-text.js";
import { streamSSE, toSSEStream, toSSEResponse, toTextReadableStream, toUIMessageStreamResponse } from "../src/stream.js";
import type { LanguageModel, StreamEvent } from "../src/types.js";
const capabilities: LanguageModel["capabilities"] = { streaming:true,tools:true,structuredOutput:true,jsonMode:true,toolChoice:true,parallelToolCalls:false,vision:false,files:false,audioInput:false,audioOutput:false,embeddings:false,reasoning:false,webSearch:false };
const model = (events: () => AsyncIterable<StreamEvent>): LanguageModel => ({provider:"fixture",modelId:"audit",capabilities,generate:async()=>({text:"ok"}),stream:async()=>events()});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("audit generation regressions", () => {
  it.each(["signal", "abortSignal", "execute", "isEnabled", "onError", "inputGuardrails", "outputGuardrails"])("preserves user data named %s in cache keys", async field => {
    const generate=vi.fn(async input=>({text:JSON.stringify(input.messages)}));
    const wrapped=wrapLanguageModel({...model(async function*(){}),generate},[createCachedGenerateMiddleware({cache:createInMemoryGenerateCache()})]);
    const input=(value:string)=>({messages:[{role:"tool" as const,parts:[{type:"tool-result" as const,toolResult:{toolCallId:"c",toolName:"lookup",isError:false,output:{[field]:value}}}]}]});
    const a=await wrapped.generate(input("red"));const b=await wrapped.generate(input("green"));
    expect(a.text).not.toEqual(b.text);expect(generate).toHaveBeenCalledTimes(2);
    expect(await wrapped.generate(input("green"))).toEqual(b);expect(generate).toHaveBeenCalledTimes(2);
  });
  it("keeps provider options in cache identity and ignores only request abort control", async()=>{
    const generate=vi.fn(async()=>({text:"ok"}));
    const wrapped=wrapLanguageModel({...model(async function*(){}),generate},[createCachedGenerateMiddleware({cache:createInMemoryGenerateCache()})]);
    await wrapped.generate({messages:[],abortSignal:new AbortController().signal,providerOptions:{signal:"a"}});
    await wrapped.generate({messages:[],abortSignal:new AbortController().signal,providerOptions:{signal:"a"}});
    await wrapped.generate({messages:[],providerOptions:{signal:"b"}});
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it.each([false,true])("records error events before consumer break=%s",async stopEarly=>{
    let calls=0;const failure=new Error("provider down");const states:string[]=[];
    const wrapped=wrapLanguageModel(model(async function*(){calls++;yield {type:"error",error:failure};}),[createCircuitBreakerMiddleware({failureThreshold:1,onStateChange:s=>{states.push(s.status);}})]);
    for await(const e of await wrapped.stream!({messages:[]})){expect(e).toEqual({type:"error",error:failure});if(stopEarly)break;}
    const second=await wrapped.stream!({messages:[]});await expect(second[Symbol.asyncIterator]().next()).rejects.toThrow("Circuit breaker open");expect(calls).toBe(1);expect(states).toEqual(["open"]);
  });
  it("reopens a half-open probe on an error event without double counting",async()=>{
    const failures:number[]=[];const wrapped=wrapLanguageModel(model(async function*(){yield {type:"error",error:new Error("down")};}),[createCircuitBreakerMiddleware({failureThreshold:1,cooldownMs:0,onStateChange:s=>{if(s.status==="open")failures.push(s.failures);}})]);
    for(let i=0;i<2;i++)for await(const _ of await wrapped.stream!({messages:[]})){}
    expect(failures).toEqual([1,2]);
  });
  it("does not open the circuit for filtered error events",async()=>{
    let calls=0;const wrapped=wrapLanguageModel(model(async function*(){calls++;yield {type:"error",error:new Error("user cancelled")};}),[createCircuitBreakerMiddleware({failureThreshold:1,isFailure:()=>false})]);
    for(let i=0;i<2;i++)for await(const _ of await wrapped.stream!({messages:[]})){}
    expect(calls).toBe(2);
  });
  it("emits object-complete only for the final validated numeric value",async()=>{
    const result=streamObject({model:model(async function*(){yield {type:"text-delta",textDelta:'{"count":1'};yield {type:"text-delta",textDelta:'23}'};yield {type:"finish",finishReason:"stop"};}),prompt:"x",schema:z.object({count:z.number()})});
    const complete:unknown[]=[];const partials:unknown[]=[];
    for await(const e of result.eventStream){if(e.type==="object-complete")complete.push(e.object);if(e.type==="object-partial")partials.push(e.partialObject);}
    expect(partials).toContainEqual({count:1});expect(complete).toEqual([{count:123}]);expect((await result.collect()).object).toEqual(complete[0]);
  });
  it("never publishes object-complete when later content fails final validation",async()=>{
    const result=streamObject({model:model(async function*(){yield {type:"text-delta",textDelta:'{"count":1'};yield {type:"text-delta",textDelta:'23} trailing'};yield {type:"finish",finishReason:"stop"};}),prompt:"x",schema:z.object({count:z.number()})});
    const types:string[]=[];for await(const e of result.eventStream)types.push(e.type);
    expect(types).not.toContain("object-complete");expect(types).toContain("error");await expect(result.collect()).rejects.toThrow("valid JSON");
  });
  it("cancels an SSE response body on early exit but not on normal EOF",async()=>{
    const cancel=vi.fn();const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode("data: one\n\n"));},cancel});
    for await(const _ of streamSSE(new Response(body)))break;
    expect(cancel).toHaveBeenCalledOnce();expect(body.locked).toBe(false);
    const normalCancel=vi.fn();const closed=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode("data: two\n\n"));c.close();},cancel:normalCancel});
    const events=[];for await(const e of streamSSE(new Response(closed)))events.push(e.data);
    expect(events).toEqual(["two"]);expect(normalCancel).not.toHaveBeenCalled();
  });
  it("bounds eager SSE production to one queued chunk and returns the source on cancel",async()=>{
    let count=0;const returned=vi.fn();const source=(async function*(){try{for(let i=0;i<100;i++){count++;yield i;}}finally{returned();}})();
    const stream=toSSEStream(source);await tick();expect(count).toBe(1);
    const reader=stream.getReader();expect((await reader.read()).value).toBeInstanceOf(Uint8Array);await tick();expect(count).toBeLessThanOrEqual(2);
    await reader.cancel();await tick();expect(returned).toHaveBeenCalledOnce();
  });
  it("notifies cancellation immediately even with a pending next and late rejection",async()=>{
    let reject!:(e:Error)=>void;const pending=new Promise<IteratorResult<string>>((_,r)=>{reject=r;});const returned=vi.fn(async()=>({done:true as const,value:undefined}));const onCancel=vi.fn();
    const stream=toSSEStream({[Symbol.asyncIterator]:()=>({next:()=>pending,return:returned})},{onCancel});await tick();
    const reason=new Error("closed");await stream.cancel(reason);expect(onCancel).toHaveBeenCalledWith(reason);expect(returned).toHaveBeenCalledOnce();reject(new Error("late network failure"));await tick();
  });
  it("closes a custom source when encoding fails and keeps the original error",async()=>{
    const returned=vi.fn(async()=>({done:true as const,value:undefined}));const onCancel=vi.fn();const failure=new Error("bad event");
    const stream=toSSEStream({[Symbol.asyncIterator]:()=>({next:async()=>({done:false as const,value:"a"}),return:returned})},{event:()=>{throw failure;},onCancel});
    await expect(stream.getReader().read()).rejects.toBe(failure);expect(returned).toHaveBeenCalledOnce();expect(onCancel).toHaveBeenCalledWith(failure);
  });
  it("forwards response cancellation callbacks without leaking options into headers",async()=>{
    const onCancel=vi.fn();const response=toSSEResponse((async function*(){yield "a";yield "b";})(),{onCancel,headers:{"x-audit":"yes"}});
    await response.body!.cancel("end");expect(onCancel).toHaveBeenCalledWith("end");expect(response.headers.get("x-audit")).toBe("yes");
  });
  it("observes custom asynchronous cancellation failures and still notifies the host",async()=>{
    const result=streamText({model:model(async function*(){yield {type:"text-delta",textDelta:"ready"};yield {type:"finish",finishReason:"stop"};}),prompt:"x"});
    const onCancel=vi.fn();
    const response=toUIMessageStreamResponse({...result,cancel:async()=>{throw new Error("custom cleanup failed");}},{onCancel});
    await response.body!.cancel("disconnected");await tick();
    expect(onCancel).toHaveBeenCalledWith("disconnected");
    await result.collect();
  });
  it.each(["text","ui"])("aborts provider I/O when the %s response is cancelled",async kind=>{
    let requestSignal:AbortSignal|undefined;let released=false;
    const streaming:LanguageModel={...model(async function*(){}),async stream(input){requestSignal=input.abortSignal;return(async function*(){try{yield {type:"text-delta",textDelta:"first"} as StreamEvent;await new Promise<void>((_,reject)=>{const signal=input.abortSignal!;if(signal.aborted)reject(signal.reason);else signal.addEventListener("abort",()=>reject(signal.reason),{once:true});});}finally{released=true;}})();}};
    const result=streamText({model:streaming,prompt:"x"});
    const body=kind==="text"?toTextReadableStream(result):toUIMessageStreamResponse(result).body!;
    const reader=body.getReader();await reader.read();const reason=new Error("client disconnected");await reader.cancel(reason);
    expect(requestSignal?.aborted).toBe(true);await expect(result.collect()).rejects.toBe(reason);expect(released).toBe(true);
  });
});
