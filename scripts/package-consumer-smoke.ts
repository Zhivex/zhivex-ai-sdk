import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageManifest {
  name: string;
  exports?: Record<string, unknown> | string;
}

interface NpmPackResult {
  filename: string;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(scriptDirectory, "..");
const packagesDirectory = join(workspaceDirectory, "packages");

const hasJavaScriptExport = (target: unknown): boolean => {
  if (typeof target === "string") {
    return !target.endsWith(".css");
  }
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return false;
  }
  const conditions = target as Record<string, unknown>;
  return "import" in conditions || "default" in conditions;
};

const importSpecifiers = (manifest: PackageManifest) => {
  if (!manifest.exports || typeof manifest.exports === "string") {
    return [manifest.name];
  }
  return Object.entries(manifest.exports)
    .filter(([, target]) => hasJavaScriptExport(target))
    .map(([subpath]) => subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`);
};

const manifests = readdirSync(packagesDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    directory: join(packagesDirectory, entry.name),
    manifest: JSON.parse(readFileSync(join(packagesDirectory, entry.name, "package.json"), "utf8")) as PackageManifest
  }))
  .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));

const temporaryDirectory = mkdtempSync(join(tmpdir(), "zhivex-package-smoke-"));
const packDirectory = join(temporaryDirectory, "packs");
const consumerDirectory = join(temporaryDirectory, "consumer");
const npmCacheDirectory = join(temporaryDirectory, "npm-cache");
mkdirSync(packDirectory);
mkdirSync(consumerDirectory);

const commandEnvironment = {
  ...process.env,
  NPM_CONFIG_CACHE: npmCacheDirectory,
  NPM_CONFIG_FUND: "false",
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_UPDATE_NOTIFIER: "false"
};

try {
  const tarballs = manifests.map(({ directory }) => {
    const output = execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", packDirectory, directory],
      {
        cwd: workspaceDirectory,
        encoding: "utf8",
        env: commandEnvironment,
        stdio: ["ignore", "pipe", "inherit"]
      }
    );
    const result = JSON.parse(output) as NpmPackResult[];
    if (result.length !== 1 || !result[0]?.filename) {
      throw new Error(`npm pack returned an unexpected result for ${directory}.`);
    }
    return join(packDirectory, result[0].filename);
  });

  writeFileSync(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "zhivex-package-consumer-smoke", private: true, type: "module" }, null, 2)}\n`
  );
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", ...tarballs],
    { cwd: consumerDirectory, env: commandEnvironment, stdio: "inherit" }
  );

  const specifiers = manifests.flatMap(({ manifest }) => importSpecifiers(manifest));
  const smokeSource = `
import assert from "node:assert/strict";

const specifiers = ${JSON.stringify(specifiers)};
for (const specifier of specifiers) {
  const exports = await import(specifier);
  assert.ok(Object.keys(exports).length > 0, \`\${specifier} has no runtime exports\`);
}

const { createHttpTool } = await import("@zhivex-ai/core");
const originalFetch = globalThis.fetch;
try {
  for (const status of [204, 205]) {
    globalThis.fetch = async () => new Response(null, { status });
    const entry = createHttpTool({
      name: \`bodyless\${status}\`,
      schema: {},
      url: "https://example.com/tool",
      mapResponse: async (response) => ({ status: response.status, body: await response.text() })
    });
    assert.ok("execute" in entry.tool);
    assert.deepEqual(await entry.tool.execute({}), { status, body: "" });
  }
} finally {
  globalThis.fetch = originalFetch;
}

const { CallbackRealtimeSession } = await import("@zhivex-ai/core");
const { streamLiveAgent } = await import("@zhivex-ai/agents/realtime");
const sdk = await import("@zhivex-ai/sdk");
assert.equal(typeof CallbackRealtimeSession, "function");
assert.equal(typeof streamLiveAgent, "function");
assert.equal(sdk.streamLiveAgent, streamLiveAgent);

let realtimeConnectionClosed = false;
let deterministicToolExecutions = 0;
let deterministicToolResultsSent = 0;
const deterministicRealtimeModel = {
  provider: "installed-smoke",
  modelId: "deterministic-realtime",
  capabilities: {
    streaming: false,
    tools: true,
    structuredOutput: false,
    jsonMode: false,
    toolChoice: true,
    parallelToolCalls: false,
    vision: false,
    files: false,
    audioInput: true,
    audioOutput: false,
    embeddings: false,
    reasoning: false,
    webSearch: false
  },
  async connect(config = {}) {
    const frames = [];
    const receivers = [];
    let connectionClosed = false;
    const push = (frame) => {
      const receiver = receivers.shift();
      if (receiver) receiver(frame);
      else frames.push(frame);
    };
    const connection = {
      async sendJson(payload) {
        if (payload.type === "text") {
          push({
            type: "realtime-tool-call",
            toolCall: {
              id: "installed-call-1",
              name: "certify_installed_live",
              input: { value: 2 }
            }
          });
          push({ type: "realtime-response-complete", reason: "tool-call" });
          return;
        }
        if (payload.type === "tool-result") {
          deterministicToolResultsSent += 1;
          push({ type: "realtime-text-delta", textDelta: "installed-realtime-ok" });
          push({
            type: "realtime-transcript",
            text: "installed-realtime-ok",
            role: "assistant",
            isFinal: true
          });
          push({ type: "realtime-response-complete", reason: "turn-complete" });
        }
      },
      async recvJson() {
        if (frames.length) return frames.shift();
        if (connectionClosed) return undefined;
        return new Promise((resolve) => receivers.push(resolve));
      },
      async close() {
        connectionClosed = true;
        realtimeConnectionClosed = true;
        while (receivers.length) receivers.shift()(undefined);
      }
    };
    const session = new CallbackRealtimeSession({
      provider: "installed-smoke",
      modelId: "deterministic-realtime",
      capabilities: this.capabilities,
      config,
      connection,
      callbacks: {
        parseEvent: (payload) => [payload],
        buildAudioPayloads: () => [],
        buildTextPayloads: (text) => [{ type: "text", text }],
        buildToolResultPayloads: (result) => [{ type: "tool-result", result }],
        buildUpdatePayloads: (value) => [{ type: "update", value }]
      }
    });
    await session.initialize();
    return session;
  }
};

const installedLive = streamLiveAgent(
  {
    id: "installed-realtime-agent",
    model: deterministicRealtimeModel,
    instructions: "Call the certification tool once, then reply with the deterministic smoke token.",
    tools: {
      certify_installed_live: {
        name: "certify_installed_live",
        schema: {
          safeParse(input) {
            return input?.value === 2
              ? { success: true, data: input }
              : { success: false, error: new Error("Expected value 2") };
          }
        },
        execute({ value }) {
          deterministicToolExecutions += 1;
          return { certified: true, value };
        }
      }
    }
  },
  { prompt: "Call certify_installed_live with value 2, then reply exactly: installed-realtime-ok" }
);
const installedEventTypes = [];
const installedTextChunks = [];
const [, , installedFinal] = await Promise.all([
  (async () => {
    for await (const event of installedLive.eventStream) installedEventTypes.push(event.type);
  })(),
  (async () => {
    for await (const chunk of installedLive.textStream) installedTextChunks.push(chunk);
  })(),
  installedLive.collect()
]);
assert.equal(installedFinal.status, "completed");
assert.equal(deterministicToolExecutions, 1);
assert.equal(deterministicToolResultsSent, 1);
assert.equal(installedFinal.toolResults.length, 1);
assert.deepEqual(installedFinal.toolResults[0]?.output, { certified: true, value: 2 });
assert.equal(installedFinal.outputText, "installed-realtime-ok");
assert.equal(installedTextChunks.join(""), "installed-realtime-ok");
assert.ok(installedEventTypes.includes("realtime-start"));
assert.equal(
  installedEventTypes.filter((type) => type === "realtime-response-complete").length,
  2
);
assert.ok(installedEventTypes.includes("realtime-tool-call"));
assert.ok(installedEventTypes.includes("realtime-tool-result"));
assert.ok(realtimeConnectionClosed, "installed realtime connection was not closed");

console.log(\`Node package consumer smoke: \${specifiers.length} entrypoints imported\`);
console.log("INSTALLED_REALTIME_LIVE_SMOKE_OK");
`;
  const smokePath = join(consumerDirectory, "smoke.mjs");
  writeFileSync(smokePath, smokeSource);
  execFileSync("node", [smokePath], {
    cwd: consumerDirectory,
    env: commandEnvironment,
    stdio: "inherit"
  });
} catch (error) {
  console.error(`Package consumer smoke failed in ${temporaryDirectory}.`);
  throw error;
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
