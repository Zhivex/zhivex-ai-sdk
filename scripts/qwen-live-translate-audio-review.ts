/** Optional model-based listening review of explicitly generated synthetic audit artifacts. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { createQwen, type QwenRegion } from "../packages/qwen/src/index.js";
import type { ModelMessage } from "@zhivex-ai/core";
const dir = resolve(process.env.QWEN_LIVETRANSLATE_AUDIT_DIR ?? ".release/qwen-live-translate-audit");
const audit = z.object({ targetLanguage: z.string().optional(), runs: z.array(z.object({ mode: z.enum(["baseline", "once", "always", "never"]) })).min(1).max(4) }).parse(JSON.parse(await readFile(resolve(dir, "report.json"), "utf8")));
const names = ["source", ...new Set(audit.runs.map(run => run.mode))];
const parts: ModelMessage["parts"] = [];
for (const name of names) {
  const bytes = await readFile(resolve(dir, `${name}.wav`));
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error("Audio review requires bounded synthetic WAV files.");
  parts.push({ type: "text", text: `Clip label: ${name}` }, { type: "audio", data: `data:audio/wav;base64,${bytes.toString("base64")}`, mediaType: "audio/wav" });
}
parts.push({ type: "text", text: `These are synthetic voices, not recordings of a real person. Source is English; the other supplied clips use target language ${audit.targetLanguage ?? "es"}. Compare audible timbre, register, prosody, intelligibility and obvious artifacts, accounting for different languages and volume. Do not infer identity or demographics. Do not assume a clip matches merely because its label says cloning. This is qualitative model-based evidence, not certification. Return only a JSON object: {"comparison":"Spanish explanation", "sourceTimbrePreserved":true|false|null,"intelligibleOutput":true|false|null,"limitations":["..."]}. Use null when unsure.` });
const result = await createQwen({ workspaceId: process.env.QWEN_WORKSPACE_ID, region: process.env.QWEN_REGION as QwenRegion | undefined })("qwen3.8-omni-flash").generate({ messages: [{ role: "user", parts }], reasoning: { effort: "none" }, timeoutMs: 60000, maxRetries: 0 });
const assessment = z.object({ comparison: z.string(), sourceTimbrePreserved: z.boolean().nullable(), intelligibleOutput: z.boolean().nullable(), limitations: z.array(z.string()) }).parse(JSON.parse(result.text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")));
await writeFile(resolve(dir, "model-audio-review.json"), JSON.stringify({ evaluator: "qwen3.8-omni-flash", evaluatedAt: new Date().toISOString(), evidenceClass: "qualitative-model-evaluation-not-human-certification", assessment }, null, 2));
console.log(JSON.stringify({ report: resolve(dir, "model-audio-review.json"), ...assessment }));
