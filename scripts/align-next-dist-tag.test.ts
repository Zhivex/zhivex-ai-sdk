import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  planNextDistTagAlignment,
  refuseDistTagMutation,
  summarizeNextDistTagCheck
} from "./align-next-dist-tag";

const source = readFileSync(new URL("./align-next-dist-tag.ts", import.meta.url), "utf8");

describe("next dist-tag alignment", () => {
  it("reports only tags that are older than latest", () => {
    const planned = planNextDistTagAlignment([
      { name: "@zhivex-ai/sdk", latest: "1.31.0", next: "1.27.0-next.1" },
      { name: "@zhivex-ai/deepseek", latest: "0.5.7", next: "0.5.7-next.0" },
      { name: "@zhivex-ai/core", latest: "1.31.0", next: "1.32.0-next.0" },
      { name: "@zhivex-ai/agents", latest: "1.11.0", next: "1.11.0" },
      { name: "@zhivex-ai/zai", latest: "0.2.4" }
    ]);

    expect(planned).toEqual([
      { name: "@zhivex-ai/deepseek", from: "0.5.7-next.0", to: "0.5.7" },
      { name: "@zhivex-ai/sdk", from: "1.27.0-next.1", to: "1.31.0" }
    ]);
    expect(summarizeNextDistTagCheck(planned)).toEqual({
      status: "warn",
      messages: [
        "@zhivex-ai/deepseek: npm dist-tag next (0.5.7-next.0) is older than latest (0.5.7). Publishing with --tag latest does not move next.",
        "@zhivex-ai/sdk: npm dist-tag next (1.27.0-next.1) is older than latest (1.31.0). Publishing with --tag latest does not move next.",
        "Stale next dist-tags were not moved. This check does not fail the release."
      ]
    });
  });

  it("stays quiet when next is absent or not older than latest", () => {
    expect(summarizeNextDistTagCheck(planNextDistTagAlignment([
      { name: "@zhivex-ai/core", latest: "1.31.0", next: "1.32.0-next.0" },
      { name: "@zhivex-ai/zai", latest: "0.2.4" }
    ]))).toEqual({
      status: "ok",
      messages: ["npm dist-tag next is not older than latest."]
    });
  });

  it("rejects package names outside the published scope", () => {
    expect(() => planNextDistTagAlignment([{ name: "left-pad", latest: "1.0.0", next: "0.1.0" }])).toThrow(
      "Refusing unexpected package name: left-pad"
    );
  });

  it("refuses to mutate dist-tags or require an OIDC token", () => {
    expect(() => refuseDistTagMutation(["--apply"])).toThrow("This check is read-only.");
    expect(() => refuseDistTagMutation(["--check"])).toThrow("This check is read-only.");
    expect(() => refuseDistTagMutation([])).not.toThrow();
    expect(source).not.toContain("execFileSync");
    expect(source).not.toContain("releaseOidcErrors");
    expect(source).not.toContain('["dist-tag", "add"');
    expect(source).toContain("This check does not fail the release.");
  });
});
