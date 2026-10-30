import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { expect, it } from "vitest";
import { createBedrock } from "../src/index.js";

it("roundtrips Converse through the installed AWS client without provider calls", async () => {
  const requests: Array<{ path: string; body: string; headers: Record<string, string> }> = [];
  const client = new BedrockRuntimeClient({
    region: "us-east-1",
    credentials: { accessKeyId: "offline-access-key", secretAccessKey: "offline-secret" },
    maxAttempts: 1,
    requestHandler: {
      async handle(request) {
        requests.push({ path: request.path, body: String(request.body), headers: request.headers });
        return { response: { statusCode: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify({
          output: { message: { role: "assistant", content: [{ text: "wire response" }] } },
          stopReason: "end_turn",
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          metrics: { latencyMs: 1 }
        })) } };
      }
    }
  });
  try {
    const result = await createBedrock({ client })("anthropic.claude-3-haiku-20240307-v1:0").generate({
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      maxRetries: 0
    });
    expect(result.text).toBe("wire response");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toContain("/converse");
    expect(requests[0]?.headers.authorization).toContain("AWS4-HMAC-SHA256");
    expect(JSON.parse(requests[0]!.body).messages).toEqual([{ role: "user", content: [{ text: "hello" }] }]);
  } finally {
    client.destroy();
  }
});
