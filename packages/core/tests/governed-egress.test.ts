import { describe, expect, it } from "vitest";
import { z } from "zod";

import { Agent, createMockLanguageModel, tool } from "../src/index.js";
import {
  createEgressPolicy,
  EgressDeniedError,
  type EgressAuditRecord
} from "../src/egress-policy.js";
import { generateText, streamText } from "../src/generate-text.js";
import {
  createLatamSensitiveDataPolicy,
  cuitCheckDigit,
  isValidCbu,
  isValidCuit,
  isValidCvu,
  isValidCard
} from "../src/latam-redaction.js";
import type { LanguageModel, ModelGenerateInput } from "../src/types.js";

const CUIT = `20-12345678-${cuitCheckDigit("2012345678")}`;
const CBU = "2850590912345678901233";
const CVU = "0000001770000000000016";
const CPF = "123.456.789-09";
const CNPJ = "12.345.678/0001-95";
const RUT = "12.345.678-5";
const CURP = "GODE561231HDFXXX03";
const RFC = "GODE561231XX8";
const CARD = "5300123456789003";
const CARD_TEXT = "5300-1234-5678-9003";

const allowAll = {
  provider: "mock",
  model: "mock-model",
  region: "*",
  endpoint: "*"
};

const capturingModel = (
  responses: Parameters<typeof createMockLanguageModel>[0]["responses"],
  seen: ModelGenerateInput[] = []
): LanguageModel & { seen: ModelGenerateInput[] } => {
  const inner = createMockLanguageModel({ responses });
  return {
    ...inner,
    seen,
    async generate(input) {
      seen.push(input);
      return inner.generate(input);
    }
  };
};

