import { describe, expect, it } from "vitest";

import { collectReleaseTags } from "./collect-release-tags.js";

describe("release tag collection", () => {
  const releaseHead = "a".repeat(40);
  const previousHead = "b".repeat(40);

  it("recovers every package published from the release commit after a partial rerun", () => {
    expect(collectReleaseTags(
      [
        { name: "@zhivex-ai/core", version: "1.0.3" },
        { name: "@zhivex-ai/qwen", version: "0.9.2" },
        { name: "@zhivex-ai/sdk", version: "1.0.3" }
      ],
      {
        "@zhivex-ai/core": { versions: { "1.0.3": { gitHead: releaseHead } } },
        "@zhivex-ai/qwen": { versions: { "0.9.2": { gitHead: releaseHead } } },
        "@zhivex-ai/sdk": { versions: { "1.0.3": { gitHead: releaseHead } } }
      },
      releaseHead
    )).toEqual([
      "@zhivex-ai/core@1.0.3",
      "@zhivex-ai/qwen@0.9.2",
      "@zhivex-ai/sdk@1.0.3"
    ]);
  });

  it("does not retag unchanged packages published from an older commit", () => {
    expect(collectReleaseTags(
      [
        { name: "@zhivex-ai/core", version: "1.0.3" },
        { name: "@zhivex-ai/openai", version: "0.9.4" }
      ],
      {
        "@zhivex-ai/core": { versions: { "1.0.3": { gitHead: releaseHead } } },
        "@zhivex-ai/openai": { versions: { "0.9.4": { gitHead: previousHead } } }
      },
      releaseHead
    )).toEqual(["@zhivex-ai/core@1.0.3"]);
  });

  it("recovers tags from provenance when npm omits gitHead", () => {
    expect(collectReleaseTags(
      [{ name: "@zhivex-ai/core", version: "1.0.3" }],
      {
        "@zhivex-ai/core": {
          versions: { "1.0.3": { provenanceGitHead: releaseHead } }
        }
      },
      releaseHead
    )).toEqual(["@zhivex-ai/core@1.0.3"]);
  });

  it("rejects contradictory gitHead and provenance evidence", () => {
    expect(collectReleaseTags(
      [{ name: "@zhivex-ai/core", version: "1.0.3" }],
      {
        "@zhivex-ai/core": {
          versions: {
            "1.0.3": { gitHead: previousHead, provenanceGitHead: releaseHead }
          }
        }
      },
      releaseHead
    )).toEqual([]);
  });

  it("rejects untrusted package identities and git heads", () => {
    expect(() => collectReleaseTags([], {}, "main")).toThrow("Invalid release git head");
    expect(() => collectReleaseTags(
      [{ name: "other-package", version: "1.0.0" }],
      {},
      releaseHead
    )).toThrow("Invalid workspace package identity");
  });
});
