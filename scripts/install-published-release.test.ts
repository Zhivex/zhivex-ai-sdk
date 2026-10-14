import { describe, expect, it } from "vitest";

import {
  dependencySpecifiers,
  installPublishedRelease,
  parsePublishedReleaseBatch,
  publishedInstallDelayMs
} from "./install-published-release";

describe("published release install", () => {
  it("accepts only workspace package versions from the release batch", () => {
    expect(parsePublishedReleaseBatch([
      "@zhivex-ai/sdk@1.32.1",
      "@zhivex-ai/core@1.32.0-next.1"
    ])).toEqual([
      "@zhivex-ai/core@1.32.0-next.1",
      "@zhivex-ai/sdk@1.32.1"
    ]);
    expect(parsePublishedReleaseBatch([])).toEqual([]);
    expect(() => parsePublishedReleaseBatch(["left-pad@1.0.0"])).toThrow(
      "Refusing unexpected release batch entry: left-pad@1.0.0"
    );
  });

  it("maps package versions to exact public install dependencies", () => {
    expect(dependencySpecifiers(["@zhivex-ai/sdk@1.32.1"])).toEqual({
      "@zhivex-ai/sdk": "1.32.1"
    });
  });

  it("backs off registry propagation and then stops growing", () => {
    expect(publishedInstallDelayMs(1)).toBe(5_000);
    expect(publishedInstallDelayMs(2)).toBe(10_000);
    expect(publishedInstallDelayMs(3)).toBe(20_000);
    expect(publishedInstallDelayMs(4)).toBe(30_000);
    expect(publishedInstallDelayMs(8)).toBe(30_000);
  });

  it("retries a public install until the registry serves the published versions", async () => {
    const delays: number[] = [];
    let failures = 2;
    const attempt = await installPublishedRelease({
      specifiers: ["@zhivex-ai/sdk@1.32.1"],
      maxAttempts: 4,
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
      install: () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("npm error code E404");
        }
      },
      sleep: async (delayMs) => {
        delays.push(delayMs);
      }
    });

    expect(attempt).toBe(3);
    expect(delays).toEqual([5, 10]);
  });

  it("skips install work when the release batch is empty", async () => {
    const attempt = await installPublishedRelease({
      specifiers: [],
      install: () => {
        throw new Error("should not install");
      },
      sleep: async () => {
        throw new Error("should not wait");
      }
    });

    expect(attempt).toBe(0);
  });

  it("fails after the registry stays unavailable", async () => {
    await expect(installPublishedRelease({
      specifiers: ["@zhivex-ai/sdk@1.32.1"],
      maxAttempts: 2,
      install: () => {
        throw new Error("npm error code E404");
      },
      sleep: async () => undefined
    })).rejects.toThrow("npm error code E404");
  });
});
