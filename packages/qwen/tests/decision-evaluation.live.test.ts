import { expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { createQwenDecisionModel } from "../src/decision.js";

it.skipIf(process.env.QWEN_DECISION_EVAL !== "1")("decision versus Flash: three synthetic routing cases", async () => {
  const apiKey = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("A Qwen API key is required.");
  const model = createQwenDecisionModel("decision-model-preview", { apiKey, baseURL: process.env.QWEN_DECISION_BASE_URL ?? "https://trial.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" });
  const cases = [
    { id: "billing", state: "Please refund my duplicate card charge. The product works normally. Not urgent.", expected: "billing", urgent: false },
    { id: "incident", state: "Production API is down for all users. Critical ongoing outage. Escalate immediately.", expected: "technical", urgent: true },
    { id: "sales", state: "Please send a price quote for 20 seats next month. No incident or payment issue.", expected: "sales", urgent: false }
  ];
  const rows: unknown[] = [];
  for (const sample of cases) {
    const start = performance.now();
    const result = await model.decide({ state: sample.state, questions: {
      route: { type: "choice", instructions: "Choose responsible team.", criteria: { billing: "Payments and refunds", technical: "Bugs and outages", sales: "Quotes and purchases" } },
      urgent: { type: "noul", instructions: "Is there an urgent ongoing incident requiring immediate escalation?" },
      severity: { type: "score", instructions: "Rate operational impact.", criteria: ["No incident", "Minor issue", "Critical outage"] }
    }, maxRetries: 0, timeoutMs: 15000 });
    rows.push({ case: sample.id, model: result.model, wallMs: Math.round(performance.now() - start), serverMs: result.latencyMs, inputTokens: result.usage.inputTokens, route: result.answers.route.choice, routeCorrect: result.answers.route.choice === sample.expected, urgent: result.answers.urgent.noul, urgentCorrectAtHalf: (result.answers.urgent.noul >= 0.5) === sample.urgent, severity: result.answers.severity.score });
    const flashStart = performance.now();
    const response = await fetch("https://maas.qwencloudapi.com/compatible-mode/v1/chat/completions", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3.8-flash", enable_thinking: false, max_tokens: 100, messages: [
        { role: "system", content: 'Return only JSON: {"route":"billing|technical|sales","urgent":true|false,"severity":0|1|2}. Billing=payments/refunds; technical=bugs/outages; sales=quotes/purchases. Urgent means ongoing incident requiring immediate escalation. Severity: 0=no incident,1=minor,2=critical outage.' },
        { role: "user", content: sample.state }
      ] })
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Flash evaluation HTTP ${response.status}`); }
    const data = await response.json() as any;
    const answer = JSON.parse(data.choices[0].message.content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    rows.push({ case: sample.id, model: "qwen3.8-flash", wallMs: Math.round(performance.now() - flashStart), usage: data.usage, route: answer.route, routeCorrect: answer.route === sample.expected, urgent: answer.urgent, urgentCorrect: answer.urgent === sample.urgent, severity: answer.severity });
  }
  // Only synthetic classification outputs and usage; no credentials or request headers.
  if (process.env.QWEN_DECISION_EVAL_OUTPUT) await writeFile(process.env.QWEN_DECISION_EVAL_OUTPUT, JSON.stringify(rows, null, 2));
  expect(rows).toHaveLength(6);
}, 100000);
