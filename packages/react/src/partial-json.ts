/**
 * Partial JSON repair for object streams.
 * The steps match streamObject's private repair so text deltas from
 * Output.object / streamObject surface the same partial objects.
 */
const repairPartialJson = (text: string): string | undefined => {
  const start = text.search(/[{\[]/);
  if (start === -1) return undefined;
  const slice = text.slice(start).trim();
  if (!slice) return undefined;

  const closers: string[] = [];
  let inString = false;
  let isEscaped = false;
  let lastToken: "value" | "colon" | "comma" | "other" = "other";

  for (const char of slice) {
    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (char === "\\") {
        isEscaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
        lastToken = "value";
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      closers.push("}");
      lastToken = "other";
      continue;
    }
    if (char === "[") {
      closers.push("]");
      lastToken = "other";
      continue;
    }
    if (char === "}" || char === "]") {
      if (closers.at(-1) === char) closers.pop();
      lastToken = "value";
      continue;
    }
    if (char === ":") {
      lastToken = "colon";
      continue;
    }
    if (char === ",") {
      lastToken = "comma";
      continue;
    }
    if (/\S/.test(char)) lastToken = "value";
  }

  let repaired = slice.trimEnd();
  if (inString) {
    repaired += "\"";
    lastToken = "value";
  }
  if (lastToken === "colon") repaired += " null";
  if (lastToken === "comma") repaired = repaired.replace(/,\s*$/, "");
  return repaired + [...closers].reverse().join("");
};

export const parsePartialJson = (text: string): unknown | undefined => {
  const repaired = repairPartialJson(text);
  if (!repaired) return undefined;
  try {
    return JSON.parse(repaired);
  } catch {
    return undefined;
  }
};
