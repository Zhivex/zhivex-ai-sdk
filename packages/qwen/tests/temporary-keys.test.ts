import { expect, it, vi } from "vitest";
import { createQwen } from "../src/index.js";
it("exchanges short-lived keys at the configured task host without redirects", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ token: "st-test+/=", expires_at: Math.floor(Date.now() / 1000) + 60 }));
  const qwen = createQwen({ apiKey: "test", baseURL: "https://maas.qwencloudapi.com/compatible-mode/v1", fetch });
  expect((await qwen.temporaryKeys.create()).token).toBe("st-test+/=");
  expect(String(fetch.mock.calls[0]?.[0])).toBe("https://maas.qwencloudapi.com/api/v1/tokens?expire_in_seconds=60");
  expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
  await expect(qwen.temporaryKeys.create({ expiresInSeconds: 1801 })).rejects.toThrow("lifetime");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("rejects invalid token envelopes without disclosing their content", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ token: "sk-sensitive", expires_at: 1 }));
  await expect(createQwen({ apiKey: "test", fetch }).temporaryKeys.create()).rejects.toThrow("Invalid Qwen temporary key response");
});
