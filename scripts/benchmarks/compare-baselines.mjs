import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
export function compareBaselines(first, second) {
  for (const key of ["schemaVersion", "sourceSha", "runtime", "environment", "hashes", "matrix", "seed", "warmup", "repetitions"]) {
    if (JSON.stringify(first[key]) !== JSON.stringify(second[key])) throw new Error(`Mismatched baseline ${key}`);
  }
  if (first.mode !== "offline" || second.mode !== "offline" || first.rows.length !== second.rows.length || !first.rows.length) throw new Error("Invalid baseline reports");
  return { schemaVersion: 1, sourceSha: first.sourceSha, runtime: first.runtime, status: "proposed-observed-noise-envelope", rows: first.rows.map((row, i) => {
    const other = second.rows[i];
    if (JSON.stringify(row.fixture) !== JSON.stringify(other.fixture) || ![row.p95Ms, other.p95Ms].every(x => Number.isFinite(x) && x > 0)) throw new Error("Mismatched/invalid fixture measurements");
    return { fixture: row.fixture, baselineP95Ms: [row.p95Ms, other.p95Ms], investigateAboveP95Ms: Math.max(row.p95Ms, other.p95Ms) + Math.abs(row.p95Ms - other.p95Ms) };
  }) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [left, right, output] = process.argv.slice(2);
  if (!left || !right || !output) throw new Error("Usage: compare-baselines.mjs first.json second.json output.json");
  const report = compareBaselines(JSON.parse(await readFile(left, "utf8")), JSON.parse(await readFile(right, "utf8")));
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`${report.rows.length} proposed regression bands written to ${output}`);
}
