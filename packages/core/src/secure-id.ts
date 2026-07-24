import { randomUUID } from "node:crypto";

export const createSecureId = (prefix: string): string => `${prefix}_${randomUUID()}`;
