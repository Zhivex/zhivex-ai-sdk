import { describe, expect, it } from "vitest";

import { runGovernedQuickstart } from "../../../examples/sdk/governed-quickstart";

describe("governed quickstart", () => {
  it("runs against a mock provider without a network call", async () => {
    await runGovernedQuickstart();
  });
});
