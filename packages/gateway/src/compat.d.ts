import type { ModelMessage } from "@zhivex-ai/core";
import type { GatewayMessage, GatewayModelTarget, GatewayProviderId, GatewayResponse } from "./types.js";
export declare const supportsVisionInput: (provider: GatewayProviderId, modelId: string) => boolean;
export declare const stripImagesForUnsupportedModel: (messages: GatewayMessage[], provider: GatewayProviderId, modelId: string) => GatewayMessage[];
export declare const gatewayMessagesToModelMessages: (messages: GatewayMessage[], systemPrompt?: string) => ModelMessage[];
export declare const createRouteDecision: (mode: GatewayResponse["routeDecision"]["mode"], intent: GatewayResponse["routeDecision"]["intent"], orderedTargets: GatewayModelTarget[]) => GatewayResponse["routeDecision"];
//# sourceMappingURL=compat.d.ts.map