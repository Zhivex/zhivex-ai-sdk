import { expect, it } from "vitest";
import { alignLockWorkspaces, syncLockWorkspaces } from "./sync-lock-workspaces.js";

const root = new URL("../", import.meta.url).pathname;
const snapshot = `{
  "lockfileVersion": 1,
  "workspaces": {
    "packages/sdk": {
      "name": "@zhivex-ai/sdk", "version": "1.30.0",
      "dependencies": { "@zhivex-ai/core": "~1.29.0", "zod": "^4.6.3", },
    },
  },
  "packages": { "zod": ["zod@4.6.5", "", {}, "sha512-unchanged"], },
}`;
const manifests = { "packages/sdk": { name: "@zhivex-ai/sdk", version: "1.30.1", dependencies: { "@zhivex-ai/core": "~1.30.0", zod: "^4.6.3" } } };

it("repairs version and internal range drift without touching a single external byte", () => {
  const result = alignLockWorkspaces(snapshot, manifests);
  expect(result).toBe(snapshot.replace('"1.30.0"', '"1.30.1"').replace('"~1.29.0"', '"~1.30.0"'));
  expect(alignLockWorkspaces(result, manifests)).toBe(result);
});

it("fails closed when external ranges or workspace inventory require a real Bun resolution", () => {
  expect(() => alignLockWorkspaces(snapshot, { "packages/sdk": { ...manifests["packages/sdk"], dependencies: { ...manifests["packages/sdk"].dependencies, zod: "^5.0.0" } } })).toThrow("External dependency changed");
  expect(() => alignLockWorkspaces(snapshot, {})).toThrow("Workspace inventory changed");
  expect(() => alignLockWorkspaces(snapshot, { "packages/sdk": { ...manifests["packages/sdk"], dependencies: {} } })).toThrow("Dependency inventory changed");
});

it("keeps every committed workspace snapshot aligned with its versioned manifest", async () => {
  await expect(syncLockWorkspaces(root, true)).resolves.toBe(false);
});
