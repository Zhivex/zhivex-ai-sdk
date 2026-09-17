import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { createDeepSeek } from '@zhivex-ai/deepseek';
import { createQwen } from '@zhivex-ai/qwen';
import { createGemini } from '@zhivex-ai/gemini';
import { createAnthropic } from '@zhivex-ai/anthropic';
import { createOpenAI } from '@zhivex-ai/openai';
import { tool } from '@zhivex-ai/core';
import { z } from 'zod';
import { createLiveSmokeTransport } from './transport.js';
if (process.env.ZHIVEX_WEEKLY_LIVE !== '1')
    throw new Error('Live opt-in required');
const path = process.env.ZHIVEX_LIVE_REPORT;
const report = JSON.parse(readFileSync(path, 'utf8'));
const sanitize = value => {
    let text = String(value ?? '');
    for (const [key, secret] of Object.entries(process.env))
        if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && secret && secret.length > 5)
            text = text.split(secret).join('[REDACTED]');
    return text.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 1400);
};
const persist = () => writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
async function run(name, fn) {
    if (process.env.ZHIVEX_LIVE_CASE && !name.includes(process.env.ZHIVEX_LIVE_CASE))
        return;
    const result = { name, startedAt: new Date().toISOString(), status: 'running' };
    report.results.push(result);
    persist();
    console.log(`START ${name}`);
    try {
        Object.assign(result, await fn(), { status: 'passed' });
    }
    catch (e) {
        Object.assign(result, { status: 'failed', error: { name: e.name, status: e.status, code: e.code, message: sanitize(e.message), responseBody: e.responseBody ? sanitize(typeof e.responseBody === 'string' ? e.responseBody : JSON.stringify(e.responseBody)) : undefined, diagnostics: e.diagnostics } });
    }
    result.finishedAt = new Date().toISOString();
    persist();
    console.log(JSON.stringify(result));
}
const user = text => ({ role: 'user', parts: [{ type: 'text', text }] });
const limits = () => ({ maxTokens: 128, maxRetries: 0, abortSignal: AbortSignal.timeout(45000) });
// Synthetic 64x64 red PNG; no user media is transmitted.
const crc = b => { let c = -1; for (const x of b) {
    c ^= x;
    for (let i = 0; i < 8; i++)
        c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
} return (c ^ -1) >>> 0; };
const chunk = (t, b) => { const data = Buffer.concat([Buffer.from(t), b]); const h = Buffer.alloc(4), tail = Buffer.alloc(4); h.writeUInt32BE(b.length); tail.writeUInt32BE(crc(data)); return Buffer.concat([h, data, tail]); };
const header = Buffer.alloc(13);
header.writeUInt32BE(64);
header.writeUInt32BE(64, 4);
header[8] = 8;
header[9] = 2;
const pixels = Buffer.alloc(64 * (1 + 64 * 3));
for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++)
        pixels[y * 193 + 1 + x * 3] = 255;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
for (const id of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'])
    await run(`deepseek-vision:${id}`, async () => {
        const model = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY })(id);
        const result = await model.generate({ ...limits(), reasoning: { effort: 'none' }, messages: [{ role: 'user', parts: [{ type: 'text', text: 'What is the solid color in this image? Answer one English word.' }, { type: 'image', image: png, mediaType: 'image/png' }] }] });
        assert.match(result.text, /red/i);
        return { requestedModel: id, returnedModel: result.rawResponse?.model, text: result.text, usage: result.usage };
    });
