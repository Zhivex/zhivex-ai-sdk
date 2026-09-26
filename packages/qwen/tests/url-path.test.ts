import { expect, it } from "vitest";
import { trimTrailingSlashes } from "../src/url-path.js";
import { createQwenDecisionModel } from "../src/decision.js";
import { createQwenFileTranscriptionModel } from "../src/native-asr.js";

it.each([['', ''], ['///', ''], ['https://example.com/api///', 'https://example.com/api'], ['https://example.com/a//b', 'https://example.com/a//b']])("trims only the slash suffix of %s", (input, expected) => {
  expect(trimTrailingSlashes(input)).toBe(expected);
});
it("handles long adversarial paths through both public endpoint constructors", () => {
  const path = `https://example.com/${'/'.repeat(500_000)}x`;
  expect(trimTrailingSlashes(path)).toBe(path);
  expect(trimTrailingSlashes(`${path}///`)).toBe(path);
  expect(() => createQwenDecisionModel("decision-model-preview", { apiKey: "test", baseURL: path })).not.toThrow();
  expect(() => createQwenFileTranscriptionModel("qwen-audio-3.0-asr-flash-filetrans", { apiKey: "test", taskBaseURL: path })).not.toThrow();
}, 2000);
