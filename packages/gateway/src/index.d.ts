import { type GatewayConfig, type GatewayRequest, type GatewayResponse } from "./types.js";
export declare const createGateway: (config: GatewayConfig) => {
    generate(request: GatewayRequest): Promise<GatewayResponse>;
};
export * from "./compat.js";
export * from "./types.js";
//# sourceMappingURL=index.d.ts.map