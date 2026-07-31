import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8"
);

describe("release workflow", () => {
  it("passes generated tags between jobs as single-line JSON", () => {
    expect(workflow).toContain("release_tags_json:");
    expect(workflow).toContain("has_release_tags:");
    expect(workflow).toContain('echo "tags_json=$tags_json"');
    expect(workflow).toContain("jq -r '.[]'");
    expect(workflow).not.toContain("release_tags: ${{ steps.collect_release_tags.outputs.tags }}");
  });

  it("creates the aggregate SDK GitHub release after pushing tags", () => {
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("--verify-tag");
    expect(workflow).toContain("--generate-notes");
  });
});
