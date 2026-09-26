import { expect, it } from "vitest";
import { createQwenDecisionModel } from "../src/decision.js";

// Explicit opt-in; one tiny inference, no retries. Never log credentials or business state.
it.skipIf(process.env.QWEN_DECISION_LIVE !== "1")("Qwen decision live: all three answer types", async () => {
  const apiKey = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("QWEN_API_KEY or DASHSCOPE_API_KEY is required.");
  const baseURL = process.env.QWEN_DECISION_BASE_URL ?? "https://maas.qwencloudapi.com/compatible-mode/v1";
  const model = createQwenDecisionModel("decision-model-preview", { apiKey, baseURL });
  const result = await model.decide({ state: "Customer requests a refund.", questions: {
    route: { type: "choice", instructions: "Choose team.", criteria: { billing: "Payments", tech: "Bugs" } },
    urgent: { type: "noul", instructions: "Is urgent?" },
    severity: { type: "score", instructions: "Rate severity.", criteria: ["low", "high"] }
  }, maxRetries: 0, timeoutMs: 15000 });
  expect(result.model).toBe("decision-model-preview");
  expect(result.answers.route.choice).toMatch(/^(billing|tech)$/);
  console.info(JSON.stringify({ provider: "qwen", model: result.model, requestId: result.requestId, inputTokens: result.usage.inputTokens, latencyMs: result.latencyMs }));
}, 20000);
