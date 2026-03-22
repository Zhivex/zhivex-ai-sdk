import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { type ProviderAdapter } from "@zhivex-ai/core";
export interface BedrockProviderOptions {
    client?: BedrockRuntimeClient;
    region?: string;
}
export declare const createBedrock: (options?: BedrockProviderOptions) => ProviderAdapter;
//# sourceMappingURL=index.d.ts.map