await run('qwen-hosted:deepseek-v4.1-flash', async () => {
    const model = createQwen({ apiKey: process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY, baseURL: process.env.QWEN_BASE_URL, region: process.env.QWEN_REGION, workspaceId: process.env.QWEN_WORKSPACE_ID })('deepseek-v4.1-flash');
    const result = await model.generate({ ...limits(), messages: [user('Reply exactly READY')] });
    assert.match(result.text, /READY/);
    return { text: result.text, usage: result.usage };
});
for (const id of ['gemini-3.8-live', 'gemini-3.8-live-extended-thinking'])
    await run(`gemini-live:${id}`, async () => {
        const transport = createLiveSmokeTransport();
        const diagnostics = { frames: [], events: {} };
        const factory = async (...args) => { const connection = await transport.factory(...args); return { ...connection, async recvJson() { const frame = await connection.recvJson(); if (frame) {
                const content = frame.serverContent ?? frame.server_content;
                diagnostics.frames.push({ keys: Object.keys(frame), status: frame.interactionStatus ?? frame.interaction_status ?? content?.interactionStatus ?? content?.interaction_status, contentKeys: content ? Object.keys(content) : undefined });
            } return frame; } }; };
        let session;
        const timer = setTimeout(() => transport.terminate(), 55000);
        try {
            session = await createGemini({ apiKey: process.env.GEMINI_API_KEY, realtimeConnectionFactory: factory }).realtimeModel(id).connect({ outputAudioTranscription: {}, tools: { certification_code: tool({ name: 'certification_code', description: 'Get the word to say.', schema: z.object({}), execute: () => 'strawberry' }) }, ...(id.endsWith('thinking') ? { reasoning: { effort: 'low' } } : {}) });
            await session.sendText('Call certification_code once, then say only the word it returns.');
            let calls = 0, audioBytes = 0, text = '', idle = false, complete = false;
            for await (const event of session.eventStream()) {
                diagnostics.events[event.type] = (diagnostics.events[event.type] ?? 0) + 1;
                if (event.type === 'realtime-tool-call') {
                    assert.equal(event.toolCall.name, 'certification_code');
                    assert.equal(++calls, 1);
                    await session.sendToolResult({ toolCallId: event.toolCall.id, toolName: event.toolCall.name, output: 'strawberry' });
                }
                if (event.type === 'realtime-audio-output')
                    audioBytes += event.audio.byteLength;
                if (event.type === 'realtime-transcript' && event.role === 'assistant')
                    text += event.text;
                if (event.type === 'realtime-text-delta')
                    text += event.textDelta;
                if (event.type === 'realtime-provider-data' && event.data?.interactionStatus === 'IDLE')
                    idle = true;
                if (event.type === 'realtime-error')
                    throw new Error('Realtime provider error');
                if (event.type === 'realtime-response-complete' && calls && /strawberry/i.test(text)) {
                    complete = true;
                    break;
                }
            }
            assert.equal(calls, 1);
            assert.ok(audioBytes > 0);
            assert.match(text, /strawberry/i);
            assert.ok(complete);
            if (id.endsWith('thinking'))
                assert.ok(idle);
            return { calls, audioBytes, text, idle, complete, diagnostics };
        }
        catch (e) {
            e.diagnostics = diagnostics;
            throw e;
        }
        finally {
            clearTimeout(timer);
            transport.terminate();
            await session?.close();
        }
    });
