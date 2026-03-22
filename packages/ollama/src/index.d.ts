import { type ProviderAdapter } from "@zhivex-ai/core";
export interface OllamaProviderOptions {
    baseURL?: string;
    fetch?: typeof globalThis.fetch;
}
export declare const createOllama: (options?: OllamaProviderOptions) => ProviderAdapter;
//# sourceMappingURL=index.d.ts.map