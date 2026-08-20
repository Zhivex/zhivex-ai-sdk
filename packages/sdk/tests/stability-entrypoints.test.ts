import { describe, expect, it } from "vitest";

import * as beta from "../src/beta.js";
import * as experimental from "../src/experimental.js";
import { getApiStability } from "../src/index.js";

describe("SDK stability entrypoints", () => {
  it("contains only Beta runtime symbols", () => {
    for (const symbol of Object.keys(beta)) {
      expect(getApiStability(symbol)?.stability, symbol).toBe("beta");
    }
  });

  it("contains only Experimental runtime symbols", () => {
    for (const symbol of Object.keys(experimental)) {
      expect(getApiStability(symbol)?.stability, symbol).toBe("experimental");
    }
  });
});
