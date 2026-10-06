import { ValidationError } from "./errors.js";

export const validateMaxSteps = (value: number | "unlimited" | undefined): number | "unlimited" => {
  if (value === "unlimited") return value;
  const resolved = value === undefined ? 1 : value;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new ValidationError('"maxSteps" must be a positive safe integer or "unlimited".');
  }
  return resolved;
};
