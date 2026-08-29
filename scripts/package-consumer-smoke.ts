import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { integrationProviderStatuses } from "../packages/core/tests/integration-registry.js";

interface PackageManifest {
  name: string;
  version?: string;
  exports?: Record<string, unknown> | string;
}

interface WorkspaceManifest {
  devDependencies?: Record<string, string>;
}

interface NpmPackResult {
  filename: string;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(scriptDirectory, "..");
const packagesDirectory = join(workspaceDirectory, "packages");
const workspaceManifest = JSON.parse(
  readFileSync(join(workspaceDirectory, "package.json"), "utf8")
) as WorkspaceManifest;
const exactDependencyVersion = (version: string) => version.replace(/^[~^]/, "");
const otelApiVersion = process.env.ZHIVEX_OTEL_API_VERSION
  ?? exactDependencyVersion(workspaceManifest.devDependencies?.["@opentelemetry/api"] ?? "1.9.0");
const otelSdkVersion = process.env.ZHIVEX_OTEL_SDK_VERSION
  ?? exactDependencyVersion(workspaceManifest.devDependencies?.["@opentelemetry/sdk-trace-base"] ?? "2.10.0");

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
const optionalPeerConsumerDirectory = join(temporaryDirectory, "consumer-without-otel-api");
const npmCacheDirectory = join(temporaryDirectory, "npm-cache");
mkdirSync(packDirectory);
mkdirSync(consumerDirectory);
mkdirSync(optionalPeerConsumerDirectory);

const commandEnvironment = {
  ...process.env,
  NPM_CONFIG_CACHE: npmCacheDirectory,
  NPM_CONFIG_FUND: "false",
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_UPDATE_NOTIFIER: "false"
};

try {
  const packedPackages = manifests.map(({ directory, manifest }) => {
    console.log(`Packing ${manifest.name} for installed-consumer smoke...`);
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
    return {
      manifest,
      tarball: join(packDirectory, result[0].filename)
    };
  });
  const tarballs = packedPackages.map(({ tarball }) => tarball);
  const packedPackageEvidence = Object.fromEntries(packedPackages.map(({ manifest, tarball }) => [
    manifest.name,
    {
      version: manifest.version ?? "unknown",
      integrity: `sha256:${createHash("sha256").update(readFileSync(tarball)).digest("hex")}`
    }
  ]));
  const sourceGitSha = process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspaceDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  const coreTarball = packedPackages.find(({ manifest }) => manifest.name === "@zhivex-ai/core")?.tarball;
  if (!coreTarball) {
    throw new Error("@zhivex-ai/core tarball was not created.");
  }

  writeFileSync(
    join(optionalPeerConsumerDirectory, "package.json"),
    `${JSON.stringify({ name: "zhivex-optional-otel-peer-smoke", private: true, type: "module" }, null, 2)}\n`
  );
  console.log("Installing @zhivex-ai/core without optional OpenTelemetry peers...");
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--omit=optional",
      coreTarball
    ],
    { cwd: optionalPeerConsumerDirectory, env: commandEnvironment, stdio: "inherit" }
  );
  const optionalPeerSmokePath = join(optionalPeerConsumerDirectory, "smoke.mjs");
  writeFileSync(optionalPeerSmokePath, `
import assert from "node:assert/strict";

await assert.rejects(import("@opentelemetry/api"), /Cannot find package|module not found/i);
const { createOtelObserver } = await import("@zhivex-ai/core");
const spans = [];
const observer = await createOtelObserver({
  tracer: {
    startSpan(name) {
      const span = { name, ended: false, end() { this.ended = true; } };
      spans.push(span);
      return span;
    }
  }
});
const handle = observer.startSpan("optional-peer-smoke");
await handle.end();
assert.equal(spans.length, 1);
assert.equal(spans[0]?.ended, true);
await assert.rejects(createOtelObserver(), /OpenTelemetry is not installed/);
console.log("INSTALLED_OTEL_OPTIONAL_PEER_SMOKE_OK");
`);
  execFileSync("node", [optionalPeerSmokePath], {
    cwd: optionalPeerConsumerDirectory,
    env: commandEnvironment,
    stdio: "inherit"
  });

  writeFileSync(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "zhivex-package-consumer-smoke", private: true, type: "module" }, null, 2)}\n`
  );
  console.log(`Installing packed packages with OpenTelemetry SDK ${otelSdkVersion}...`);
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      `@opentelemetry/api@${otelApiVersion}`,
      `@opentelemetry/context-async-hooks@${otelSdkVersion}`,
      `@opentelemetry/sdk-metrics@${otelSdkVersion}`,
      `@opentelemetry/sdk-trace-base@${otelSdkVersion}`,
      ...tarballs
    ],
    { cwd: consumerDirectory, env: commandEnvironment, stdio: "inherit" }
  );

  const sdkManifest = manifests.find(({ manifest }) => manifest.name === "@zhivex-ai/sdk")?.manifest;
  if (!sdkManifest?.version) {
    throw new Error("@zhivex-ai/sdk package metadata is missing a version.");
  }
  const installedCliPath = join(
    consumerDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "zhivex-ai.cmd" : "zhivex-ai"
  );
  const runInstalledCli = (args: string[]) =>
    execFileSync(installedCliPath, args, {
      cwd: consumerDirectory,
      encoding: "utf8",
      env: commandEnvironment,
      shell: process.platform === "win32"
    });
  const installedCliVersion = JSON.parse(runInstalledCli(["--version"])) as {
    schemaVersion?: number;
    type?: string;
    name?: string;
    version?: string;
  };
  if (
    installedCliVersion.schemaVersion !== 1 ||
    installedCliVersion.type !== "cli_version" ||
    installedCliVersion.name !== "@zhivex-ai/sdk" ||
    installedCliVersion.version !== sdkManifest.version
  ) {
    throw new Error("Installed zhivex-ai CLI version output does not match its package metadata.");
  }
  const installedCliHelp = runInstalledCli(["--help"]);
  if (
    !installedCliHelp.includes("workflow replay|report|compare|baseline|gate|run|eval") ||
    !installedCliHelp.includes("eval run|compare")
  ) {
    throw new Error("Installed zhivex-ai CLI help output is incomplete.");
  }
  console.log(`INSTALLED_CLI_SMOKE_OK ${installedCliVersion.version}`);

  const specifiers = manifests.flatMap(({ manifest }) => importSpecifiers(manifest));
  const smokeSource = `
