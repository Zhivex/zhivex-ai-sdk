import { createHash } from "node:crypto";

import { ValidationError } from "./errors.js";
import type {
  AgentExecutionEnvironmentBinding,
  AgentExecutionEnvironmentManifest,
  AgentHarnessBinding
} from "./types.js";

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new ValidationError("Harness fingerprint input must be finite JSON.");
};

const requireNonEmpty = (value: string, name: string) => {
  if (!value.trim()) {
    throw new ValidationError(`${name} must be a non-empty string.`);
  }
};

export const fingerprintAgentHarness = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

export const createAgentHarnessBinding = (options: {
  id: string;
  version: string;
  manifest: unknown;
}): AgentHarnessBinding => {
  requireNonEmpty(options.id, "Agent harness id");
  requireNonEmpty(options.version, "Agent harness version");
  return {
    schemaVersion: 1,
    id: options.id,
    version: options.version,
    fingerprint: fingerprintAgentHarness(options.manifest),
    algorithm: "sha256"
  };
};

export const createAgentExecutionEnvironmentBinding = (
  manifest: AgentExecutionEnvironmentManifest
): AgentExecutionEnvironmentBinding => {
  if (manifest.schemaVersion !== 1) {
    throw new ValidationError("Agent execution environment schemaVersion must be 1.");
  }
  requireNonEmpty(manifest.id, "Agent execution environment id");
  if (manifest.version !== undefined) {
    requireNonEmpty(manifest.version, "Agent execution environment version");
  }
  if (!["host", "process", "container", "microvm", "remote", "custom"].includes(manifest.backend)) {
    throw new ValidationError("Agent execution environment backend is not supported.");
  }
  if (manifest.assurance !== "best-effort" && manifest.assurance !== "enforced") {
    throw new ValidationError("Agent execution environment assurance is not supported.");
  }
  if (!["shared", "per-run", "per-tool-call"].includes(manifest.isolation)) {
    throw new ValidationError("Agent execution environment isolation is not supported.");
  }
  if (manifest.workspace) {
    requireNonEmpty(manifest.workspace.root, "Agent execution environment workspace root");
  }
  return {
    environmentId: manifest.id,
    environmentVersion: manifest.version,
    fingerprint: fingerprintAgentHarness(manifest),
    workspaceId: manifest.workspace?.id
  };
};
