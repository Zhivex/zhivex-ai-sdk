import { describe, expect, it, vi } from "vitest";
import { createAgent, createRunner, createInMemorySessionService, createWorkflow, runWorkflow, createTextMessage } from "../src/index.js";
import type { LanguageModel, ModelGenerateInput } from "../src/types.js";
const caps:LanguageModel["capabilities"]={streaming:false,tools:false,structuredOutput:false,jsonMode:false,toolChoice:false,parallelToolCalls:false,vision:false,files:false,audioInput:false,audioOutput:false,embeddings:false,reasoning:false,webSearch:false};
const runner=(generate:LanguageModel["generate"])=>createRunner({appName:"audit",agent:createAgent({model:{provider:"test",modelId:"test",capabilities:caps,generate}}),sessionService:createInMemorySessionService()});
const output=(text:string)=>({text,messages:[createTextMessage("assistant",text)],finishReason:"stop" as const});
const tick=()=>new Promise(r=>setTimeout(r,0));
describe("workflow failFast",()=>{
 it("returns on first failure, aborts siblings, and ignores uncooperative late output",async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let signal:AbortSignal|undefined;
  const slow=runner(async input=>{signal=input.abortSignal;await gate;return output("late");});
  const fast=runner(async()=>{await tick();throw new Error("first failure");});
  const workflow=createWorkflow({steps:[{id:"parallel",kind:"parallel",failFast:true,steps:[{id:"fast",runner:fast,prompt:"x"},{id:"slow",runner:slow,prompt:"x",outputKey:"slow"}]}]});
  const result=await runWorkflow(workflow,{userId:"u",sessionId:"s"});
  expect(result.status).toBe("failed");expect(signal?.aborted).toBe(true);expect(result.outputs.slow).toBeUndefined();
  const before=JSON.stringify(result);release();await tick();expect(JSON.stringify(result)).toBe(before);
 });
 it("preserves cooperative sibling cleanup and settled successful outputs",async()=>{
  let cleaned=false;const slow=runner(async input=>{await new Promise<void>((_,reject)=>{input.abortSignal!.addEventListener("abort",()=>{cleaned=true;reject(input.abortSignal!.reason);},{once:true});});return output("unreachable");});
  const fast=runner(async()=>{await tick();throw new Error("down");});
  const ok=runner(async()=>output("early success"));
  const result=await runWorkflow(createWorkflow({steps:[{id:"p",kind:"parallel",failFast:true,steps:[{id:"ok",runner:ok,prompt:"x",outputKey:"ok"},{id:"slow",runner:slow,prompt:"x"},{id:"fast",runner:fast,prompt:"x"}]}]}),{userId:"u",sessionId:"s"});
  expect(result.status).toBe("failed");expect(cleaned).toBe(true);expect(result.outputs.ok).toBe("early success");
 });
 it("continues waiting for other branches when failFast is disabled",async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let signal:AbortSignal|undefined;
  const slow=runner(async input=>{signal=input.abortSignal;await gate;return output("done");});
  const fast=runner(async()=>{throw new Error("down");});let settled=false;
  const pending=runWorkflow(createWorkflow({steps:[{id:"p",kind:"parallel",failFast:false,steps:[{id:"fast",runner:fast,prompt:"x"},{id:"slow",runner:slow,prompt:"x",outputKey:"slow"}]}]}),{userId:"u",sessionId:"s"}).then(r=>{settled=true;return r;});
  await tick();expect(settled).toBe(false);expect(signal?.aborted??false).toBe(false);release();const result=await pending;expect(result.outputs.slow).toBe("done");
 });
 it("settles branches that ignore a caller abort and does not dispatch later work",async()=>{
  const controller=new AbortController();let entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;});let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const slow=runner(async()=>{entered();await gate;return output("late");});const after=vi.fn(async()=>output("after"));
  const workflow=createWorkflow({steps:[{id:"p",kind:"parallel",failFast:true,steps:[{id:"slow",runner:slow,prompt:"x"}]},{id:"after",runner:runner(after),prompt:"x"}]});
  const pending=runWorkflow(workflow,{userId:"u",sessionId:"s",abortSignal:controller.signal});await ready;controller.abort(new Error("stop"));const result=await pending;expect(result.status).toBe("failed");expect(after).not.toHaveBeenCalled();release();
 });
});