await run('anthropic-compaction', async () => {
    const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-5');
    const marker = 'RecipeIngredient';
    const result = await model.generate({ ...limits(), maxTokens: 2048, messages: [user('I am building a recipe app. Help me name the main entities in the data model.'), { role: 'assistant', parts: [{ type: 'text', text: 'Use Recipe, Ingredient, Step, and RecipeIngredient. RecipeIngredient stores quantity and unit.' }] }], providerOptions: { compaction: { type: 'summarize' } } });
    const block = result.messages.flatMap(m => m.parts).find(p => p.type === 'provider-data' && p.data?.type === 'compaction');
    assert.ok(block?.data?.signature, JSON.stringify({ finish: result.providerFinishReason, usage: result.usage, parts: result.messages.flatMap(m => m.parts).map(p => ({ type: p.type, keys: Object.keys(p), dataKeys: p.data ? Object.keys(p.data) : undefined })), rawContentKeys: result.rawResponse?.content?.map(b => Object.keys(b)) }));
    assert.equal(result.providerFinishReason, 'compaction');
    assert.ok(result.usage?.totalTokens > 0);
    const replay = await model.generate({ ...limits(), messages: [...result.messages, user('What entity stores quantity and unit? Reply only with its name.')] });
    assert.ok(replay.text.includes(marker));
    return { signedBlock: true, replayMatched: true, usage: result.usage, replayUsage: replay.usage };
});
await run('anthropic-compaction-stream', async () => {
    const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-5');
    let signedBlock, finish, usage;
    for await (const event of await model.stream({ ...limits(), maxTokens: 2048, messages: [user('Design a recipe app with Recipe, Ingredient, and RecipeIngredient. RecipeIngredient stores quantity and unit.')], providerOptions: { compaction: { type: 'summarize' } } })) {
        if (event.type === 'provider-data' && event.data?.type === 'compaction')
            signedBlock = event.data;
        if (event.type === 'finish') {
            finish = event.providerFinishReason;
            usage = event.usage;
        }
    }
    assert.ok(signedBlock?.signature);
    assert.equal(finish, 'compaction');
    assert.ok(usage?.totalTokens > 0);
    const replay = await model.generate({ ...limits(), messages: [{ role: 'assistant', parts: [{ type: 'provider-data', provider: 'anthropic', data: signedBlock }] }, user('Which entity stores quantity and unit? Reply only with its name.')] });
    assert.match(replay.text, /RecipeIngredient/);
    return { signedBlock: true, replayMatched: true, usage, replayUsage: replay.usage };
});
await run('openai-agents-cancel', async () => {
    const requests = [];
    const api = createOpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: async (url, init) => { const response = await fetch(url, init); const entry = { path: new URL(url).pathname, method: init?.method, status: response.status, contentType: response.headers.get('content-type'), contentLength: response.headers.get('content-length') }; requests.push(entry); console.log(JSON.stringify(entry)); return response; } }).agents;
    const session = await api.createSession({ agent: { model: 'gpt-6-astra' }, environment: { type: 'none' }, input: 'Reply exactly READY.' }, { timeoutMs: 20000 });
    let sent = false, cancelRequested = false, cancelled = false;
    const eventTypes = [];
    try {
        for await (const event of api.streamEvents(session.id, { timeoutMs: 45000 })) {
            eventTypes.push(event.type);
            if (!sent && (event.type === 'agent.session.idle' || event.type === 'agent.session.turn.completed')) {
                sent = true;
                await api.sendEvents(session.id, [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Count from 1 to 1000, one number per line.' }] }] }], { timeoutMs: 15000 });
            }
            if (sent && event.type === 'agent.session.turn.in_progress' && !cancelRequested) {
                cancelRequested = true;
                await api.cancelTurn(session.id, { timeoutMs: 15000 });
            }
            if (event.type === 'agent.session.turn.cancelled' && event.turn?.subagent_id === null) {
                cancelled = true;
                break;
            }
            if (event.type === 'error' || event.type === 'agent.session.turn.failed')
                throw new Error(`Agent lifecycle failure: ${event.type}`);
        }
        assert.ok(sent && cancelRequested && cancelled);
        return { eventTypes, sessionCreated: true, messageSent: sent, cancelRequested, cancelled };
    }
    catch (e) {
        e.diagnostics = { eventTypes, requests };
        throw e;
    }
    finally {
        await api.deleteSession(session.id, { timeoutMs: 15000 });
    }
});
await run('openai-agents', async () => {
    const api = createOpenAI({ apiKey: process.env.OPENAI_API_KEY }).agents;
    let id;
    const evidence = { eventTypes: [] };
    try {
        for await (const event of api.streamSession({ agent: { model: 'gpt-6-astra' }, environment: { type: 'none' }, input: 'Reply exactly CERTIFIED.' }, { timeoutMs: 60000 })) {
            evidence.eventTypes.push(event.type);
            id ??= event.session?.id ?? event.session_id;
            
            if (event.type === 'agent.session.turn.failed')
                throw new Error('Root turn failed');
            if (event.type === 'agent.session.turn.completed' && !event.turn?.subagent_id)
                break;
        }
        assert.ok(id, 'Missing session id');
        await api.getSession(id, { timeoutMs: 15000 });
        const items = await api.listItems(id, {}, { timeoutMs: 15000 });
        assert.match(JSON.stringify(items), /CERTIFIED/);
        assert.ok(evidence.eventTypes.includes('agent.session.turn.completed'));
        return { ...evidence, sessionRetrieved: true, itemsMatched: true };
    }
    catch (e) {
        e.diagnostics = evidence;
        throw e;
    }
    finally {
        if (id)
            await api.deleteSession(id, { timeoutMs: 15000 });
    }
});
await run('anthropic-managed-agents-auto', async () => {
    const api = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY }).managedAgents;
    let agent, environment, session;
    const options = { timeout: 20000, maxRetries: 0 };
    try {
        agent = await api.agents.create({ name: 'Zhivex temporary live certification', model: 'claude-opus-5', tools: [{ type: 'agent_toolset_20260401', default_config: { permission_policy: { type: 'auto' } } }] }, options);
        environment = await api.environments.create({ name: 'Zhivex temporary live certification', config: { type: 'cloud', networking: { type: 'limited', allowed_hosts: [], allow_mcp_servers: false, allow_package_managers: false } } }, options);
        session = await api.sessions.create({ agent: agent.id, environment_id: environment.id, budget: { type: 'limit', max_list_cost: { amount: '100', currency: 'USD' } }, initial_events: [{ type: 'user.message', content: [{ type: 'text', text: "Run only this harmless command using bash: printf CERTIFIED. Then reply CERTIFIED. Do not read files or access the network." }] }] }, options);
        const types = [];
        let evaluated = false, matched = false, toolSucceeded = false, idle = false, toolUseId;
        for await (const event of await api.sessions.events.stream(session.id, {}, { timeout: 90000, maxRetries: 0, signal: AbortSignal.timeout(90000) })) {
            types.push(event.type);
            if (event.type === 'agent.tool_use' && event.evaluation?.type === 'auto' && event.evaluated_permission === 'allow') {
                evaluated = true;
                toolUseId = event.id;
            }
            if (event.type === 'agent.tool_result' && event.tool_use_id === toolUseId && !event.is_error && JSON.stringify(event.content).includes('CERTIFIED'))
                toolSucceeded = true;
            if (event.type === 'agent.message' && toolSucceeded && JSON.stringify(event.content).includes('CERTIFIED'))
                matched = true;
            if (event.type === 'session.thread_status_idle') {
                idle = true;
                break;
            }
        }
        assert.ok(evaluated, 'No auto permission evaluation');
        assert.ok(matched, 'No verified response');
        assert.ok(toolSucceeded);
        assert.ok(idle);
        return { eventTypes: types, autoPermissionAllowed: evaluated, outputMatched: matched, toolSucceeded, idle };
    }
    finally {
        const errors = [];
        for (const [resource, id, method] of [[api.sessions, session?.id, 'delete'], [api.environments, environment?.id, 'delete'], [api.agents, agent?.id, 'archive']])
            if (id)
                try {
                    await resource[method](id, {}, options);
                }
                catch (e) {
                    errors.push({ id, message: sanitize(e.message) });
                }
        if (errors.length) {
            report.cleanupErrors = errors;
            persist();
            throw new Error('Managed resource cleanup failed; see cleanupErrors');
        }
    }
});
report.finishedAt = new Date().toISOString();
persist();
if (!report.results.length || report.results.some(result => result.status !== 'passed') || report.cleanupErrors?.length)
    process.exitCode = 1;
