import { describe, expect, it } from "vitest";

import { scanTextForSecrets } from "./scan-secrets.js";

describe("secret scanner", () => {
  it("reports a credential location without exposing its value", () => {
    const secret = ["sk", "proj", "A".repeat(28)].join("-");
    const findings = scanTextForSecrets("fixture.txt", `safe\n${secret}\n`);

    expect(findings).toEqual([{ file: "fixture.txt", line: 2, rule: "provider-secret" }]);
    expect(JSON.stringify(findings)).not.toContain(secret);
  });

  it("does not mistake environment variable names or empty examples for secrets", () => {
    expect(scanTextForSecrets(".env.example", "OPENAI_API_KEY=\nGITHUB_TOKEN=\n")).toEqual([]);
  });
});
