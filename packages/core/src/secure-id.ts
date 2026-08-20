export const createSecureId = (prefix: string): string => {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("Secure IDs require a runtime with the Web Crypto randomUUID API.");
  }
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
};
