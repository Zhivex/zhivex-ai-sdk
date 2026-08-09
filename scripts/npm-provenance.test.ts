import { describe, expect, it } from "vitest";

import {
  parseNpmProvenanceEvidence,
  releaseCommitEvidenceMatches,
  validateNpmAttestationUrl
} from "./npm-provenance.js";

const packageName = "@zhivex-ai/core";
const version = "1.1.2";
const gitCommit = "a".repeat(40);
const sha512Bytes = Buffer.alloc(64, 0xab);
const integrity = `sha512-${sha512Bytes.toString("base64")}`;
const sha512 = sha512Bytes.toString("hex");

const provenanceDocument = ({
  subjectSha512 = sha512,
  repository = "https://github.com/Zhivex/zhivex-ai-sdk",
  workflowPath = ".github/workflows/release.yml"
}: {
  subjectSha512?: string;
  repository?: string;
  workflowPath?: string;
} = {}) => ({
  attestations: [{
    predicateType: "https://slsa.dev/provenance/v1",
    bundle: {
      dsseEnvelope: {
        payloadType: "application/vnd.in-toto+json",
        payload: Buffer.from(JSON.stringify({
          _type: "https://in-toto.io/Statement/v1",
          subject: [{
            name: "pkg:npm/%40zhivex-ai/core@1.1.2",
            digest: { sha512: subjectSha512 }
          }],
          predicateType: "https://slsa.dev/provenance/v1",
          predicate: {
            buildDefinition: {
              externalParameters: {
                workflow: {
                  ref: "refs/heads/main",
                  repository,
                  path: workflowPath
                }
              },
              resolvedDependencies: [{
                uri: "git+https://github.com/Zhivex/zhivex-ai-sdk@refs/heads/main",
                digest: { gitCommit }
              }]
            },
            runDetails: {
              metadata: {
                invocationId: "https://github.com/Zhivex/zhivex-ai-sdk/actions/runs/123/attempts/1"
              }
            }
          }
        })).toString("base64")
      }
    }
  }]
});

describe("npm provenance verification", () => {
  it("binds the npm artifact to the protected release workflow and source commit", () => {
    expect(parseNpmProvenanceEvidence({
      packageName,
      version,
      integrity,
      document: provenanceDocument()
    })).toEqual({
      gitCommit,
      invocationId: "https://github.com/Zhivex/zhivex-ai-sdk/actions/runs/123/attempts/1",
      subjectSha512: sha512
    });
  });

  it("rejects a provenance subject that does not match npm integrity", () => {
    expect(() => parseNpmProvenanceEvidence({
      packageName,
      version,
      integrity,
      document: provenanceDocument({ subjectSha512: "b".repeat(128) })
    })).toThrow("provenance subject does not match");
  });

  it("rejects provenance from another repository or workflow", () => {
    expect(() => parseNpmProvenanceEvidence({
      packageName,
      version,
      integrity,
      document: provenanceDocument({ repository: "https://github.com/attacker/repo" })
    })).toThrow("protected release workflow");
    expect(() => parseNpmProvenanceEvidence({
      packageName,
      version,
      integrity,
      document: provenanceDocument({ workflowPath: ".github/workflows/other.yml" })
    })).toThrow("protected release workflow");
  });

  it("requires the official npm attestation endpoint for the exact package version", () => {
    expect(validateNpmAttestationUrl(
      "https://registry.npmjs.org/-/npm/v1/attestations/@zhivex-ai%2fcore@1.1.2",
      packageName,
      version
    )).toBe("https://registry.npmjs.org/-/npm/v1/attestations/@zhivex-ai%2fcore@1.1.2");
    expect(() => validateNpmAttestationUrl(
      "https://attacker.example/-/npm/v1/attestations/@zhivex-ai%2fcore@1.1.2",
      packageName,
      version
    )).toThrow("untrusted npm attestation URL");
  });

  it("accepts a matching provenance commit when gitHead is absent and rejects conflicts", () => {
    expect(releaseCommitEvidenceMatches(gitCommit, undefined, gitCommit)).toBe(true);
    expect(releaseCommitEvidenceMatches(gitCommit, gitCommit, undefined)).toBe(true);
    expect(releaseCommitEvidenceMatches(gitCommit, "b".repeat(40), gitCommit)).toBe(false);
    expect(releaseCommitEvidenceMatches(gitCommit, undefined, undefined)).toBe(false);
  });
});
