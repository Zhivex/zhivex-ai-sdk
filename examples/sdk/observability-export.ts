import {
  createAgent,
  createAgentTraceArtifact,
  createProductionTraceCollector,
  estimateAgentRunCost,
  runAgent,
  summarizeAgentTrace,
  tool,
  type AgentTraceArtifact,
  type LanguageModel
} from "../../packages/sdk/src/index";
import { z } from "zod";

import { section } from "../_shared";

const capabilities: LanguageModel["capabilities"] = {
  streaming: false,
  tools: true,
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
};

const sensitiveKeyPattern = /api[-_]?key|authorization|email|secret|token/i;
const metricTokenKeyPattern = /^(input|output|total)Tokens$/;
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

const redactValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return value.replace(emailPattern, "[redacted-email]");
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKeyPattern.test(key) && !metricTokenKeyPattern.test(key) ? "[redacted]" : redactValue(item)
    ])
  );
};

let generateCalls = 0;

const model: LanguageModel = {
  provider: "example",
  modelId: "deterministic-observability-model",
  capabilities,
  async generate() {
    generateCalls += 1;

    if (generateCalls === 1) {
      return {
        finishReason: "tool-calls",
        usage: {
          inputTokens: 180,
          outputTokens: 28,
          totalTokens: 208
        },
        messages: [
          {
            role: "assistant",
            parts: [
              {
                type: "tool-call",
                toolCall: {
                  id: "call_profile_1",
                  name: "lookupCustomerProfile",
                  input: {
                    customerId: "cus_123",
                    email: "ana@example.com",
                    apiToken: "tok_live_sensitive"
                  }
                }
              }
            ]
          }
        ]
      };
    }

    return {
      text: "Customer cus_123 is active and ready for follow-up.",
      finishReason: "stop",
      usage: {
        inputTokens: 96,
        outputTokens: 14,
        totalTokens: 110
      },
      messages: [
        {
          role: "assistant",
          parts: [{ type: "text", text: "Customer cus_123 is active and ready for follow-up." }]
        }
      ]
    };
  }
};

const collector = createProductionTraceCollector({
  includeToolInputs: true,
  outputPreviewLength: 160
});

const agent = createAgent({
  id: "observability-export-example",
  model,
  maxSteps: 3,
  onTelemetryEvent: collector.observer,
  tools: {
    lookupCustomerProfile: tool({
      name: "lookupCustomerProfile",
      description: "Looks up a customer profile from an app-owned system.",
      schema: z.object({
        customerId: z.string(),
        email: z.string().email(),
        apiToken: z.string()
      }),
      execute: ({ customerId, email }) => ({
        customerId,
        email,
        status: "active",
        internalSecret: "profile-store-secret",
        lastInvoiceCents: 12900
      })
    })
  }
});

const createToolAuditRecords = (trace: AgentTraceArtifact) =>
  trace.steps.flatMap((step) =>
    step.toolResults.map((result) => {
      const toolCall = step.toolCalls.find((call) => call.id === result.toolCallId);

      return {
        type: "tool_call_audit",
        runId: trace.runId,
        agentId: trace.agentId,
        provider: trace.provider,
        modelId: trace.modelId,
        step: step.index,
        toolName: result.toolName,
        toolCallId: result.toolCallId,
        status: result.isError ? "error" : "ok",
        input: toolCall?.input,
        output: result.output,
        error: result.error
      };
    })
  );

section("Run agent and collect telemetry");
const result = await runAgent(agent, {
  userId: "user_123",
  prompt: "Check ana@example.com before the next follow-up."
});

const trace =
  collector.getTrace(result.state.runId) ??
  createAgentTraceArtifact(result.state, {
    includeToolInputs: true,
    outputPreviewLength: 160
  });

const summary = summarizeAgentTrace(trace, {
  pricing: {
    inputCostPer1kTokens: 1,
    outputCostPer1kTokens: 3,
    currency: "USD"
  }
});

section("Reproducible summary");
console.log(
  JSON.stringify(
    {
      runId: summary.runId,
      status: summary.status,
      provider: summary.provider,
      modelId: summary.modelId,
      latencyMs: summary.latency.durationMs,
      steps: summary.steps,
      toolCalls: summary.toolCalls,
      usage: summary.usage,
      cost: summary.cost
    },
    null,
    2
  )
);

section("Cost can also be recomputed from saved state");
console.log(estimateAgentRunCost(result.state, { costPer1kTokens: 0.6, currency: "USD" }));

section("Redacted JSONL export");
const exportRecords = [
  { type: "agent_trace_summary", ...summary },
  { type: "agent_trace_artifact", ...trace },
  ...createToolAuditRecords(trace)
];

for (const record of exportRecords) {
  console.log(JSON.stringify(redactValue(record)));
}
