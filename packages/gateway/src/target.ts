import type { GatewayModelTarget } from "./types.js";
export const targetKey = (target: GatewayModelTarget): string => JSON.stringify([target.provider, target.modelId, target.deploymentId ?? null]);
export const sameTarget = (a: GatewayModelTarget, b: GatewayModelTarget): boolean => targetKey(a) === targetKey(b);
