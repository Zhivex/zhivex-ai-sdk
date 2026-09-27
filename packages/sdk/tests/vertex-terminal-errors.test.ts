import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateText, ProviderToolCallError, streamText, tool } from "../src/index.js";
import { createVertex } from "../../vertex/src/index.js";

describe("SDK Vertex tool execution boundary", () => {
  it.each(["MALFORMED_FUNCTION_CALL", "MAX_TOKENS", "UNEXPECTED_TOOL_CALL"])(
    "blocks local tool effects on %s in both generation modes", async (finishReason) => {
      const payload = { candidates: [{ index: 0, content: { parts: [{ functionCall: { name: "echo", args: { value: "test" } } }] }, finishReason }] };
      for (const streaming of [false, true]) {
        const execute = vi.fn(async () => ({ ok: true }));
        const fetcher = vi.fn(async () => streaming ? new Response(`data: ${JSON.stringify(payload)}\n\n`) : Response.json(payload));
        const model = createVertex({ apiKey: "test", fetch: fetcher as typeof fetch })("gemini-2.5-flash-lite");
        const options = { model, prompt: "test", maxSteps: 1, maxRetries: 0,
          tools: { echo: tool({ name: "echo", schema: z.object({ value: z.string() }), execute }) }
        };
        await expect(streaming ? streamText(options).collect() : generateText(options)).rejects.toBeInstanceOf(ProviderToolCallError);
        expect(execute).not.toHaveBeenCalled();
      }
    }
  );
});