describe("egress policy", () => {
  it("allows a matching call and writes one audit record", async () => {
    const seen: ModelGenerateInput[] = [];
    const policy = createEgressPolicy({ allow: [allowAll] });
    const model = capturingModel([{
      text: "ok",
      messages: [{ role: "assistant", parts: [{ type: "text", text: "ok" }] }],
      finishReason: "stop"
    }], seen);

    const result = await generateText({
      model,
      prompt: "hello",
      egressPolicy: policy,
      egress: { region: "us-east-1", endpoint: "https://api.example.test/v1/chat" }
    });

    expect(result.text).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(policy.records).toHaveLength(1);
    expect(policy.records[0]).toMatchObject({
      type: "egress_call_audit",
      decision: "allowed",
      provider: "mock",
      modelId: "mock-model",
      region: "us-east-1",
      endpoint: "https://api.example.test/v1/chat",
      schemaVersion: 1
    });
  });

  it("denies a call before the provider runs", async () => {
    let called = false;
    const policy = createEgressPolicy({ allow: [allowAll] });
    const model = createMockLanguageModel({ provider: "openai", modelId: "gpt-6-astra" });
    const wrapped: LanguageModel = {
      ...model,
      async generate(input) {
        called = true;
        return model.generate(input);
      }
    };

    await expect(generateText({
      model: wrapped,
      prompt: "hello",
      egressPolicy: policy
    })).rejects.toBeInstanceOf(EgressDeniedError);
    expect(called).toBe(false);
    expect(policy.records).toHaveLength(1);
    expect(policy.records[0]?.decision).toBe("denied");
  });

  it("denies conflicting region declarations and still audits when the sink throws", async () => {
    let called = false;
    const policy = createEgressPolicy({
      allow: [allowAll],
      onAudit: () => {
        throw new Error("sink down");
      }
    });
    const model = {
      ...createMockLanguageModel(),
      region: "us-east-1",
      async generate() {
        called = true;
        return { text: "no", messages: [] };
      }
    };

    const error = await generateText({
      model,
      prompt: "hello",
      egressPolicy: policy,
      egress: { region: "eu-west-1" }
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EgressDeniedError);
    expect((error as EgressDeniedError).cause).toBeInstanceOf(Error);
    expect(called).toBe(false);
    expect(policy.records).toHaveLength(1);
    expect(policy.records[0]?.reason).toContain("region");
  });

  it("does not call the provider when an allow audit sink throws", async () => {
    let called = false;
    const policy = createEgressPolicy({
      allow: [allowAll],
      onAudit: () => {
        throw new Error("sink down");
      }
    });
    const model = {
      ...createMockLanguageModel(),
      async generate() {
        called = true;
        return { text: "no" };
      }
    };

    await expect(generateText({ model, prompt: "hello", egressPolicy: policy })).rejects.toThrow("sink down");
    expect(called).toBe(false);
    expect(policy.records[0]?.decision).toBe("allowed");
  });

  it("fails closed for an empty allowlist, credentials, and a specific endpoint", async () => {
    await expect(createEgressPolicy({ allow: [] }).assert({ provider: "mock", model: "mock-model" })).rejects.toMatchObject({
      code: "EGRESS_DENIED"
    });
    const credentials = createEgressPolicy({ allow: [{ ...allowAll, endpoint: "*" }] });
    await expect(credentials.assert({
      provider: "mock",
      model: "mock-model",
      endpoint: "https://user:pass@api.example.test/v1"
    })).rejects.toBeInstanceOf(EgressDeniedError);
    expect(credentials.records[0]?.endpoint).toBeUndefined();

    const specific = createEgressPolicy({
      allow: [{ ...allowAll, endpoint: "https://api.example.test/v1" }]
    });
    const allowed = await specific.assert({
      provider: "mock",
      model: "mock-model",
      endpoint: "https://api.example.test/v1/chat"
    });
    expect(allowed.decision).toBe("allowed");
    await expect(specific.assert({
      provider: "mock",
      model: "mock-model",
      endpoint: "https://other.example.test/v1"
    })).rejects.toBeInstanceOf(EgressDeniedError);
    expect(specific.records).toHaveLength(2);
  });

  it("forwards the agent policy and lets a subagent inherit it", async () => {
    const policy = createEgressPolicy({
      allow: [{ provider: "mock", model: "*", region: "*", endpoint: "*" }]
    });
    const child = new Agent({
      model: createMockLanguageModel({
        provider: "blocked",
        modelId: "child",
        responses: [{
          text: "child",
          messages: [{ role: "assistant", parts: [{ type: "text", text: "child" }] }],
          finishReason: "stop"
        }]
      })
    });
    const parent = new Agent({
      model: createMockLanguageModel({
        provider: "mock",
        modelId: "parent",
        responses: [{
          messages: [{
            role: "assistant",
            parts: [{ type: "tool-call", toolCall: { id: "call-1", name: "delegate", input: { prompt: "lookup" } } }]
          }],
          finishReason: "tool-calls"
        }, {
          text: "done",
          messages: [{ role: "assistant", parts: [{ type: "text", text: "done" }] }],
          finishReason: "stop"
        }]
      }),
      egressPolicy: policy,
      maxSteps: 2,
      subagents: [{ name: "delegate", agent: child }]
    });

    await parent.run({ prompt: "go" });
    const decisions = policy.records.map((record: EgressAuditRecord) => `${record.decision}:${record.provider}/${record.modelId}`);
    expect(decisions).toContain("allowed:mock/parent");
    expect(decisions).toContain("denied:blocked/child");
  });
});

describe("LatAm redaction presets", () => {
  const policy = createLatamSensitiveDataPolicy();

  it("redacts synthetic identifiers with a valid check digit", () => {
    const text = `cuit ${CUIT} cbu ${CBU} cvu ${CVU} cpf ${CPF} cnpj ${CNPJ} rut ${RUT} curp ${CURP} rfc ${RFC} card ${CARD_TEXT}`;
    const redacted = policy.redactText(text);
    expect(redacted).toContain("[REDACTED:CUIT]");
    expect(redacted).toContain("[REDACTED:CBU]");
    expect(redacted).toContain("[REDACTED:CVU]");
    expect(redacted).toContain("[REDACTED:CPF]");
    expect(redacted).toContain("[REDACTED:CNPJ]");
    expect(redacted).toContain("[REDACTED:RUT]");
    expect(redacted).toContain("[REDACTED:CURP]");
    expect(redacted).toContain("[REDACTED:RFC]");
    expect(redacted).toContain("[REDACTED:CARD]");
    for (const raw of [CUIT, CBU, CVU, CPF, CNPJ, RUT, CURP, RFC, CARD_TEXT]) {
      expect(redacted).not.toContain(raw);
    }
    expect(isValidCuit(CUIT)).toBe(true);
    expect(isValidCbu(CBU)).toBe(true);
    expect(isValidCvu(CVU)).toBe(true);
    expect(isValidCard(CARD)).toBe(true);
    const messages = policy.redactMessages([{ role: "user", parts: [{ type: "text", text: CUIT }] }]);
    expect(JSON.stringify(messages)).toContain("[REDACTED:CUIT]");
    expect(JSON.stringify(messages)).not.toContain(CUIT);
  });

  it("leaves invalid check digits and ambiguous forms in place", () => {
    const invalid = [
      "20-12345678-0",
      "20123456786",
      "2850590912345678901234",
      "123.456.789-00",
      "12.345.678/0001-00",
      "12.345.678-0",
      "GODE561231HDFXXX00",
      "GODE561231XX0",
      "0000000000000000",
      "5300123456789004",
      `account ${CBU}`
    ];
    const redacted = policy.redactText(invalid.join(" "));
    expect(redacted).toContain("20-12345678-0");
    expect(redacted).toContain("20123456786");
    expect(redacted).toContain("2850590912345678901234");
    expect(redacted).toContain("123.456.789-00");
    expect(redacted).toContain("0000000000000000");
    expect(redacted).not.toContain("[REDACTED:CARD]");
    expect(redacted).toContain("[REDACTED:CBU]");
    expect(policy.redactText("person@example.com")).toBe("person@example.com");
  });

  it("limits detectors to the requested countries", () => {
    expect(createLatamSensitiveDataPolicy({ countries: ["AR"] }).redactText(CPF)).toBe(CPF);
    expect(createLatamSensitiveDataPolicy({ includeCards: false }).redactText(CARD_TEXT)).toBe(CARD_TEXT);
    expect(() => createLatamSensitiveDataPolicy({ countries: ["UY" as "AR"] })).toThrow(TypeError);
  });
});

describe("generation redaction", () => {
  it("redacts prompts, tool inputs, and tool results around the original tool execution", async () => {
    const seen: ModelGenerateInput[] = [];
    const executed: unknown[] = [];
    const model = capturingModel([
      {
        messages: [{
          role: "assistant",
          parts: [{ type: "tool-call", toolCall: { id: "call-1", name: "lookup", input: { account: CUIT } } }]
        }],
        finishReason: "tool-calls"
      },
      {
        text: `done ${CUIT}`,
        messages: [{ role: "assistant", parts: [{ type: "text", text: `done ${CUIT}` }] }],
        finishReason: "stop"
      }
    ], seen);

    const result = await generateText({
      model,
      prompt: `Account ${CUIT}`,
      maxSteps: 2,
      redaction: createLatamSensitiveDataPolicy(),
      tools: {
        lookup: tool({
          name: "lookup",
          description: "Look up an account",
          schema: z.object({ account: z.string() }),
          execute: async (input) => {
            executed.push(input);
            return { card: CARD_TEXT };
          }
        })
      }
    });

    expect(executed).toEqual([{ account: CUIT }]);
    expect(seen[0]?.messages.some((message) => JSON.stringify(message).includes(CUIT))).toBe(false);
    expect(JSON.stringify(seen[0]?.messages)).toContain("[REDACTED:CUIT]");
    expect(JSON.stringify(seen[1]?.messages)).toContain("[REDACTED:CARD]");
    expect(JSON.stringify(seen[1]?.messages)).not.toContain(CARD);
    expect(result.text).toBe("done [REDACTED:CUIT]");
    expect(JSON.stringify(result.messages)).not.toContain(CUIT);
    expect(JSON.stringify(result.toolResults)).toContain("[REDACTED:CARD]");
    expect(JSON.stringify(result.steps[0]?.request.messages)).not.toContain(CUIT);
  });

  it("can leave tool results visible while still redacting the prompt", async () => {
    const seen: ModelGenerateInput[] = [];
    const model = capturingModel([{
      text: "ok",
      messages: [{ role: "assistant", parts: [{ type: "text", text: "ok" }] }],
      finishReason: "stop"
    }], seen);
    await generateText({
      model,
      prompt: CUIT,
      redaction: { policy: createLatamSensitiveDataPolicy(), toolResults: false, output: false }
    });
    expect(JSON.stringify(seen[0]?.messages)).toContain("[REDACTED:CUIT]");
  });

  it("leaves text unchanged when redaction is false", async () => {
    const seen: ModelGenerateInput[] = [];
    const model = capturingModel([{
      text: CUIT,
      messages: [{ role: "assistant", parts: [{ type: "text", text: CUIT }] }],
      finishReason: "stop"
    }], seen);
    const result = await generateText({ model, prompt: CUIT, redaction: false });
    expect(JSON.stringify(seen[0]?.messages)).toContain(CUIT);
    expect(result.text).toBe(CUIT);
  });

  it("accepts a redaction option bag for prompts", async () => {
    const seen: ModelGenerateInput[] = [];
    const model = capturingModel([{
      text: "ok",
      messages: [{ role: "assistant", parts: [{ type: "text", text: "ok" }] }],
      finishReason: "stop"
    }], seen);
    await generateText({
      model,
      prompt: "mail person@example.com",
      redaction: { includeEmails: true }
    });
    expect(JSON.stringify(seen[0]?.messages)).toContain("[REDACTED]");
    expect(JSON.stringify(seen[0]?.messages)).not.toContain("person@example.com");
  });

  it("holds split stream deltas until a check digit can be validated", async () => {
    const secret = `${"a".repeat(60)} ${CUIT} suffix`;
    const deltas = [...secret].map((textDelta) => ({ type: "text-delta" as const, textDelta }));
    const model = createMockLanguageModel({
      streamEvents: [[...deltas, { type: "finish", finishReason: "stop" }]]
    });
    const streamed = streamText({
      model,
      prompt: "stream",
      redaction: createLatamSensitiveDataPolicy()
    });
    let streamedText = "";
    for await (const delta of streamed.textStream) streamedText += delta;
    const collected = await streamed.collect();
    const expected = `${"a".repeat(60)} [REDACTED:CUIT] suffix`;
    expect(streamedText).toBe(expected);
    expect(collected.text).toBe(expected);
    expect(streamedText).not.toContain(CUIT);
  });

  it("publishes redacted tool-call arguments and redacts the tool result", async () => {
    const executed: unknown[] = [];
    const model = createMockLanguageModel({
      streamEvents: [[
        { type: "tool-call", toolCall: { id: "call-1", name: "lookup", input: { account: CUIT } } },
        { type: "finish", finishReason: "tool-calls" }
      ], [
        { type: "text-delta", textDelta: "done" },
        { type: "finish", finishReason: "stop" }
      ]]
    });
    const streamed = streamText({
      model,
      prompt: "lookup",
      maxSteps: 2,
      redaction: createLatamSensitiveDataPolicy(),
      tools: {
        lookup: tool({
          name: "lookup",
          description: "Look up an account",
          schema: z.object({ account: z.string() }),
          execute: async (input) => {
            executed.push(input);
            return { card: CARD_TEXT };
          }
        })
      }
    });
    const events = [];
    for await (const event of streamed.eventStream) events.push(event);
    expect(executed).toEqual([{ account: CUIT }]);
    const toolCall = events.find((event) => event.type === "tool-call");
    expect(toolCall && toolCall.type === "tool-call" ? JSON.stringify(toolCall.toolCall) : "").toContain("[REDACTED:CUIT]");
    const toolResult = events.find((event) => event.type === "tool-result");
    expect(toolResult && toolResult.type === "tool-result" ? JSON.stringify(toolResult.toolResult) : "").toContain("[REDACTED:CARD]");
    expect(JSON.stringify(events)).not.toContain(CARD);
  });
});
