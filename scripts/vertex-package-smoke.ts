import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Run after bun run build. All model requests in the installed consumer are mocked.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "zhivex-vertex-consumer-"));
const packs = join(temporary, "packs");
const consumer = join(temporary, "consumer");
mkdirSync(packs); mkdirSync(consumer);
const versioned = process.argv.includes("--versioned");
let sourceRoot = root;
if (versioned) {
  sourceRoot = join(temporary, "versioned");
  mkdirSync(sourceRoot);
  cpSync(join(root, "package.json"), join(sourceRoot, "package.json"));
  cpSync(join(root, "bun.lock"), join(sourceRoot, "bun.lock"));
  cpSync(join(root, ".changeset"), join(sourceRoot, ".changeset"), { recursive: true });
  for (const name of readdirSync(join(root, "packages"))) {
    const directory = join(sourceRoot, "packages", name);
    mkdirSync(directory, { recursive: true });
    cpSync(join(root, "packages", name, "package.json"), join(directory, "package.json"));
  }
  symlinkSync(join(root, "node_modules"), join(sourceRoot, "node_modules"));
  // Version only a disposable manifest cohort. Never change the working release state.
  execFileSync("git", ["init", "-q"], { cwd: sourceRoot });
  execFileSync("bun", [join(root, "node_modules/@changesets/cli/bin.js"), "version"], { cwd: sourceRoot, stdio: "pipe" });
  for (const name of ["core", "sdk", "anthropic", "openai", "vertex"]) {
    cpSync(join(root, "packages", name, "dist"), join(sourceRoot, "packages", name, "dist"), { recursive: true });
    cpSync(join(root, "packages", name, "README.md"), join(sourceRoot, "packages", name, "README.md"));
  }
  const oldCore = JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8")).version;
  for (const name of ["vertex", "sdk"]) {
    const manifest = JSON.parse(readFileSync(join(sourceRoot, "packages", name, "package.json"), "utf8"));
    if (Bun.semver.satisfies(oldCore, manifest.dependencies["@zhivex-ai/core"])) throw new Error(`${name} still permits pre-feature core ${oldCore} after Changesets versioning.`);
  }
  const oldAnthropic = JSON.parse(readFileSync(join(root, "packages/anthropic/package.json"), "utf8")).version;
  const vertexManifest = JSON.parse(readFileSync(join(sourceRoot, "packages/vertex/package.json"), "utf8"));
  if (Bun.semver.satisfies(oldAnthropic, vertexManifest.dependencies["@zhivex-ai/anthropic"])) throw new Error("Versioned Vertex still permits Anthropic without browser toolset replay support.");
}
const dependencies: Record<string, string> = {};
const packages = new Map<string, { manifest: any; tarball: string }>();
for (const name of ["core", "sdk", "anthropic", "openai", "vertex"]) {
  const directory = join(sourceRoot, "packages", name);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const tarball = join(packs, `${name}.tgz`);
  execFileSync("bun", ["pm", "pack", "--filename", tarball, "--ignore-scripts", "--quiet"], { cwd: directory, stdio: "pipe" });
  dependencies[manifest.name] = versioned ? manifest.version : `file:${tarball}`;
  packages.set(manifest.name, { manifest, tarball });
}
// Pin the unreleased cohort: Bun otherwise resolves registry copies for transitive ranges.
// --versioned additionally checks Changesets dependency minima and installs without overrides.
writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "vertex-installed-consumer", private: true, type: "module", dependencies,
  devDependencies: { "@types/node": JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies["@types/node"] },
  ...(!versioned ? { overrides: dependencies } : {}) }));
