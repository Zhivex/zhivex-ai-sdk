/**
 * Complete server runtime surface, including file-backed stores and middleware.
 *
 * The package root remains compatible; this explicit entry point lets portable
 * consumers avoid resolving modules that depend on Node.js built-ins.
 */
export * from "./index.js";
