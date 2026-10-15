import { createRedactionPolicy, type RedactionPolicy, type RedactionPolicyOptions, type RedactionRule } from "./safety-policy.js";

/** Technical detector countries. These presets are not a legal-compliance determination. */
export type LatamCountry = "AR" | "BR" | "CL" | "MX";

export interface LatamSensitiveDataPolicyOptions extends Omit<RedactionPolicyOptions, "rules"> {
  /** Defaults to Argentina, Brazil, Chile, and Mexico. */
  countries?: readonly LatamCountry[];
  /** Payment card numbers checked with Luhn. Defaults to true. */
  includeCards?: boolean;
  rules?: RedactionRule[];
}

const CUIT_PREFIXES = new Set(["20", "23", "24", "27", "30", "33", "34"]);
const CUIT_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
const CBU_WEIGHTS_A = [7, 1, 3, 9, 7, 1, 3];
const CBU_WEIGHTS_B = [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3];
const CNPJ_WEIGHTS_A = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_WEIGHTS_B = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const RFC_ALPHABET = "0123456789ABCDEFGHIJKLMN&OPQRSTUVWXYZ Ñ";
const CURP_ALPHABET = "0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ";

const digitsOnly = (value: string) => value.replace(/\D/g, "");

const weightedSum = (digits: string, weights: readonly number[]) => {
  let sum = 0;
  for (let index = 0; index < weights.length; index += 1) {
    sum += Number(digits[index]) * weights[index];
  }
  return sum;
};

export const cuitCheckDigit = (first10: string): number => {
  const remainder = weightedSum(first10, CUIT_WEIGHTS) % 11;
  const check = 11 - remainder;
  if (check === 11) return 0;
  if (check === 10) return 9;
  return check;
};

export const isValidCuit = (value: string): boolean => {
  if (!/^\d{2}-\d{8}-\d$/.test(value)) return false;
  const digits = digitsOnly(value);
  if (!CUIT_PREFIXES.has(digits.slice(0, 2))) return false;
  return cuitCheckDigit(digits.slice(0, 10)) === Number(digits[10]);
};

const mod10Check = (digits: string, weights: readonly number[]) => (10 - (weightedSum(digits, weights) % 10)) % 10;

export const isValidCbu = (value: string): boolean => {
  if (!/^\d{22}$/.test(value) || value.startsWith("000")) return false;
  return mod10Check(value.slice(0, 7), CBU_WEIGHTS_A) === Number(value[7]) &&
    mod10Check(value.slice(8, 21), CBU_WEIGHTS_B) === Number(value[21]);
};

export const isValidCvu = (value: string): boolean => {
  if (!/^000\d{19}$/.test(value)) return false;
  return mod10Check(value.slice(0, 7), CBU_WEIGHTS_A) === Number(value[7]) &&
    mod10Check(value.slice(8, 21), CBU_WEIGHTS_B) === Number(value[21]);
};

const repeatedDigits = (digits: string) => /^(\d)\1+$/.test(digits);

const trailingCheckDigit = (base: string): number => {
  let sum = 0;
  for (let index = 0; index < base.length; index += 1) {
    sum += Number(base[index]) * (base.length + 1 - index);
  }
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
};

export const cpfCheckDigits = (first9: string): string => {
  const first = trailingCheckDigit(first9);
  const second = trailingCheckDigit(`${first9}${first}`);
  return `${first}${second}`;
};

export const isValidCpf = (value: string): boolean => {
  if (!/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(value)) return false;
  const digits = digitsOnly(value);
  if (repeatedDigits(digits)) return false;
  return cpfCheckDigits(digits.slice(0, 9)) === digits.slice(9);
};

const cnpjDigit = (base: string): number => {
  const weights = base.length === 12 ? CNPJ_WEIGHTS_A : CNPJ_WEIGHTS_B;
  const remainder = weightedSum(base, weights) % 11;
  return remainder < 2 ? 0 : 11 - remainder;
};

export const cnpjCheckDigits = (first12: string): string => {
  const first = cnpjDigit(first12);
  const second = cnpjDigit(`${first12}${first}`);
  return `${first}${second}`;
};

export const isValidCnpj = (value: string): boolean => {
  if (!/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/.test(value)) return false;
  const digits = digitsOnly(value);
  if (repeatedDigits(digits)) return false;
  return cnpjCheckDigits(digits.slice(0, 12)) === digits.slice(12);
};

