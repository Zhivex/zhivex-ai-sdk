import { describe, expect, it } from "vitest";

import permanentFailure from "./fixtures/provider-conformance/permanent-failure.json" with { type: "json" };
import missingCredentials from "./fixtures/provider-conformance/missing-credentials.json" with { type: "json" };
import success from "./fixtures/provider-conformance/success.json" with { type: "json" };
import transientFailure from "./fixtures/provider-conformance/transient-failure.json" with { type: "json" };
import {
  compareProviderConformanceReports,
  evaluateProviderConformanceGate,
  getApiStability,
  mergeProviderConformanceReports,
  normalizeProviderConformanceReport,
  renderProviderConformanceMarkdown
} from "../src/index.js";

const beforeExpiry = { now: "2026-08-28T00:00:00.000Z" };

describe("provider conformance reports", () => {
  it("rejects unknown schema versions, states, and incompatible evidence", () => {
    expect(() => normalizeProviderConformanceReport({ ...success, schemaVersion: 2 }, beforeExpiry))
      .toThrow("Unsupported provider conformance report schema version 2");
    expect(() => normalizeProviderConformanceReport({
      ...success,
      providers: [{
        ...success.providers[0],
        results: [{ ...success.providers[0]!.results[0], status: "ready" }]
      }]
    }, beforeExpiry)).toThrow("unknown provider conformance status");
    expect(() => normalizeProviderConformanceReport({
      ...success,
      providers: [{
        ...success.providers[0],
        results: [{ ...success.providers[0]!.results[0], evidence: "offline" }]
      }]
    }, beforeExpiry)).toThrow("incompatible with its evidence level");
    expect(() => normalizeProviderConformanceReport({
      ...success,
      providers: [{
        ...success.providers[0],
        results: [{
          ...success.providers[0]!.results[0],
          endpoint: "https://tenant.example.com/v1?api_key=canary"
        }]
      }]
    }, beforeExpiry)).toThrow("logical endpoint label");
  });

  it("keeps missing credentials as a skip and never treats it as certification", () => {
    const normalized = normalizeProviderConformanceReport(missingCredentials, beforeExpiry);
    expect(normalized.providers[0]!.results[0]).toMatchObject({
      status: "skipped_missing_credentials",
      attempts: 0,
      missingRequirements: ["OPENAI_API_KEY"]
    });
    expect(evaluateProviderConformanceGate(normalized, {
      ...beforeExpiry,
      requirements: [{ provider: "openai", capability: "generateText", evidence: "live" }]
    })).toMatchObject({
      ok: false,
      issues: [{ code: "required_result_not_passed", status: "skipped_missing_credentials" }]
    });
  });

  it("fails closed for transient and permanent required failures", () => {
    for (const fixture of [transientFailure, permanentFailure]) {
      const gate = evaluateProviderConformanceGate(fixture, beforeExpiry);
      expect(gate.ok).toBe(false);
      expect(gate.issues[0]).toMatchObject({
        code: "required_result_not_passed",
        status: "failed"
      });
    }
    expect(normalizeProviderConformanceReport(transientFailure, beforeExpiry)
      .providers[0]!.results[0]!.error?.retryable).toBe(true);
    expect(normalizeProviderConformanceReport(permanentFailure, beforeExpiry)
      .providers[0]!.results[0]!.error?.retryable).toBe(false);
  });

  it("applies TTL automatically while preserving the observed passing state", () => {
    const normalized = normalizeProviderConformanceReport(success, {
      now: "2026-09-04T00:00:00.000Z"
    });
    expect(normalized.providers[0]!.results[0]).toMatchObject({
      status: "stale",
      observedStatus: "live_passed"
    });
    expect(evaluateProviderConformanceGate(normalized, {
      now: "2026-09-04T00:00:00.000Z"
    }).ok).toBe(false);
  });

  it("detects missing and degraded baseline evidence", () => {
    const comparison = compareProviderConformanceReports(success, missingCredentials, beforeExpiry);
    expect(comparison).toMatchObject({
      ok: false,
      regressions: [{
        provider: "openai",
        capability: "generateText",
        baselineStatus: "live_passed",
        currentStatus: "skipped_missing_credentials"
      }]
    });
  });

  it("redacts canary secrets, tokens, emails, errors, and metadata before returning a report", () => {
    const canary = ["sk", "live-canary-abcdefghijklmnopqrstuvwxyz"].join("-");
    const input = {
      ...permanentFailure,
      providers: [{
        ...permanentFailure.providers[0],
        results: [{
          ...permanentFailure.providers[0]!.results[0],
          error: {
            ...permanentFailure.providers[0]!.results[0]!.error,
            message: `Authorization: Bearer ${canary} for owner@example.com`
          },
          metadata: { token: canary, owner: "owner@example.com" }
        }]
      }]
    };
    const serialized = JSON.stringify(normalizeProviderConformanceReport(input, beforeExpiry));
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("owner@example.com");
    expect(serialized).toContain("[REDACTED]");
  });

  it("merges checkout and installed evidence without weakening either layer", () => {
    const installed = {
      ...success,
      reportId: "fixture-installed",
      providers: [{
        provider: "openai",
        results: [{
          ...success.providers[0]!.results[0],
          capability: "package_import",
          evidence: "installed",
          status: "installed_passed",
          required: false,
          artifact: {
            ...success.providers[0]!.results[0]!.artifact,
            kind: "installed"
          }
        }]
      }]
    };
    const merged = mergeProviderConformanceReports([success, installed], beforeExpiry);
    expect(merged.providers[0]!.results.map((result) => result.status))
      .toEqual(["live_passed", "installed_passed"]);
    expect(renderProviderConformanceMarkdown(merged, beforeExpiry))
      .toContain("| openai | package_import | installed | installed_passed |");
  });

  it("merges expired and current evidence with a valid aggregate time range", () => {
    const expired = {
      ...success,
      generatedAt: "2026-08-20T00:00:00.000Z",
      expiresAt: "2026-08-27T00:00:00.000Z",
      providers: [{
        ...success.providers[0],
        results: [{
          ...success.providers[0]!.results[0],
          observedAt: "2026-08-20T00:00:00.000Z",
          expiresAt: "2026-08-27T00:00:00.000Z"
        }]
      }]
    };
    const current = {
      ...success,
      reportId: "fixture-current-installed",
      generatedAt: "2026-08-28T00:00:00.000Z",
      expiresAt: "2026-09-04T00:00:00.000Z",
      providers: [{
        provider: "openai",
        results: [{
          ...success.providers[0]!.results[0],
          capability: "package_import",
          evidence: "installed",
          status: "installed_passed",
          required: false,
          observedAt: "2026-08-28T00:00:00.000Z",
          expiresAt: "2026-09-04T00:00:00.000Z",
          artifact: {
            ...success.providers[0]!.results[0]!.artifact,
            kind: "installed"
          }
        }]
      }]
    };

    const merged = mergeProviderConformanceReports([expired, current], {
      now: "2026-08-28T00:00:00.000Z"
    });

    expect(merged).toMatchObject({
      generatedAt: "2026-08-28T00:00:00.000Z",
      expiresAt: "2026-09-04T00:00:00.000Z"
    });
    expect(merged.providers[0]!.results.map((result) => result.status))
      .toEqual(["stale", "installed_passed"]);
  });

  it("exports the report contract as Beta from Core", () => {
    expect(getApiStability("PROVIDER_CONFORMANCE_REPORT_SCHEMA_VERSION")?.stability).toBe("beta");
    expect(getApiStability("evaluateProviderConformanceGate")?.stability).toBe("beta");
  });
});
