import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { writePrivateFile } from "../src/store-security.js";

describe("private store files", () => {
  it("tightens existing permissions before replacing content", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zhivex-private-store-"));
    const file = path.join(directory, "state.json");
    await fs.writeFile(file, "old", { mode: 0o644 });

    await writePrivateFile(file, "new");

    expect(await fs.readFile(file, "utf8")).toBe("new");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
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
