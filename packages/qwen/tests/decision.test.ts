import { describe, it, expect, vi } from "vitest";
import { createQwenDecisionModel } from "../src/decision.js";

const questions = {
  route: { type: "choice", instructions: "Route", criteria: { billing: "Payment", technical: "Bug" } },
  urgent: { type: "noul", instructions: "Urgent?" },
  severity: { type: "score", instructions: "Rate", criteria: ["low", "high"] }
} as const;
const response = () => ({ model: "decision-model-preview", request_id: "req-1", answers: {
  route: { type: "choice", choice: "billing", confidence: 0.8, probabilities: { billing: 0.9, technical: 0.1 } },
  urgent: { type: "noul", noul: 0.2 },
  severity: { type: "score", score: 0.3, confidence: 0.7, legend: { "0": "low", "1": "high" }, probabilities: { "0": 0.7, "1": 0.3 } }
}, usage: { input_tokens: 40 }, latency_ms: 33 });
const setup = (value: unknown = response()) => {
  const fetch = vi.fn(async () => Response.json(value));
  return { fetch, model: createQwenDecisionModel("decision-model-preview", { apiKey: "test", baseURL: "https://maas.qwencloudapi.com/compatible-mode/v1", fetch }) };
};
describe("Qwen Decision", () => {
  it("uses systemone and preserves typed native answers, probabilities and usage", async () => {
    const { model, fetch } = setup();
    const result = await model.decide({ state: { ticket: "Refund" }, questions });
    expect(result.answers.route.choice).toBe("billing");
    expect(result.answers.urgent.noul).toBe(0.2);
    expect(result.answers.severity.score).toBe(0.3);
    expect(result).toMatchObject({ requestId: "req-1", usage: { inputTokens: 40 }, latencyMs: 33 });
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://maas.qwencloudapi.com/compatible-mode/v1/systemone");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body as string)).toEqual({ model: model.modelId, state: { ticket: "Refund" }, questions });
  });
  it.each([
    (r: any) => { delete r.answers.urgent; },
    (r: any) => { r.answers.extra = {}; },
    (r: any) => { r.answers.route.choice = "unknown"; },
    (r: any) => { r.answers.route.probabilities.billing = 3; },
    (r: any) => { r.answers.route.probabilities.billing = 0.1; },
    (r: any) => { r.answers.urgent.noul = -0.1; },
    (r: any) => { r.answers.severity.legend["0"] = "wrong"; },
    (r: any) => { r.answers.severity.score = 2; },
    (r: any) => { r.usage.input_tokens = -1; },
    (r: any) => { r.model = "wrong"; }
  ])("rejects malformed provider output", async mutate => {
    const r = response(); mutate(r);
    await expect(setup(r).model.decide({ state: "test", questions })).rejects.toThrow("Qwen decision");
  });
  it.each([{}, { a: { type: "choice", instructions: "test", criteria: {} } }, { a: { type: "score", instructions: "test", criteria: ["one"] } }, { a: { type: "noul", instructions: "test", stream: true } }])("rejects invalid questions before I/O", async invalid => {
    const { model, fetch } = setup();
    await expect(model.decide({ state: "test", questions: invalid as any })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not retry billable calls by default, and sanitizes failures", async () => {
    const fetch = vi.fn(async () => new Response("sensitive state", { status: 503 }));
    const model = createQwenDecisionModel("decision-model-preview", { apiKey: "test", baseURL: "https://example.com", fetch });
    await expect(model.decide({ state: "test", questions })).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockClear();
    await expect(model.decide({ state: "test", questions, maxRetries: 1, retryBackoffMs: 0 })).rejects.toThrow("503");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects credential-unsafe endpoints and invalid models", () => {
    expect(() => createQwenDecisionModel("wrong", { apiKey: "test", baseURL: "https://example.com" })).toThrow();
    expect(() => createQwenDecisionModel("decision-model-preview", { apiKey: "test", baseURL: "http://127.0.0.1" })).toThrow();
  });
  it("bounds response bodies", async () => {
    await expect(setup({ filler: "x".repeat(1024 * 1024) }).model.decide({ state: "test", questions })).rejects.toThrow();
  });
  it("aborts an in-flight request", async () => {
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true })));
    const model = createQwenDecisionModel("decision-model-preview", { apiKey: "test", baseURL: "https://example.com", fetch: fetch as typeof globalThis.fetch });
    await expect(model.decide({ state: "test", questions, timeoutMs: 5 })).rejects.toThrow();
  });
});
