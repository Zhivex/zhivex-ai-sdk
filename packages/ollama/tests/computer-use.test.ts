import { expect, it, vi } from "vitest";

import { runComputerUse } from "@zhivex-ai/core";
import { createOllama } from "../src/index.js";

it("uses the same computer environment with Gemma 4 through Ollama's tool and image contract", async () => {
  const requests: any[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ message: requests.length === 1
      ? { content: "", tool_calls: [{ id: "call-1", function: { name: "computer_action", arguments: { actions: [{ type: "screenshot" }] } } }] }
      : { content: "The page is ready." }, done_reason: requests.length === 1 ? "tool_calls" : "stop" });
  });
  const result = await runComputerUse({
    model: createOllama({ fetch: fetch as typeof globalThis.fetch })("gemma4:12b"),
    prompt: "Inspect the page",
    environment: { viewport: { width: 800, height: 600 }, execute: async () => {}, screenshot: async () => "data:image/png;base64,iVBORw0KGgo=" },
    authorize: () => true
  });

  expect(result.text).toBe("The page is ready.");
  expect(requests[0].tools[0].function.name).toBe("computer_action");
  expect(requests[0].messages.at(-1).images).toHaveLength(1);
  expect(requests[1].messages.some((message: any) => message.role === "tool")).toBe(true);
  expect(requests[1].messages.at(-1).images).toHaveLength(1);
});
