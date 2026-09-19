import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

const directory = mkdtempSync(join(tmpdir(), "zhivex-stream-rejection-"));
const bundle = join(directory, "fixture.mjs");
beforeAll(() => {
  execFileSync("bun", ["build", resolve(import.meta.dirname, "fixtures/stream-rejection.ts"), "--target=node", `--outfile=${bundle}`], { stdio: "pipe" });
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it.each(["http", "network", "mid-stream", "abort", "error-event"])("observes %s errors for eventStream-only consumers", kind => {
  const output = execFileSync("node", ["--unhandled-rejections=throw", bundle, kind, "events"], { encoding: "utf8" });
  const result = JSON.parse(output);
  expect(result.unhandled).toBe(0);
  expect(result.sameError).toBe(true);
  expect(result.events.filter((type: string) => type === "error")).toHaveLength(1);
  expect(result.events).not.toContain("finish");
});
it("also observes errors for textStream-only consumers", () => {
  const output = execFileSync("node", [bundle, "mid-stream", "text"], { encoding: "utf8" });
  expect(JSON.parse(output)).toMatchObject({ unhandled: 0, sameError: true });
});
