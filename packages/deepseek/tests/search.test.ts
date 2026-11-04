import { describe, expect, it, vi } from "vitest";
import { createDeepSeek } from "../src/index.js";

describe("DeepSeek Search/Fetch", () => {
  it.each(["https://api.deepseek.com", "https://api.deepseek.com/v1", "https://api.deepseek.com/beta"])("uses one v1 prefix for %s and preserves results", async baseURL => {
    const result = { title: "A", content: "# A" };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ results: [] })).mockResolvedValueOnce(Response.json(result));
    const client = createDeepSeek({ apiKey: "test", baseURL, fetch: fetcher });
    expect(await client.search.search({ query: "😀".repeat(128), count: 50, need_content: true, ori_question: null })).toMatchObject({ results: [] });
    expect(await client.search.fetch({ url: "https://example.com/a" })).toMatchObject(result);
    expect(fetcher.mock.calls[0][0]).toBe("https://api.deepseek.com/v1/tools/search");
    expect(fetcher.mock.calls[1][0]).toBe("https://api.deepseek.com/v1/tools/fetch");
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("authorization")).toBe("Bearer test");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ query: "😀".repeat(128), count: 50, need_content: true, ori_question: null });
  });
  it("rejects invalid input before sending and surfaces provider errors", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { message: "blocked" } }, { status: 403 }));
    const client = createDeepSeek({ apiKey: "test", fetch: fetcher });
    for (const query of ["", "  ", "x".repeat(129)]) await expect(client.search.search({ query })).rejects.toThrow();
    for (const count of [0, 51, 1.5]) await expect(client.search.search({ query: "x", count })).rejects.toThrow();
    for (const url of ["file:///etc/passwd", "https://u:p@example.com", "bad"]) await expect(client.search.fetch({ url })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.search.fetch({ url: "https://example.com" })).rejects.toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("retries transient errors and propagates cancellation", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 429 })).mockResolvedValueOnce(Response.json({ results: [] }));
    const client = createDeepSeek({ apiKey: "test", fetch: fetcher });
    await client.search.search({ query: "x", maxRetries: 1, retryBackoffMs: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const controller = new AbortController(); controller.abort();
    await expect(client.search.search({ query: "x", abortSignal: controller.signal })).rejects.toThrow();
  });
});