export const rutCheckDigit = (body: string): string => {
  let sum = 0;
  let factor = 2;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    sum += Number(body[index]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const check = 11 - (sum % 11);
  if (check === 11) return "0";
  if (check === 10) return "K";
  return String(check);
};

export const isValidRut = (value: string): boolean => {
  const match = /^(\d{1,2})\.(\d{3})\.(\d{3})-([\dkK])$/.exec(value);
  if (!match) return false;
  const body = `${match[1]}${match[2]}${match[3]}`;
  return rutCheckDigit(body) === match[4].toUpperCase();
};

export const curpCheckDigit = (body17: string): string => {
  let sum = 0;
  for (let index = 0; index < body17.length; index += 1) {
    const value = CURP_ALPHABET.indexOf(body17[index] ?? "");
    if (value < 0) return "";
    sum += value * (18 - index);
  }
  return String((10 - (sum % 10)) % 10);
};

const CURP_PATTERN = /^[A-Z][AEIOUX][A-Z]{2}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[HM](?:AS|BC|BS|CC|CL|CM|CS|CH|DF|DG|GT|GR|HG|JC|MC|MN|MS|NT|NL|OC|PL|QT|QR|SP|SL|SR|TC|TS|TL|VZ|YN|ZS|NE)[B-DF-HJ-NP-TV-Z]{3}[A-Z0-9]\d$/;

export const isValidCurp = (value: string): boolean => {
  if (!CURP_PATTERN.test(value)) return false;
  return curpCheckDigit(value.slice(0, 17)) === value[17];
};

export const rfcCheckDigit = (body: string): string => {
  let sum = 0;
  for (let index = 0; index < body.length; index += 1) {
    const value = RFC_ALPHABET.indexOf(body[index] ?? "");
    if (value < 0) return "";
    sum += value * (body.length + 1 - index);
  }
  const check = 11 - (sum % 11);
  if (check === 11) return "0";
  if (check === 10) return "A";
  return String(check);
};

const plausibleDate = (month: string, day: string) => {
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  return monthNumber >= 1 && monthNumber <= 12 && dayNumber >= 1 && dayNumber <= 31;
};

export const isValidRfc = (value: string): boolean => {
  const match = /^([A-ZÑ&]{3,4})(\d{2})(\d{2})(\d{2})([A-Z0-9]{3})$/.exec(value);
  if (!match || !plausibleDate(match[3], match[4])) return false;
  const body = value.slice(0, -1);
  return rfcCheckDigit(body) === value[value.length - 1];
};

export const luhnIsValid = (digits: string): boolean => {
  if (!/^\d{13,19}$/.test(digits) || repeatedDigits(digits)) return false;
  let sum = 0;
  let alternate = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let current = Number(digits[index]);
    if (alternate) {
      current *= 2;
      if (current > 9) current -= 9;
    }
    sum += current;
    alternate = !alternate;
  }
  return sum % 10 === 0;
};

export const isValidCard = (value: string): boolean => {
  const separated = /[ -]/.test(value);
  const digits = digitsOnly(value);
  if (!separated && digits.length !== 16) return false;
  if (digits.length < 13 || digits.length > 19) return false;
  return luhnIsValid(digits);
};

const keepOrRedact = (match: string, valid: boolean, label: string) => valid ? `[REDACTED:${label}]` : match;

const rule = (name: string, pattern: RegExp, validate: (match: string) => boolean, label: string): RedactionRule => ({
  name,
  pattern,
  replacement: (match: string) => keepOrRedact(match, validate(match), label)
});

const countryRules = (countries: ReadonlySet<LatamCountry>): RedactionRule[] => {
  const rules: RedactionRule[] = [];
  if (countries.has("AR")) {
    rules.push(
      rule("cuit", /(?<!\d)\d{2}-\d{8}-\d(?!\d)/g, isValidCuit, "CUIT"),
      {
        name: "cbu",
        pattern: /(?<!\d)\d{22}(?!\d)/g,
        replacement: (match: string) => {
          if (isValidCvu(match)) return "[REDACTED:CVU]";
          if (isValidCbu(match)) return "[REDACTED:CBU]";
          return match;
        }
      }
    );
  }
  if (countries.has("BR")) {
    rules.push(
      rule("cnpj", /(?<!\d)\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}(?!\d)/g, isValidCnpj, "CNPJ"),
      rule("cpf", /(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g, isValidCpf, "CPF")
    );
  }
  if (countries.has("CL")) {
    rules.push(rule("rut", /(?<!\d)\d{1,2}\.\d{3}\.\d{3}-[\dkK](?!\d)/g, isValidRut, "RUT"));
  }
  if (countries.has("MX")) {
    rules.push(
      rule("curp", /(?<![A-Z0-9])[A-Z][AEIOUX][A-Z]{2}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[HM][A-Z]{2}[B-DF-HJ-NP-TV-Z]{3}[A-Z0-9]\d(?![A-Z0-9])/g, isValidCurp, "CURP"),
      rule("rfc", /(?<![A-Z0-9Ñ&])[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}(?![A-Z0-9Ñ&])/g, isValidRfc, "RFC")
    );
  }
  return rules;
};

const cardRule = (): RedactionRule => rule(
  "card",
  /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
  isValidCard,
  "CARD"
);

const ALL_COUNTRIES: readonly LatamCountry[] = ["AR", "BR", "CL", "MX"];

/**
 * Redaction preset for Latin American identifiers and payment cards.
 * A match is removed only when its check digit is valid. This is a technical
 * detector, not legal advice and not a determination of compliance with
 * Argentina's Personal Data Protection Act or Brazil's LGPD.
 */
export const createLatamSensitiveDataPolicy = (options: LatamSensitiveDataPolicyOptions = {}): RedactionPolicy => {
  const countries = new Set(options.countries ?? ALL_COUNTRIES);
  for (const country of countries) {
    if (!ALL_COUNTRIES.includes(country)) {
      throw new TypeError(`Unknown LatAm detector country "${country}".`);
    }
  }
  const rules = [
    ...countryRules(countries),
    ...(options.includeCards === false ? [] : [cardRule()]),
    ...(options.rules ?? [])
  ];
  return createRedactionPolicy({
    includeEmails: options.includeEmails,
    replacement: options.replacement,
    rules
  });
};
