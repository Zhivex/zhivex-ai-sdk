import { expect, it, vi } from "vitest";
import { createOpenRouter } from "../src/index.js";
import { createAzureOpenAI, azureOpenAIFileSearchTool, azureOpenAIComputerUseTool } from "../../azure-openai/src/index.js";
import { createBedrock } from "../../bedrock/src/index.js";
import { kimiFetchTool, kimiCodeRunnerTool, kimiExcelTool, kimiDateTool } from "../../kimi/src/index.js";

it.each(["azure", "openrouter"])("preserves text alongside image inputs for %s chat requests", async provider => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: "image described" }, finish_reason: "stop" }] }));
  const model = provider === "azure" ? createAzureOpenAI({ apiKey: "test", endpoint: "https://test.openai.azure.com", fetch: fetcher })("gpt-4o-mini") : createOpenRouter({ apiKey: "test", fetch: fetcher })("openai/gpt-4o-mini");
  await model.generate({ messages: [{ role: "user", parts: [{ type: "text", text: "describe" }, { type: "image", image: "https://example.com/image.png" }] }] });
  expect(JSON.parse(fetcher.mock.calls[0]![1].body).messages[0].content).toEqual([{ type: "text", text: "describe" }, { type: "image_url", image_url: { url: "https://example.com/image.png" } }]);
});
it("separates Bedrock system instructions from conversation text", async () => {
  const send = vi.fn().mockResolvedValue({ output: { message: { role: "assistant", content: [{ text: "OK" }] } }, stopReason: "end_turn" });
  const model = createBedrock({ client: { send } as any })("amazon.nova-pro-v1:0");
  await model.generate({ messages: [{ role: "system", parts: [{ type: "text", text: "policy A" }, { type: "text", text: "policy B" }] }, { role: "user", parts: [{ type: "text", text: "hello" }] }] });
  expect(send.mock.calls[0]![0].input).toMatchObject({ system: [{ text: "policy A\npolicy B" }], messages: [{ role: "user", content: [{ text: "hello" }] }] });
});
it("maps Azure executable response items and hosted configuration without executing local effects", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ status: "completed", output: [{ type: "shell_call", call_id: "shell-1", action: { command: "echo hello", max_output_length: 123 } }, { type: "apply_patch_call", call_id: "patch-1", operation: { type: "create_file", path: "example.txt", diff: "+hello" } }] }));
  const model = createAzureOpenAI({ apiKey: "test", endpoint: "https://test.openai.azure.com", fetch: fetcher })("gpt-6-astra");
  const result = await model.generate({ messages: [{ role: "user", parts: [{ type: "text", text: "prepare" }] }], tools: [azureOpenAIFileSearchTool({ vector_store_ids: ["store-1"] }), azureOpenAIComputerUseTool({ display_width: 1024, display_height: 768, environment: "browser" })] });
  const body = JSON.parse(fetcher.mock.calls[0]![1].body);
  expect(body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: "file_search", vector_store_ids: ["store-1"] }), expect.objectContaining({ type: "computer_use_preview", display_width: 1024 })]));
  expect(result.messages[0]!.parts).toEqual(expect.arrayContaining([{ type: "tool-call", toolCall: { id: "shell-1", name: "shell", input: { command: "echo hello", action: { command: "echo hello", max_output_length: 123 }, maxOutputLength: 123 } } }, { type: "tool-call", toolCall: { id: "patch-1", name: "apply_patch", input: { operation: { type: "create_file", path: "example.txt", diff: "+hello" } } } }]));
});
for (const [factory, name, input] of [[kimiFetchTool, "fetch", { url: "https://example.com" }], [kimiCodeRunnerTool, "code_runner", { code: "print(1)" }], [kimiExcelTool, "excel", { file: "example.csv" }], [kimiDateTool, "date", {}]] as const) {
  it(`dispatches the Kimi ${name} Formula contract with approval enabled`, async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ output: "done" }));
    const definition = factory({ apiKey: "test", fetch: fetcher });
    expect(definition.requiresApproval).toBe(true);
    await definition.execute(input);
    expect(String(fetcher.mock.calls[0]![0])).toBe(`https://api.moonshot.ai/v1/formulas/moonshot/${name}:latest/fibers`);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ name, arguments: JSON.stringify(input) });
  });
}
