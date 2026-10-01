import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { maintenanceProviders } from "./provider-registry.js";
import { renderProviderMetadata, syncProviderRegistry, validateProviderInventories } from "./sync-provider-registry.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-registry-"));
  temporaryRoots.push(root);
  for (const relative of ["packages/sdk/package.json", "tsconfig.json", "packages/gateway/src/types.ts", "packages/gateway/src/index.ts", "packages/sdk/src/catalog", "packages/sdk/src/provider-templates.generated.ts", ...maintenanceProviders.flatMap(p => [`packages/${p.id}/package.json`, `packages/${p.id}/src/index.ts`])]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await cp(path.join(repoRoot, relative), path.join(root, relative), { recursive: true });
  }
  return root;
}

it("keeps all declared inventories and published CLI metadata aligned", async () => {
  expect(await syncProviderRegistry(repoRoot, true)).toEqual([]);
});

it("refreshes scaffold dependency versions from manifests after versioning, idempotently", async () => {
  const root = await fixture();
  const manifestPath = path.join(root, "packages/openai/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = "99.0.0-next.1";
  await writeFile(manifestPath, JSON.stringify(manifest));
  const sdkManifestPath = path.join(root, "packages/sdk/package.json");
  const sdkManifest = JSON.parse(await readFile(sdkManifestPath, "utf8"));
  sdkManifest.version = "98.0.0-next.2";
  await writeFile(sdkManifestPath, JSON.stringify(sdkManifest));
  expect(await syncProviderRegistry(root, true)).toContain("Generated provider metadata is stale: packages/sdk/src/provider-templates.generated.ts");
  expect(await syncProviderRegistry(root)).toEqual([]);
  expect(await readFile(path.join(root, "packages/sdk/src/provider-templates.generated.ts"), "utf8")).toContain('"packageVersion": "99.0.0-next.1"');
  expect(await readFile(path.join(root, "packages/sdk/src/provider-templates.generated.ts"), "utf8")).toContain('sdkScaffoldVersion: string = "98.0.0-next.2"');
  const generatedSource = await readFile(path.join(root, "packages/sdk/src/provider-templates.generated.ts"), "utf8");
  // Explicit annotations keep declaration snapshots stable across Changesets bumps.
  expect(generatedSource).toContain("readonly packageVersion: string;");
  expect(generatedSource).toContain("export const providerTemplates: Readonly<Record<");
  expect(generatedSource).not.toContain("as const");
  const declarationTemplate = generatedSource.slice(0, generatedSource.indexOf(" = {"))
    .replace(/sdkScaffoldVersion: string = "[^"]+"/, "sdkScaffoldVersion: string");
  expect(declarationTemplate).not.toContain("99.0.0-next.1");
  expect(declarationTemplate).not.toContain("98.0.0-next.2");
  expect(await syncProviderRegistry(root, true)).toEqual([]);
});

it.each([
  ["packages/gateway/src/types.ts", '  | "xai"\n', "GatewayProviderId"],
  ["packages/gateway/src/index.ts", '  "xai",\n', "GATEWAY_PROVIDERS"],
  ["packages/openai/src/index.ts", "export const createOpenAI", "Missing provider factory export"],
  ["packages/sdk/src/catalog/providers/openai.ts", '"modelId": "gpt-6-astra"', "Scaffold default missing from catalog"]
])("detects omitted registry wiring in %s", async (relative, needle, expected) => {
  const root = await fixture();
  const file = path.join(root, relative);
  const source = await readFile(file, "utf8");
  expect(source).toContain(needle);
  await writeFile(file, source.replace(needle, ""));
  expect((await validateProviderInventories(root)).some(error => error.includes(expected))).toBe(true);
});

it("rejects mismatched package identity before generating source", async () => {
  const root = await fixture();
  const manifestPath = path.join(root, "packages/openai/package.json");
  await writeFile(manifestPath, JSON.stringify({ name: "@other/openai", version: "1.0.0" }));
  await expect(renderProviderMetadata(root)).rejects.toThrow("Provider manifest disagrees with registry: openai");
});