// An isolated registry serves the unpublished versioned artifacts without overrides.
// All non-Zhivex dependencies still resolve from the configured public registry.
const registry = versioned ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = decodeURIComponent(new URL(request.url).pathname.slice(1));
  if (path.endsWith(".tgz")) {
    const item = [...packages.values()].find((value) => path === value.manifest.name + ".tgz");
    return item ? new Response(Bun.file(item.tarball)) : new Response(null, { status: 404 });
  }
  const item = packages.get(path);
  if (!item) return new Response(null, { status: 404 });
  return Response.json({ name: path, "dist-tags": { latest: item.manifest.version }, versions: {
    [item.manifest.version]: { ...item.manifest, dist: { tarball: new URL(`/${path}.tgz`, request.url).href } }
  } });
} }) : undefined;
if (registry) writeFileSync(join(consumer, ".npmrc"), `@zhivex-ai:registry=http://127.0.0.1:${registry.port}\n`);
try {
  // Async execution lets the in-process registry respond while Bun installs.
  const install = Bun.spawn(["bun", "install", "--ignore-scripts"], { cwd: consumer,
    env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(temporary, "install-cache") }, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([install.exited, new Response(install.stdout).text(), new Response(install.stderr).text()]);
  if (exitCode !== 0) throw new Error(`Consumer install failed: ${stdout}\n${stderr}`);
} finally { registry?.stop(true); }
writeFileSync(join(consumer, "smoke.mjs"), `
import assert from 'node:assert/strict';
import { createVertex } from '@zhivex-ai/vertex';

const livePayloads=[];
let finishLive;
const liveWait = new Promise(resolve=>{finishLive=resolve;});
const liveQueue=[{setupComplete:{}},{serverContent:{interimInputTranscription:{text:'hello'}}},{serverContent:{inputTranscription:{text:'hello world'}}}];
const liveTranscriber=createVertex({projectId:'p',accessToken:'synthetic',realtimeConnectionFactory:async()=>({sendJson:async payload=>{livePayloads.push(payload);},recvJson:async()=>liveQueue.length?liveQueue.shift():liveWait,close:async()=>finishLive(undefined)})});
const liveTranscriptionSession=await liveTranscriber.realtimeModel('gemini-3.5-transcribe-live-preview').connect({inputAudioTranscription:{languageCodes:['en-US']}});
try {
 assert.deepEqual(livePayloads[0].setup.generationConfig.responseModalities,['TEXT']);
 const liveEvents=[];
 for await(const event of liveTranscriptionSession.eventStream()) {liveEvents.push(event);if(event.type==='realtime-transcript'){assert.equal(event.isFinal,true);assert.equal(event.text,'hello world');break;}}
 assert.ok(liveEvents.some(event=>event.type==='realtime-provider-data'&&event.data.type==='vertex_transcription_interim'));
 await liveTranscriptionSession.setInputMuted(true);
 assert.equal(livePayloads.at(-1).realtimeInput.audioStreamEnd,true);
} finally {await liveTranscriptionSession.close();}
const transcriptionVertex = createVertex({projectId:'p',accessToken:'synthetic',fetch:async (_url,init)=>{
 const body=JSON.parse(String(init.body));
 assert.deepEqual(body.generationConfig.audioTranscriptionConfig,{wordTimestamp:true,languageCodes:['en-US']});
 assert.equal(body.contents[0].parts.length,1);
 return Response.json({candidates:[{content:{parts:[{audioTranscription:{text:'hello ',speakerLabel:'spk_1',words:[{word:'hello',startOffset:'0.1s',endOffset:'0.5s'}]}},{audioTranscription:{text:'world'}}]}}]});
}});
const transcript = await transcriptionVertex.transcriptionModel('gemini-3.5-transcribe-preview').transcribe({audio:{data:'AQID',mediaType:'audio/wav'},language:'en-US',providerOptions:{audioTranscriptionConfig:{wordTimestamp:true}}});
assert.equal(transcript.text,'hello world');
assert.equal(transcript.transcriptions[0].words[0].startOffset,'0.1s');

import { embed, generateText, defaultModelCatalog, hostedTool, updateContextCache } from '@zhivex-ai/sdk';
const requests = [];
const endpointVertex = createVertex({ projectId:'p',location:'us-central1',accessToken:'synthetic',fetch:async (url,init) => {
  if (String(url).endsWith('/endpoints/e1:directPredict')) {
    assert.deepEqual(JSON.parse(init.body),{inputs:[{dtype:'INT64',int64Val:['9223372036854775807']}]});
    return Response.json({outputs:[{dtype:'INT64',int64Val:['9223372036854775807']}]});
  }
  if (String(url).endsWith('/endpoints/e1:explain')) {
    assert.deepEqual(JSON.parse(init.body),{instances:[{age:42}],deployedModelId:'d1'});
    return Response.json({explanations:[{attributions:[{featureAttributions:{age:0.8}}]}],predictions:[0.9],deployedModelId:'d1'});
  }
  if (String(url).endsWith('/endpoints/e1:directRawPredict')) {
    assert.deepEqual(JSON.parse(init.body),{methodName:'/test.Service/Predict',input:'AP8='});
    return Response.json({output:'gAA='});
  }
  assert.ok(String(url).endsWith('/endpoints/e1:rawPredict') || String(url).endsWith('/endpoints/e1:streamRawPredict'));
  assert.deepEqual([...new Uint8Array(init.body)],[0,255]);
  return new Response(new Uint8Array([128,0]),{headers:{'content-type':'application/octet-stream','x-vertex-ai-deployed-model-id':'d1'}});
} });
const httpPrediction = await endpointVertex.endpoints.rawPredict({endpoint:'endpoints/e1',body:new Uint8Array([0,255]),contentType:'application/octet-stream'});
assert.deepEqual([...httpPrediction.body],[128,0]);
assert.equal(httpPrediction.deployedModelId,'d1');
const endpointEvents = [];
for await (const event of endpointVertex.endpoints.streamRawPredict({endpoint:'endpoints/e1',body:new Uint8Array([0,255]),contentType:'application/octet-stream'})) endpointEvents.push(event);
assert.equal(endpointEvents[0].deployedModelId,'d1');
assert.deepEqual([...endpointEvents[1].data],[128,0]);
const directPrediction = await endpointVertex.endpoints.directRawPredict({endpoint:'endpoints/e1',methodName:'/test.Service/Predict',input:new Uint8Array([0,255])});
assert.deepEqual([...directPrediction.output],[128,0]);
const explanation = await endpointVertex.endpoints.explain({endpoint:'endpoints/e1',instances:[{age:42}],deployedModelId:'d1'});
assert.equal(explanation.explanations[0].attributions[0].featureAttributions.age,0.8);
const tensors = await endpointVertex.endpoints.directPredict({endpoint:'endpoints/e1',inputs:[{dtype:'INT64',int64Val:['9223372036854775807']}]});
assert.equal(tensors.outputs[0].int64Val[0],'9223372036854775807');
const vertex = createVertex({ projectId: 'p', location: 'global', accessToken: 'synthetic', fetch: async (url, init) => {
  requests.push({ url: String(url), body: JSON.parse(init.body ?? '{}') });
  if (String(url).includes('/virtual-try-on-001:predict')) return Response.json({predictions:[{bytesBase64Encoded:'AQI=',mimeType:'image/png'}]});
  if (String(url).includes('/imagen-4.0-generate-001:predict')) return Response.json({predictions:[{bytesBase64Encoded:'AQI=',mimeType:'image/jpeg'}]});
  if (String(url).endsWith('/responses')) return Response.json({ id:'r1', status:'completed', output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'installed-responses'}]}] });
  if (String(url).endsWith(':countTokens')) return Response.json({ totalTokens: 12, totalBillableCharacters: 24 });
  if (init.method === 'PATCH' && String(url).includes('/cachedContents/')) {
    assert.equal(new URL(String(url)).searchParams.get('updateMask'), 'ttl');
    assert.deepEqual(JSON.parse(init.body), { ttl: '3600s' });
    return Response.json({ name: 'projects/p/locations/global/cachedContents/one', expireTime: '2026-09-20T12:00:00Z' });
  }
  if (String(url).includes('count-tokens:rawPredict')) return Response.json({ input_tokens: 14 });
  if (String(url).endsWith('/embeddings')) return Response.json({ data: [{ index:0, embedding:[3,4] }] });
  if (String(url).includes('multimodalembedding@001:predict')) return Response.json({ predictions: [{ textEmbedding: Array(1408).fill(0.5), videoEmbeddings: [{startOffsetSec:0,endOffsetSec:4,embedding:Array(1408).fill(0.5)}] }] });
  if (String(url).includes(':embedContent')) return Response.json({ embedding: { values: Array(768).fill(0.5) } });
  if (String(url).includes('/interactions')) return Response.json({ id: 'i1', status: 'completed', outputs: [{type:'audio', mime_type:'audio/mpeg', data:'AQI='}] });
  if (String(url).includes('mistral-ocr')) return Response.json({ pages: [{ index: 0, markdown: '# Installed' }] });
  if (requests.at(-1).body.model === 'minimaxai/minimax-m2-maas') return Response.json({ choices: [{ message: { content: '<think>synthetic</think>installed-ok' }, finish_reason: 'stop' }] });
  return Response.json({ choices: [{ message: { content: 'installed-ok' }, finish_reason: 'stop' }] });
} });
await assert.rejects(vertex.batches.create({ modelId:'claude-sonnet-4-6',fileName:'gs://test/input.jsonl',providerOptions:{outputConfig:{predictionsFormat:'jsonl',gcsDestination:{outputUriPrefix:'gs://test/out/'}}} }), /regional/);
assert.equal(requests.length,0);
const tryOn = await vertex.virtualTryOn.generate({personImage:{data:new Uint8Array([1,2]),mediaType:'image/png'},productImage:{uri:'gs://test/shirt.jpg',mediaType:'image/jpeg'}});
assert.deepEqual([...tryOn.images[0].data],[1,2]);
assert.equal(requests.at(-1).body.instances[0].productImages[0].image.gcsUri,'gs://test/shirt.jpg');
assert.ok(defaultModelCatalog.find('vertex','virtual-try-on-001'));
const imagen = await vertex.imageGenerationModel('imagen-4.0-generate-001').generateImage({prompt:'test',count:1,outputMimeType:'image/jpeg',providerOptions:{outputOptions:{compressionQuality:80}}});
assert.equal(imagen.images[0].mediaType,'image/jpeg');
assert.deepEqual(requests.at(-1).body.parameters,{sampleCount:1,outputOptions:{compressionQuality:80,mimeType:'image/jpeg'}});
assert.equal((await generateText({ model: vertex.responsesModel('xai/grok-4.20-reasoning'), prompt:'test' })).text,'installed-responses');
assert.equal(requests.at(-1).body.store,false);
assert.equal((await vertex.gemini.countTokens({ modelId:'gemini-2.5-flash',messages:[{role:'user',parts:[{type:'text',text:'hello'}]}] })).inputTokens,12);
assert.equal((await updateContextCache({ provider:vertex,name:'cachedContents/one',ttl:'3600s' })).expireTime,'2026-09-20T12:00:00Z');
assert.equal((await vertex.claude.countTokens({ modelId:'claude-sonnet-4-6', messages:[{role:'user',content:'hello'}] })).inputTokens, 14);
await vertex('claude-opus-5').generate({ messages:[{role:'user',parts:[{type:'text',text:'browse'}]}], tools:{browser:hostedTool({provider:'vertex',type:'browser_toolset_20260801',name:'browser'})} });
assert.deepEqual(requests.at(-1).body.tools, [{type:'browser_toolset_20260801'}]);
assert.equal((await generateText({ model: vertex('moonshotai/kimi-k2-thinking-maas'), prompt: 'test' })).text, 'installed-ok');
assert.equal((await generateText({ model: vertex('minimaxai/minimax-m2-maas'), prompt: 'test' })).text, 'installed-ok');
assert.deepEqual((await embed({ model: vertex.embeddingModel('gemini-embedding-2'), value: 'test', providerOptions: { outputDimensionality: 768 } })).embeddings, [Array(768).fill(0.5)]);
assert.equal(requests.at(-1).body.embedContentConfig.outputDimensionality, 768);
const legacy = await vertex.multimodalEmbeddings.embed({ text:'road',video:{uri:'gs://sample/road.mp4',mediaType:'video/mp4'},videoSegmentConfig:{startOffsetSec:0,endOffsetSec:4,intervalSec:4} });
assert.equal(legacy.textEmbedding.length,1408);
assert.deepEqual(legacy.videoEmbeddings.map(v => [v.startOffsetSec,v.endOffsetSec,v.embedding.length]),[[0,4,1408]]);
assert.ok(defaultModelCatalog.find('vertex','multimodalembedding@001'));
assert.equal((await vertex.ocr.process({ modelId: 'mistral-ocr-2505', document: {data: new Uint8Array([1]), mediaType:'application/pdf'} })).text, '# Installed');
assert.equal((await vertex.ocr.process({ modelId:'deepseek-ai/deepseek-ocr-maas', document:{data:new Uint8Array([1]),mediaType:'image/png'}, prompt:'Free OCR' })).text, 'installed-ok');
assert.deepEqual((await embed({ model: vertex.embeddingModel('intfloat/multilingual-e5-small-maas'), value:'query: test' })).embeddings, [[3,4]]);
assert.equal((await vertex.fim.generate({ modelId: 'codestral-2', prompt: 'function f() {' })).text, 'installed-ok');
assert.deepEqual([...(await vertex.musicGenerationModel('lyria-3-clip-preview').generateMusic({ prompt:'test' })).audio[0].data], [1,2]);
assert.equal(defaultModelCatalog.find('vertex', 'deepseek-ai/deepseek-v3.2-maas').lifecycle.retiredAt, '2026-10-21');
const liveServer = Bun.serve({ hostname: '127.0.0.1', port: 0,
  fetch(request, server) {
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic');
    if (server.upgrade(request)) return;
    return new Response('Upgrade required', { status: 400 });
  },
  websocket: { message(socket, data) {
    const payload = JSON.parse(String(data));
    if (payload.setup) {
      assert.equal(payload.setup.model, 'projects/p/locations/us-central1/publishers/google/models/gemini-live-2.5-flash-native-audio');
      socket.send(JSON.stringify({ setupComplete: {} }));
    }
  } }
});
try {
  const localVertex = createVertex({ projectId: 'p', location: 'us-central1', accessToken: 'synthetic', allowUnsafeEndpoints: true, realtimeURL: 'ws://127.0.0.1:' + liveServer.port });
  const session = await localVertex.realtimeModel('gemini-live-2.5-flash-native-audio').connect({}, { timeoutMs: 2000 });
  await session.close();
} finally { liveServer.stop(true); }
console.log('Vertex installed-consumer smoke passed: chat, Responses, embeddings, OCR, FIM, Lyria, Virtual Try-On, lifecycle and default authenticated Live transport.');
`);
writeFileSync(join(consumer, "types.ts"), `
import { createVertex, type VertexClaudeOptions, type VertexVirtualTryOnInput, type VertexVirtualTryOnResult, type VertexEndpointRawPredictInput, type VertexEndpointRawPredictResult, type VertexEndpointStreamEvent, type VertexEndpointDirectRawPredictInput, type VertexEndpointDirectRawPredictResult, type VertexEndpointExplainResult } from '@zhivex-ai/vertex';
import { embed, type DocumentExtractionInput } from '@zhivex-ai/sdk';
const vertex = createVertex({ projectId: 'p', accessToken: 'synthetic' });
const input: DocumentExtractionInput = { modelId: 'deepseek-ai/deepseek-ocr-maas', document: { uri:'https://example.com/a.png', mediaType:'image/png' }, prompt:'Free OCR' };
void vertex.ocr.process(input);
const tryOnInput: VertexVirtualTryOnInput = {personImage:{uri:'gs://test/p.png',mediaType:'image/png'},productImage:{uri:'gs://test/s.jpg',mediaType:'image/jpeg'}};
const tryOnOutput: Promise<VertexVirtualTryOnResult> = vertex.virtualTryOn.generate(tryOnInput);
const endpointInput: VertexEndpointRawPredictInput = {endpoint:'endpoints/e1',body:new Uint8Array([0]),contentType:'application/octet-stream'};
const endpointOutput: Promise<VertexEndpointRawPredictResult> = vertex.endpoints.rawPredict(endpointInput);
const endpointStream: AsyncIterable<VertexEndpointStreamEvent> = vertex.endpoints.streamRawPredict(endpointInput);
const directInput: VertexEndpointDirectRawPredictInput = {endpoint:'endpoints/e1',methodName:'/test.Service/Predict',input:new Uint8Array()};
const directOutput: Promise<VertexEndpointDirectRawPredictResult> = vertex.endpoints.directRawPredict(directInput);
const explanation: Promise<VertexEndpointExplainResult> = vertex.endpoints.explain({endpoint:'endpoints/e1',instances:[{age:42}]});
const tensor: import('@zhivex-ai/vertex').VertexTensor = {dtype:'INT64',shape:['1'],int64Val:['9223372036854775807']};
const tensorOutput: Promise<import('@zhivex-ai/vertex').VertexEndpointDirectPredictResult> = vertex.endpoints.directPredict({endpoint:'endpoints/e1',inputs:[tensor]});
const serverInput: import('@zhivex-ai/vertex').VertexGrpcServerInput = {endpoint:'endpoints/e1',inputs:[tensor]};
const serverOutput: AsyncIterable<import('@zhivex-ai/vertex').VertexGrpcTensorOutput> = vertex.endpoints.serverStreamingPredict(serverInput);
const transcriptionOptions: import('@zhivex-ai/vertex').VertexTranscriptionOptions = {audioTranscriptionConfig:{languageCodes:['en-US'],wordTimestamp:true}};
const transcriptionResult = vertex.transcriptionModel('gemini-3.5-transcribe-preview').transcribe({audio:{data:'AQID',mediaType:'audio/wav'},providerOptions:transcriptionOptions});
void transcriptionResult.then(result => result.transcriptions[0]?.words?.[0]?.startOffset);
const grpcInput: import('@zhivex-ai/vertex').VertexGrpcRawInput = {endpoint:'endpoints/e1',methodName:'/test.Service/Predict',inputs:[new Uint8Array()]};
const streamingRaw: AsyncIterable<Uint8Array> = vertex.endpoints.streamingRawPredict(grpcInput);
const grpcRaw: AsyncIterable<Uint8Array> = vertex.endpoints.streamDirectRawPredict(grpcInput);
const grpcTensorInput: import('@zhivex-ai/vertex').VertexGrpcTensorInput = {endpoint:'endpoints/e1',inputs:[{inputs:[tensor]}]};
const grpcTensor: AsyncIterable<import('@zhivex-ai/vertex').VertexGrpcTensorOutput> = vertex.endpoints.streamDirectPredict(grpcTensorInput);
const streamingTensor: AsyncIterable<import('@zhivex-ai/vertex').VertexGrpcTensorOutput> = vertex.endpoints.streamingPredict(grpcTensorInput);
void tryOnOutput.then(result => result.filtered[0]?.reason);
void vertex.interactions.list({ pageSize: 5 });
void vertex.interactions.resume({ id:'one', lastEventId:'cursor', previousEvents:[{event_type:'step.start',index:0,step:{type:'function_call',id:'call',name:'lookup'},event_id:'cursor'}] });
void vertex.claude.countTokens({ modelId:'claude-sonnet-4-6', messages:[{role:'user',content:'hello'}] });
void vertex.fim.generate({ modelId:'codestral-2', prompt:'prefix', suffix:'suffix' });
void embed({ model:vertex.embeddingModel('gemini-embedding-2'), value:'text', providerOptions:{ outputDimensionality:768 } });
void vertex.multimodalEmbeddings.embed({ video:{uri:'gs://sample/road.mp4',mediaType:'video/mp4'},videoSegmentConfig:{intervalSec:4} }).then(result => result.videoEmbeddings?.[0]?.startOffsetSec);
void vertex.gemini.countTokens({ modelId:'gemini-2.5-flash',messages:[] }).then(result => result.inputTokens);
void vertex.caches.update({ name:'cachedContents/one', ttl:'3600s' });
// @ts-expect-error cache expiry alternatives are mutually exclusive
void vertex.caches.update({ name:'cachedContents/one', ttl:'3600s', expireTime:'2026-09-20T12:00:00Z' });
const options: VertexClaudeOptions = { sessionId: 'cache-session', cache_control: { type:'ephemeral', ttl:'1h' } };
void vertex('claude-sonnet-4-6').generate({ messages:[], providerOptions:options });
`);
execFileSync("bun", [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "types.ts"], { cwd: consumer, stdio: "inherit" });
execFileSync("bun", ["run", "smoke.mjs"], { cwd: consumer, stdio: "inherit" });
const generated = join(consumer, "generated-vertex-agent");
const cli = join(consumer, "node_modules/.bin/zhivex-ai");
const scaffold = JSON.parse(execFileSync("bun", [cli, "init", "agent", "--dir", generated, "--provider", "vertex", "--model", "openai/gpt-oss-120b-maas"], { cwd: consumer, encoding: "utf8" }));
if (!scaffold.ok || scaffold.provider !== "vertex" || scaffold.model !== "openai/gpt-oss-120b-maas") throw new Error("Installed CLI lost the Vertex partner selector.");
const generatedSource = readFileSync(join(generated, "src/agent.ts"), "utf8");
if (!generatedSource.includes('from "@zhivex-ai/vertex"') || !generatedSource.includes("projectId: process.env.GOOGLE_CLOUD_PROJECT")) throw new Error("Installed CLI generated incorrect Vertex configuration.");
const diagnosis = JSON.parse(execFileSync("bun", [cli, "doctor", "--dir", generated, "--provider", "vertex"], { cwd: consumer, encoding: "utf8" }));
if (!diagnosis.checks.some((check: { name: string; status: string }) => check.name === "vertex-env" && check.status === "warn")) throw new Error("Installed CLI incorrectly certified Google credentials.");
console.log("Vertex installed CLI smoke passed: partner scaffold and unverified-credentials diagnosis.");
console.log(`Installed consumer: ${consumer}`);
