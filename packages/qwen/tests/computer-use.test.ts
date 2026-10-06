import { expect, it, vi } from "vitest";

import { runComputerUse } from "@zhivex-ai/core";
import { createQwen } from "../src/index.js";

it("runs portable computer use with Qwen 3.8 Flash through vision and callable tools", async () => {
  const requests: any[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ id: `resp-${requests.length}`, status: "completed", output: requests.length === 1
      ? [{ type: "function_call", call_id: "call-1", name: "computer_action", arguments: JSON.stringify({ actions: [{ type: "click", x: 5, y: 9 }] }) }]
      : [{ type: "message", content: [{ type: "output_text", text: "The panel is open." }] }]
    });
  });
  const execute = vi.fn(async () => {});
  const result = await runComputerUse({
    model: createQwen({ apiKey: "test", fetch: fetch as typeof globalThis.fetch })("qwen3.8-flash"),
    prompt: "Open the panel",
    environment: { viewport: { width: 800, height: 600 }, execute, screenshot: async () => "data:image/png;base64,iVBORw0KGgo=" },
    authorize: () => true
  });

  expect(result.text).toBe("The panel is open.");
  expect(execute).toHaveBeenCalledWith([{ type: "click", x: 5, y: 9 }], expect.objectContaining({ signal: expect.any(AbortSignal), toolCallId: "call-1" }));
  expect(requests[0].tools[0].name).toBe("computer_action");
  expect(requests[0].input.at(-1).content[1]).toMatchObject({ type: "input_image" });
  expect(requests[1].input.some((item: any) => item.type === "function_call_output" && item.call_id === "call-1")).toBe(true);
  expect(requests[1].input.at(-1).content[1]).toMatchObject({ type: "input_image" });
});
