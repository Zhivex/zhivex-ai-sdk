const slsaProvenancePredicate = "https://slsa.dev/provenance/v1";
const npmRegistryOrigin = "https://registry.npmjs.org";
const releaseRepository = "https://github.com/Zhivex/zhivex-ai-sdk";
const releaseWorkflowPath = ".github/workflows/release.yml";
const releaseBranchRef = "refs/heads/main";
const releaseSourceUri = `git+${releaseRepository}@${releaseBranchRef}`;
const gitHeadPattern = /^[a-f0-9]{40}$/;

export interface NpmProvenanceManifest {
  integrity?: string;
  attestations?: {
    url?: string;
    provenance?: {
      predicateType?: string;
    };
  };
}

export interface NpmProvenanceEvidence {
  gitCommit: string;
  invocationId: string;
  subjectSha512: string;
}

interface ProvenanceStatement {
  _type?: string;
  subject?: Array<{
    name?: string;
    digest?: { sha512?: string };
  }>;
  predicateType?: string;
  predicate?: {
    buildDefinition?: {
      externalParameters?: {
        workflow?: {
          ref?: string;
          repository?: string;
          path?: string;
        };
      };
      resolvedDependencies?: Array<{
        uri?: string;
        digest?: { gitCommit?: string };
      }>;
    };
    runDetails?: {
      metadata?: { invocationId?: string };
    };
  };
}

interface NpmAttestationDocument {
  attestations?: Array<{
    predicateType?: string;
    bundle?: {
      dsseEnvelope?: {
        payload?: string;
        payloadType?: string;
      };
    };
  }>;
}

const expectedPackagePurl = (name: string, version: string) =>
  `pkg:npm/${name.split("/").map((part) => encodeURIComponent(part)).join("/")}@${version}`;

const expectedSha512 = (integrity: string) => {
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) {
    throw new Error("npm metadata is missing a valid sha512 integrity digest");
  }
  const digest = Buffer.from(integrity.slice("sha512-".length), "base64");
  if (digest.byteLength !== 64) {
    throw new Error("npm sha512 integrity digest has an invalid length");
  }
  return digest.toString("hex");
};

export const validateNpmAttestationUrl = (
  value: string,
  packageName: string,
  version: string
) => {
  const url = new URL(value);
  const prefix = "/-/npm/v1/attestations/";
  const encodedIdentity = url.pathname.startsWith(prefix)
    ? url.pathname.slice(prefix.length).replace(/\/$/, "")
    : "";

  if (
    url.origin !== npmRegistryOrigin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !encodedIdentity ||
    decodeURIComponent(encodedIdentity) !== `${packageName}@${version}`
  ) {
    throw new Error(`untrusted npm attestation URL for ${packageName}@${version}`);
  }

  return url.toString();
};

export const parseNpmProvenanceEvidence = ({
  packageName,
  version,
  integrity,
  document
}: {
  packageName: string;
  version: string;
  integrity: string;
  document: NpmAttestationDocument;
}): NpmProvenanceEvidence => {
  const attestation = document.attestations?.find(
    (candidate) => candidate.predicateType === slsaProvenancePredicate
  );
  const envelope = attestation?.bundle?.dsseEnvelope;
  if (!envelope?.payload || envelope.payloadType !== "application/vnd.in-toto+json") {
    throw new Error(`npm SLSA provenance envelope is missing for ${packageName}@${version}`);
  }

  let statement: ProvenanceStatement;
  try {
    statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as ProvenanceStatement;
  } catch {
    throw new Error(`npm SLSA provenance payload is invalid for ${packageName}@${version}`);
  }

  if (
    statement._type !== "https://in-toto.io/Statement/v1" ||
    statement.predicateType !== slsaProvenancePredicate
  ) {
    throw new Error(`npm SLSA provenance statement is invalid for ${packageName}@${version}`);
  }

  const subject = statement.subject?.find(
    (candidate) => candidate.name === expectedPackagePurl(packageName, version)
  );
  const registrySha512 = expectedSha512(integrity);
  if (subject?.digest?.sha512 !== registrySha512) {
    throw new Error(`npm SLSA provenance subject does not match ${packageName}@${version} integrity`);
  }

  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  if (
    workflow?.repository !== releaseRepository ||
    workflow.path !== releaseWorkflowPath ||
    workflow.ref !== releaseBranchRef
  ) {
    throw new Error(`npm SLSA provenance was not produced by the protected release workflow`);
  }

  const dependency = statement.predicate?.buildDefinition?.resolvedDependencies?.find(
    (candidate) => candidate.uri === releaseSourceUri
  );
  const gitCommit = dependency?.digest?.gitCommit;
  if (!gitCommit || !gitHeadPattern.test(gitCommit)) {
    throw new Error(`npm SLSA provenance is missing the release commit`);
  }

  const invocationId = statement.predicate?.runDetails?.metadata?.invocationId;
  const invocationPattern = /^https:\/\/github\.com\/Zhivex\/zhivex-ai-sdk\/actions\/runs\/\d+\/attempts\/\d+$/;
  if (!invocationId || !invocationPattern.test(invocationId)) {
    throw new Error(`npm SLSA provenance has an invalid workflow invocation`);
  }

  return { gitCommit, invocationId, subjectSha512: registrySha512 };
};

export const fetchNpmProvenanceEvidence = async ({
  packageName,
  version,
  manifest,
  fetchImpl = fetch
}: {
  packageName: string;
  version: string;
  manifest: NpmProvenanceManifest;
  fetchImpl?: typeof fetch;
}): Promise<NpmProvenanceEvidence> => {
  if (manifest.attestations?.provenance?.predicateType !== slsaProvenancePredicate) {
    throw new Error(`npm metadata is missing SLSA provenance for ${packageName}@${version}`);
  }
  const attestationUrl = manifest.attestations.url;
  if (!attestationUrl) {
    throw new Error(`npm metadata is missing an attestation URL for ${packageName}@${version}`);
  }
  const trustedUrl = validateNpmAttestationUrl(attestationUrl, packageName, version);
  const response = await fetchImpl(trustedUrl, {
    cache: "no-store",
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`${packageName}@${version}: attestation request failed with HTTP ${response.status}`);
  }

  return parseNpmProvenanceEvidence({
    packageName,
    version,
    integrity: manifest.integrity ?? "",
    document: await response.json() as NpmAttestationDocument
  });
};

export const releaseCommitEvidenceMatches = (
  expectedGitHead: string,
  gitHead?: string,
  provenanceGitHead?: string
) => {
  if (!gitHeadPattern.test(expectedGitHead)) {
    return false;
  }
  if (gitHead && gitHead !== expectedGitHead) {
    return false;
  }
  if (provenanceGitHead && provenanceGitHead !== expectedGitHead) {
    return false;
  }
  return gitHead === expectedGitHead || provenanceGitHead === expectedGitHead;
};