import assert from "node:assert/strict";
import { writeFileSync as writeInstalledEvidence } from "node:fs";
import { context, SpanKind } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor
} from "@opentelemetry/sdk-trace-base";

const specifiers = ${JSON.stringify(specifiers)};
const providerEvidence = ${JSON.stringify(integrationProviderStatuses.map((provider) => ({
    provider: provider.name,
    packageName: provider.packageName,
    endpoint: provider.endpoint,
    modelId: provider.textModelId
  })))};
const packedPackageEvidence = ${JSON.stringify(packedPackageEvidence)};
const typeOnlySpecifiers = new Set(["@zhivex-ai/core/contracts"]);
for (const specifier of specifiers) {
  const exports = await import(specifier);
  assert.ok(
    Object.keys(exports).length > 0 || typeOnlySpecifiers.has(specifier),
    \`\${specifier} has no runtime exports\`
  );
}

const {
  createAgent,
  createInMemorySessionService,
  createModelCatalog,
  createOtelAgentObserver,
  createOtelObserver,
  createOtelTelemetryMiddleware,
  createOtelWorkflowObserver,
  createRunner,
  createTextMessage,
  createWorkflow,
  normalizeProviderConformanceReport,
  OTEL_GENAI_CONTRACT_VERSION,
  OTEL_GENAI_SEMCONV_REVISION,
  ProviderToolCallError,
  renderProviderConformanceMarkdown,
  runWorkflow,
  wrapLanguageModel
} = await import("@zhivex-ai/core");
assert.equal(OTEL_GENAI_CONTRACT_VERSION, 1);
assert.equal(OTEL_GENAI_SEMCONV_REVISION, "a685613a207a580163353b8e48a7ad88967e7b42");
const installedSdk = await import("@zhivex-ai/sdk");
const installedOpenAI = await import("@zhivex-ai/openai");
const installedQwen = await import("@zhivex-ai/qwen");
assert.equal(installedSdk.ProviderToolCallError, ProviderToolCallError);
assert.equal(installedOpenAI.OPENAI_RESPONSES_TOOL_CALL_ERROR_CODE, "OPENAI_RESPONSES_TOOL_CALL_INVALID");
const installedProviderToolCallError = new ProviderToolCallError({
  provider: "openai",
  transport: "responses",
  diagnosticCode: installedOpenAI.OPENAI_RESPONSES_TOOL_CALL_ERROR_CODE,
  reason: "invalid_json",
  retryable: true
});
assert.equal(installedProviderToolCallError.retryable, true);
assert.equal(installedProviderToolCallError.effectsPossible, false);
assert.equal(installedProviderToolCallError.message, "Provider tool call could not be materialized safely.");

const installedQwenModel = installedQwen.createQwen({
  apiKey: "installed-qwen-smoke",
  fetch: async () => Response.json({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        tool_calls: [
          { id: "0", function: { name: "weather", arguments: "{}" } },
          { id: "0", function: { name: "timezone", arguments: "{}" } },
          { id: "call_opaque", function: { name: "weather", arguments: "{}" } }
        ]
      }
    }]
  })
})("qwen3.8-flash");
const installedQwenResult = await installedQwenModel.generate({
  messages: [createTextMessage("user", "compare cities")],
  providerOptions: { apiMode: "chat" }
});
assert.deepEqual(
  installedQwenResult.messages[0].parts
    .filter((part) => part.type === "tool-call")
    .map((part) => part.toolCall.id),
  ["qwen-chat-tool-1-0", "qwen-chat-tool-1-1", "call_opaque"]
);
console.log("INSTALLED_QWEN_TRANSIENT_TOOL_CALL_ID_SMOKE_OK");

const { createModelResolver, ModelResolutionError } = await import("@zhivex-ai/sdk/beta");
const installedResolverCatalog = createModelCatalog([
  { provider: "installed", modelId: "resolver-model", aliases: ["current"], costPer1kTokens: 0.01 }
]);
const installedResolver = createModelResolver({
  catalog: installedResolverCatalog,
  adapters: {
    installed: {
      name: "installed",
      languageModel(modelId) {
        return {
          provider: "installed",
          modelId,
          capabilities: {
            streaming: false,
            tools: false,
            structuredOutput: false,
            jsonMode: false,
            toolChoice: false,
            parallelToolCalls: false,
            vision: false,
            files: false,
            audioInput: false,
            audioOutput: false,
            embeddings: false,
            reasoning: false,
            webSearch: false
          },
          async generate() {
            return { text: "installed-resolver-ok", finishReason: "stop" };
          }
        };
      }
    }
  }
});
const installedResolution = installedResolver.resolve("installed/current");
assert.equal(installedResolution.model.modelId, "resolver-model");
assert.equal(installedResolution.metadata.catalogEntry.costPer1kTokens, 0.01);
assert.throws(
  () => installedResolver.resolve("installed/missing"),
  (error) => error instanceof ModelResolutionError && error.code === "unknown_model"
);
console.log("INSTALLED_MODEL_RESOLVER_SMOKE_OK");

const spanExporter = new InMemorySpanExporter();
const spanProcessor = new SimpleSpanProcessor(spanExporter);
const tracerProvider = typeof BasicTracerProvider.prototype.addSpanProcessor === "function"
  ? new BasicTracerProvider()
  : new BasicTracerProvider({ spanProcessors: [spanProcessor] });
if (typeof tracerProvider.addSpanProcessor === "function") {
  tracerProvider.addSpanProcessor(spanProcessor);
}
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const meterProvider = new MeterProvider({
  readers: [new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000
  })]
});
const contextManager = new AsyncLocalStorageContextManager().enable();
context.disable();
assert.equal(context.setGlobalContextManager(contextManager), true);

try {
  const observer = await createOtelObserver({
    tracerProvider,
    tracerName: "installed-package-smoke"
  });
  const meter = meterProvider.getMeter("installed-package-smoke");
  const workflowObserver = await createOtelWorkflowObserver({ observer, meter });
  const agentObserver = await createOtelAgentObserver({ observer, meter });
  const modelMiddleware = await createOtelTelemetryMiddleware({ observer, meter });
  let modelCalls = 0;
  let releaseConcurrentCalls;
  const concurrentCallsReady = new Promise((resolve) => {
    releaseConcurrentCalls = resolve;
  });
  const instrumentedModel = wrapLanguageModel({
    provider: "openai",
    modelId: "installed-otel-model",
    capabilities: {
      streaming: true,
      tools: true,
      structuredOutput: true,
      jsonMode: true,
      toolChoice: true,
      parallelToolCalls: false,
      vision: false,
      files: false,
      audioInput: false,
      audioOutput: false,
      embeddings: false,
      reasoning: false,
      webSearch: false
    },
    async generate() {
      modelCalls += 1;
      if (modelCalls === 2) releaseConcurrentCalls();
      await concurrentCallsReady;
      return {
        messages: [createTextMessage("assistant", "installed otel ok")],
        text: "installed otel ok",
        finishReason: "stop",
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }
      };
    }
  }, [modelMiddleware]);
  const runner = createRunner({
    appName: "installed-otel-smoke",
    agent: createAgent({
      name: "Installed OTEL Agent",
      model: instrumentedModel,
      maxSteps: 2,
      onTelemetryEvent: agentObserver
    }),
    sessionService: createInMemorySessionService()
  });
  const workflow = createWorkflow({
    name: "installed_otel_workflow",
    onTelemetryEvent: workflowObserver,
    steps: [{ id: "installed-model-step", runner, prompt: "Generate" }]
  });

  const results = await Promise.all([
    runWorkflow(workflow, { userId: "installed-user-1", sessionId: "installed-session-1" }),
    runWorkflow(workflow, { userId: "installed-user-2", sessionId: "installed-session-2" })
  ]);
  assert.ok(results.every((result) => result.status === "completed"));
  assert.equal(modelCalls, 2);
  await Promise.all([tracerProvider.forceFlush(), meterProvider.forceFlush()]);

  const spans = spanExporter.getFinishedSpans();
  const workflowSpans = spans.filter((span) => span.name === "invoke_workflow installed_otel_workflow");
  const stepSpans = spans.filter((span) => span.name === "workflow_step installed-model-step");
  const agentSpans = spans.filter((span) => span.name === "invoke_agent Installed OTEL Agent");
  const modelSpans = spans.filter((span) => span.name === "chat installed-otel-model");
  const parentSpanId = (span) => span.parentSpanContext?.spanId ?? span.parentSpanId;
  assert.equal(workflowSpans.length, 2);
  assert.equal(stepSpans.length, 2);
  assert.equal(agentSpans.length, 2);
  assert.equal(modelSpans.length, 2);
  for (const workflowSpan of workflowSpans) {
    assert.equal(workflowSpan.kind, SpanKind.INTERNAL);
    const stepSpan = stepSpans.find((span) => parentSpanId(span) === workflowSpan.spanContext().spanId);
    assert.ok(stepSpan, "workflow step did not inherit the workflow context");
    const agentSpan = agentSpans.find((span) => parentSpanId(span) === stepSpan.spanContext().spanId);
    assert.ok(agentSpan, "agent did not inherit the workflow-step context");
    const modelSpan = modelSpans.find((span) => parentSpanId(span) === agentSpan.spanContext().spanId);
    assert.ok(modelSpan, "model did not inherit the agent context");
    assert.equal(modelSpan.kind, SpanKind.CLIENT);
    assert.equal(modelSpan.spanContext().traceId, workflowSpan.spanContext().traceId);
  }

  const metrics = metricExporter.getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics);
  const histogramCount = (name) => metrics
    .filter((metric) => metric.descriptor.name === name)
    .flatMap((metric) => metric.dataPoints)
    .reduce((count, point) => count + (point.value?.count ?? 0), 0);
  const metricByName = (name) => metrics.find((metric) => metric.descriptor.name === name);
  assert.equal(histogramCount("gen_ai.invoke_workflow.duration"), 2);
  assert.equal(histogramCount("gen_ai.invoke_agent.duration"), 2);
  assert.equal(histogramCount("gen_ai.invoke_agent.inference_calls"), 2);
  assert.equal(histogramCount("gen_ai.client.operation.duration"), 2);
  assert.equal(histogramCount("gen_ai.client.token.usage"), 4);
  assert.equal(metricByName("gen_ai.invoke_workflow.duration")?.descriptor.unit, "s");
  assert.equal(metricByName("gen_ai.client.token.usage")?.descriptor.unit, "{token}");
  console.log("INSTALLED_OTEL_REAL_SDK_SMOKE_OK workflows=2");
} finally {
  context.disable();
  await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
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

const installedObservedAt = new Date().toISOString();
const installedExpiresAt = new Date(Date.parse(installedObservedAt) + 7 * 24 * 60 * 60 * 1000).toISOString();
const installedConformance = normalizeProviderConformanceReport({
  schemaVersion: 1,
  reportId: ${JSON.stringify(`provider-conformance-installed-${sourceGitSha.slice(0, 12)}`)},
  generatedAt: installedObservedAt,
  expiresAt: installedExpiresAt,
  generator: "scripts/package-consumer-smoke.ts",
  source: {
    repository: process.env.GITHUB_REPOSITORY ?? "Zhivex/zhivex-ai-sdk",
    gitSha: ${JSON.stringify(sourceGitSha)},
    runtime: "node " + process.version + "; " + process.platform + "/" + process.arch,
    ...(process.env.GITHUB_RUN_ID ? {
      ci: {
        system: "github-actions",
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        workflow: process.env.GITHUB_WORKFLOW
      }
    } : {})
  },
  providers: providerEvidence.map((provider) => ({
    provider: provider.provider,
    results: [{
      capability: "package_import",
      evidence: "installed",
      status: "installed_passed",
      required: false,
      modelId: provider.modelId,
      endpoint: provider.endpoint,
      artifact: {
        kind: "installed",
        packageName: provider.packageName,
        packageVersion: packedPackageEvidence[provider.packageName].version,
        integrity: packedPackageEvidence[provider.packageName].integrity
      },
      observedAt: installedObservedAt,
      expiresAt: installedExpiresAt,
      attempts: 1,
      metadata: { importedEntrypoints: specifiers.filter((specifier) => specifier.startsWith(provider.packageName)).length }
    }]
  }))
});
assert.match(renderProviderConformanceMarkdown(installedConformance), /installed_passed/);
if (process.env.ZHIVEX_PROVIDER_CONFORMANCE_INSTALLED_OUTPUT) {
  writeInstalledEvidence(
    process.env.ZHIVEX_PROVIDER_CONFORMANCE_INSTALLED_OUTPUT,
    JSON.stringify(installedConformance, null, 2) + "\\n",
    { mode: 0o600 }
  );
}

console.log(\`Node package consumer smoke: \${specifiers.length} entrypoints imported\`);
console.log("INSTALLED_PROVIDER_CONFORMANCE_SMOKE_OK");
console.log("INSTALLED_REALTIME_LIVE_SMOKE_OK");
`;
  const smokePath = join(consumerDirectory, "smoke.mjs");
  writeFileSync(smokePath, smokeSource);
  execFileSync("node", [smokePath], {
    cwd: consumerDirectory,
    env: commandEnvironment,
    stdio: "inherit"
  });

  const goldenPathSmokePath = join(consumerDirectory, "golden-path-smoke.mjs");
  writeFileSync(
    goldenPathSmokePath,
    readFileSync(join(scriptDirectory, "fixtures", "golden-path-installed-smoke.mjs"), "utf8")
  );
  console.log("Running the canonical installed-package golden path with Bun...");
  execFileSync("bun", [goldenPathSmokePath], {
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
