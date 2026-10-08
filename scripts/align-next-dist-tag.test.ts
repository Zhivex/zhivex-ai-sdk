import { describe, expect, it } from "vitest";

import { planNextDistTagAlignment } from "./align-next-dist-tag";

describe("next dist-tag alignment", () => {
  it("moves only tags that are older than latest", () => {
    expect(planNextDistTagAlignment([
      { name: "@zhivex-ai/sdk", latest: "1.31.0", next: "1.27.0-next.1" },
      { name: "@zhivex-ai/deepseek", latest: "0.5.7", next: "0.5.7-next.0" },
      { name: "@zhivex-ai/core", latest: "1.31.0", next: "1.32.0-next.0" },
      { name: "@zhivex-ai/agents", latest: "1.11.0", next: "1.11.0" },
      { name: "@zhivex-ai/zai", latest: "0.2.4" }
    ])).toEqual([
      { name: "@zhivex-ai/deepseek", from: "0.5.7-next.0", to: "0.5.7" },
      { name: "@zhivex-ai/sdk", from: "1.27.0-next.1", to: "1.31.0" }
    ]);
  });

  it("rejects package names outside the published scope", () => {
    expect(() => planNextDistTagAlignment([{ name: "left-pad", latest: "1.0.0", next: "0.1.0" }])).toThrow(
      "Refusing unexpected package name: left-pad"
    );
  });
});
