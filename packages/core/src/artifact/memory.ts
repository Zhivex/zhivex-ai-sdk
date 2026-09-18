import {
  type InMemoryArtifactServiceOptions,
  type ArtifactService,
  resolveArtifactServiceLimits,
  type ArtifactRecord,
  randomId,
  validateArtifactLookup,
  artifactKey,
  assertExpectedRevision,
  createArtifact,
  cloneArtifact,
  bytesFromBinaryInput,
  resolveBinarySha256,
  validateArtifactListInput,
  matchesListInput
} from "./shared.js";

export const createInMemoryArtifactService = (
  options: InMemoryArtifactServiceOptions = {}
): ArtifactService => {
  const limits = resolveArtifactServiceLimits(options.limits);
  const artifacts = new Map<string, ArtifactRecord>();
  const binaryData = new Map<string, Uint8Array>();

  return {
    saveArtifact(input) {
      const id = input.id ?? randomId("art");
      const lookup = {
        appName: input.appName,
        userId: input.userId,
        sessionId: input.sessionId,
        id
      };
      validateArtifactLookup(lookup);
      const existing = artifacts.get(artifactKey(lookup));
      assertExpectedRevision(existing, input.expectedRevision, "ArtifactRecord");
      const artifact = createArtifact({ ...input, id }, limits, existing);
      artifacts.set(artifactKey(lookup), cloneArtifact(artifact));
      binaryData.delete(artifactKey(lookup));
      return cloneArtifact(artifact);
    },

    saveBinaryArtifact(input) {
      const id = input.id ?? randomId("art");
      const lookup = {
        appName: input.appName,
        userId: input.userId,
        sessionId: input.sessionId,
        id
      };
      validateArtifactLookup(lookup);
      const bytes = bytesFromBinaryInput(input.data, limits.maxBinaryBytes);
      const sha256 = resolveBinarySha256(bytes, input.sha256);
      const existing = artifacts.get(artifactKey(lookup));
      assertExpectedRevision(existing, input.expectedRevision, "ArtifactRecord");
      const artifact = createArtifact({
        ...input,
        id,
        data: null,
        encoding: "base64",
        size: bytes.byteLength,
        sha256,
        storageMode: "binary"
      }, limits, existing, { managedBinary: true });
      artifacts.set(artifactKey(lookup), cloneArtifact(artifact));
      binaryData.set(artifactKey(lookup), new Uint8Array(bytes));
      return cloneArtifact(artifact);
    },

    loadArtifact(input) {
      validateArtifactLookup(input);
      const artifact = artifacts.get(artifactKey(input));
      return artifact ? cloneArtifact(artifact) : undefined;
    },

    loadBinaryArtifact(input) {
      validateArtifactLookup(input);
      const artifact = artifacts.get(artifactKey(input));
      const data = binaryData.get(artifactKey(input));
      if (!artifact || !data) {
        return undefined;
      }
      return {
        artifact: cloneArtifact(artifact),
        data: new Uint8Array(data)
      };
    },

    listArtifacts(input) {
      validateArtifactListInput(input);
      return [...artifacts.values()]
        .filter((artifact) => matchesListInput(artifact, input))
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .map(cloneArtifact);
    },

    deleteArtifact(input) {
      validateArtifactLookup(input);
      artifacts.delete(artifactKey(input));
      binaryData.delete(artifactKey(input));
    }
  };
};
