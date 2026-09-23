import { ValidationError } from "./errors.js";

export const validateMaxSteps = (value: number | undefined): number => {
  const resolved = value ?? 1;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new ValidationError('"maxSteps" must be a positive safe integer.');
  }
  return resolved;
};
