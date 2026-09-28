import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { once } from "node:events";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as coreMcp from "@zhivex-ai/core/mcp-http";
import * as sdkMcp from "@zhivex-ai/sdk/mcp-http";
import { Agent, createMcpToolSet, createMockLanguageModel, createTextMessage } from "@zhivex-ai/sdk";

assert.deepEqual(Object.keys(coreMcp).sort(), Object.keys(sdkMcp).sort());
assert.deepEqual(Object.keys(coreMcp.MCP_HTTP_API_STABILITY_MANIFEST).sort(), Object.keys(coreMcp).sort());
const tls = { cert: readFileSync(process.env.MCP_TEST_CERT), key: readFileSync(process.env.MCP_TEST_KEY) };

for (const [entrypoint, api] of [["core", coreMcp], ["sdk", sdkMcp]]) {
  for (const enableJsonResponse of [true, false]) {
    const sessions = new Map();
    const servers = [];
    const errors = [];
    let stored;
    let accessToken;
    let refreshToken;
    let authorization;
    let tokenExchanges = 0;
    let refreshExchanges = 0;
    let effects = 0;
    let droppedEffects = 0;
    let rejectedCalls = 0;
    let rejectNext = false;
    let expireNext = false;
    let enteredSlow;
    const slowEntered = new Promise(resolve => { enteredSlow = resolve; });
    let origin;
    let resource;
    let issuer;
    const json = (res, body, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const server = createServer(tls, (req, res) => {
      void (async () => {
        const url = new URL(req.url, origin);
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
          assert.equal(req.headers.authorization, undefined);
          return json(res, { resource, authorization_servers: [issuer] });
        }
        if (url.pathname === "/.well-known/oauth-authorization-server/issuer") {
          assert.equal(req.headers.authorization, undefined);
          return json(res, { issuer, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, code_challenge_methods_supported: ["S256"] });
        }
        if (url.pathname === "/authorize") {
          assert.equal(url.searchParams.get("client_id"), "fixture-client");
          assert.equal(url.searchParams.get("resource"), resource);
          assert.equal(url.searchParams.get("code_challenge_method"), "S256");
          assert.equal(url.searchParams.get("response_type"), "code");
          authorization = { code: randomUUID(), challenge: url.searchParams.get("code_challenge"), redirect: url.searchParams.get("redirect_uri") };
          const callback = new URL(authorization.redirect);
          callback.searchParams.set("code", authorization.code);
          callback.searchParams.set("state", url.searchParams.get("state"));
          callback.searchParams.set("iss", issuer);
          res.writeHead(302, { Location: callback.href });
          return res.end();
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        if (url.pathname === "/token") {
          assert.equal(req.headers.authorization, undefined);
          const params = new URLSearchParams(body);
          assert.equal(params.get("client_id"), "fixture-client");
          assert.equal(params.get("resource"), resource);
          if (params.get("grant_type") === "authorization_code") {
            assert.equal(params.get("code"), authorization.code);
            assert.equal(params.get("redirect_uri"), authorization.redirect);
            assert.equal(createHash("sha256").update(params.get("code_verifier")).digest("base64url"), authorization.challenge);
            authorization = undefined;
            tokenExchanges++;
          } else {
            assert.equal(params.get("grant_type"), "refresh_token");
            assert.equal(params.get("refresh_token"), refreshToken);
            refreshExchanges++;
          }
          accessToken = randomUUID();
          refreshToken = randomUUID();
          return json(res, { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 3600 });
        }
        assert.equal(url.pathname, "/mcp");
        if (!accessToken || req.headers.authorization !== `Bearer ${accessToken}` || rejectNext) {
          rejectNext = false;
          rejectedCalls++;
          res.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
          return res.end();
        }
        assert.equal(req.headers["mcp-protocol-version"], "2025-11-25");
        const rpc = JSON.parse(body);
        if (rpc.method === "initialize") {
          const mcp = new McpServer({ name: "zhivex-interop", version: "1" });
          mcp.registerTool("choose", { inputSchema: { mode: z.enum(["safe", "fast"]) }, outputSchema: { mode: z.string() } }, async ({ mode }) => {
            effects++;
            return { content: [{ type: "text", text: mode }], structuredContent: { mode } };
          });
          mcp.registerResource("text", "fixture://text", {}, async () => ({ contents: [{ uri: "fixture://text", text: "content" }] }));
          mcp.registerResource("binary", "fixture://binary", {}, async () => ({ contents: [{ uri: "fixture://binary", blob: "aGk=", mimeType: "application/octet-stream" }] }));
          mcp.registerResource("template", new ResourceTemplate("fixture://{name}", { list: undefined }), {}, async uri => ({ contents: [{ uri: uri.href, text: "template" }] }));
          mcp.registerPrompt("greeting", {}, async () => ({ messages: [{ role: "user", content: { type: "text", text: "hello" } }] }));
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse });
          await mcp.connect(transport);
          servers.push(mcp);
          await transport.handleRequest(req, res, rpc);
          sessions.set(transport.sessionId, transport);
          return;
        }
        const transport = sessions.get(req.headers["mcp-session-id"]);
        if (expireNext) {
          expireNext = false;
          sessions.delete(req.headers["mcp-session-id"]);
          return json(res, { error: "Expired" }, 404);
        }
        assert.ok(transport, "session identifier must be forwarded");
        if (rpc.method === "tools/call" && rpc.params.name === "drop") {
          droppedEffects++;
          return req.socket.destroy();
        }
        if (rpc.method === "tools/call" && rpc.params.name === "slow") {
          enteredSlow();
          return; // The client must cancel its real network request.
        }
        return transport.handleRequest(req, res, rpc);
      })().catch(error => {
        errors.push(error);
        if (!res.headersSent) json(res, { error: "Fixture failed" }, 500);
        else res.destroy();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `https://127.0.0.1:${server.address().port}`;
    resource = `${origin}/mcp`;
    issuer = `${origin}/issuer`;
    const auth = api.createMcpOAuthProvider({
      resource, issuer, clientId: "fixture-client", redirectUri: "http://127.0.0.1:8080/callback",
      destinationPolicy: url => url.origin === origin,
      tokenStore: { load: async () => stored, save: async value => { stored = structuredClone(value); }, clear: async () => { stored = undefined; } }
    });
    const client = api.createMcpHttpClient({ url: resource, auth, destinationPolicy: url => url.origin === origin, timeoutMs: 5000 });
    const anonymous = api.createMcpHttpClient({ url: resource });
    try {
      let challenge;
      await assert.rejects(anonymous.initialize(), error => {
        challenge = error.authorization;
        return error.code === "AUTH_REQUIRED";
      });
      assert.equal(rejectedCalls, 1);
      const start = await auth.beginAuthorization({ challenge });
      const navigation = await fetch(start.authorizationUrl, { redirect: "manual" });
      assert.equal(navigation.status, 302);
      const callback = navigation.headers.get("location");
      await navigation.body?.cancel();
      await auth.completeAuthorization(callback);
      await assert.rejects(auth.completeAuthorization(callback), { code: "AUTH_REJECTED" });
      assert.equal(tokenExchanges, 1);
      assert.equal((await client.listTools()).tools.length, 1);
      const resources = await api.collectMcpPages(async (cursor, options) => {
        const page = await client.listResources({ cursor }, options);
        return { items: page.resources, nextCursor: page.nextCursor };
      });
      assert.equal(resources.length, 2);
      assert.equal((await client.listResourceTemplates()).resourceTemplates.length, 1);
      assert.equal((await client.readResource({ uri: "fixture://text" })).contents[0].text, "content");
      assert.equal((await client.readResource({ uri: "fixture://binary" })).contents[0].blob, "aGk=");
      assert.equal((await client.listPrompts()).prompts.length, 1);
      assert.equal((await client.getPrompt({ name: "greeting" })).messages[0].content.text, "hello");

      const tools = await createMcpToolSet(client);
      assert.equal(tools.choose.schema.safeParse({ mode: "invalid" }).success, false);
      const agent = new Agent({ tools, maxSteps: 3, model: createMockLanguageModel({ responses: [
        { messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "choose-1", name: "choose", input: { mode: "safe" } } }] }], finishReason: "tool-calls" },
        { text: "done", messages: [createTextMessage("assistant", "done")], finishReason: "stop" }
      ] }) });
      const waiting = await agent.run({ prompt: "Choose safe" });
      assert.equal(waiting.status, "waiting_approval");
      assert.equal(effects, 0);
      const completed = await agent.resume({ state: waiting.state, approvals: waiting.state.pendingApprovals.map(p => ({ provider: p.provider, approvalRequestId: p.id, approve: true })) });
      assert.equal(completed.status, "completed");
      assert.equal(effects, 1);

      stored.expiresAt = 0;
      await Promise.all(Array.from({ length: 5 }, () => client.listTools()));
      assert.equal(refreshExchanges, 1);
      expireNext = true;
      await assert.rejects(client.listTools(), { code: "PROTOCOL_ERROR" });
      assert.equal((await client.listTools()).tools.length, 1);
      assert.equal(servers.length, 2);
      rejectNext = true;
      await assert.rejects(client.callTool({ name: "choose", arguments: { mode: "safe" } }), { code: "AUTH_EXPIRED" });
      assert.equal(effects, 1);
      assert.equal(rejectedCalls, 2);
      await assert.rejects(client.callTool({ name: "drop" }), { code: "INDETERMINATE" });
      assert.equal(droppedEffects, 1);
      const controller = new AbortController();
      const slow = client.callTool({ name: "slow" }, { abortSignal: controller.signal });
      const rejected = assert.rejects(slow, { code: "INDETERMINATE" });
      await slowEntered;
      controller.abort();
      await rejected;
      client.close();
      await assert.rejects(client.listTools());
      await auth.clear();
      assert.equal(stored, undefined);
      assert.deepEqual(errors, []);
      console.log(`MCP ${entrypoint} ${enableJsonResponse ? "JSON" : "SSE"}: HTTPS, PKCE, refresh, resources, prompts, approval/resume, expiry, cancellation and no replay passed`);
    } finally {
      client.close();
      anonymous.close();
      await Promise.all(servers.map(mcp => mcp.close()));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
}
