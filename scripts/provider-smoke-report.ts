import { integrationProviderStatuses } from "../packages/core/tests/integration-registry.ts";

const capabilityLabels = (supports: (typeof integrationProviderStatuses)[number]["supports"]): string[] => {
  const labels = ["generateText"];

  if (supports.streaming) {
    labels.push("streamText");
  }
  if (supports.tools) {
    labels.push("tools");
  }
  if (supports.structuredOutputMode) {
    labels.push(`structured output (${supports.structuredOutputMode})`);
  }
  if (supports.embeddings) {
    labels.push("embeddings");
  }
  if (supports.reasoning) {
    labels.push("reasoning");
  }

  return labels;
};

const tableRow = (values: string[]) => `| ${values.join(" | ")} |`;

const readyProviders = integrationProviderStatuses.filter((provider) => provider.status === "ready");
const skippedProviders = integrationProviderStatuses.filter((provider) => provider.status === "skipped_missing_credentials");

console.log("# Zhivex AI SDK Provider Smoke Report");
console.log("");
console.log(`Generated: ${new Date().toISOString()}`);
console.log("");
console.log(`Ready providers: ${readyProviders.length}/${integrationProviderStatuses.length}`);
console.log(`Skipped providers: ${skippedProviders.length}/${integrationProviderStatuses.length}`);
console.log("");
console.log(tableRow(["Provider", "Status", "Text model", "Capabilities", "Missing requirements"]));
console.log(tableRow(["---", "---", "---", "---", "---"]));

for (const provider of integrationProviderStatuses) {
  console.log(
    tableRow([
      provider.name,
      provider.status,
      provider.textModelId,
      capabilityLabels(provider.supports).join(", "),
      provider.missingRequirements.length ? provider.missingRequirements.join("; ") : "none"
    ])
  );
}

console.log("");

if (readyProviders.length) {
  console.log("Providers marked ready will be exercised by `bun run test:integration`.");
} else {
  console.log("No providers are configured. `bun run test:integration` will skip live provider cases.");
}

console.log("This report exits with code 0 even when providers are skipped because missing credentials are expected locally.");
