import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { writePrivateFile } from "../src/store-security.js";

describe("private store files", () => {
  it("atomically replaces existing content with private permissions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zhivex-private-store-"));
    const file = path.join(directory, "state.json");
    await fs.writeFile(file, "old", { mode: 0o644 });

    await writePrivateFile(file, "new");

    expect(await fs.readFile(file, "utf8")).toBe("new");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("keeps concurrent readers on complete JSON snapshots", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zhivex-private-store-"));
    const file = path.join(directory, "state.json");
    const payload = "x".repeat(256 * 1024);
    await writePrivateFile(file, JSON.stringify({ revision: 0, payload }));

    const writes = Array.from({ length: 20 }, (_, revision) =>
      writePrivateFile(file, JSON.stringify({ revision: revision + 1, payload }))
    );
    const reads = Array.from({ length: 100 }, async () => {
      const snapshot = JSON.parse(await fs.readFile(file, "utf8")) as {
        revision: number;
        payload: string;
      };
      expect(snapshot.revision).toBeGreaterThanOrEqual(0);
      expect(snapshot.payload).toHaveLength(payload.length);
    });

    await Promise.all([...writes, ...reads]);
    expect((await fs.readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses to follow a store-file symlink", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zhivex-private-store-"));
    const target = path.join(directory, "target.json");
    const link = path.join(directory, "state.json");
    await fs.writeFile(target, "untouched");
    await fs.symlink(target, link);

    await expect(writePrivateFile(link, "sensitive")).rejects.toThrow();
    expect(await fs.readFile(target, "utf8")).toBe("untouched");
  });
});
