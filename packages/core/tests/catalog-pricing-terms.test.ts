import { describe, expect, it } from "vitest";
import { createModelCatalog } from "../src/catalog.js";
describe("catalog pricing terms", () => {
  it("preserves terms through defensive copies without changing prices over time", () => {
    const terms = { source: "https://example.com/pricing", verifiedAt: "2026-11-04", validThrough: "2026-11-30", notes: "Introductory rate" };
    const catalog = createModelCatalog([{ provider: "test", modelId: "model", inputCostPer1kTokens: .002, pricingTerms: terms }]);
    terms.notes = "changed";
    expect(catalog.find("test", "model")?.pricingTerms?.notes).toBe("Introductory rate");
    catalog.list()[0].pricingTerms!.validThrough = "2027-01-01";
    expect(catalog.find("test", "model")?.pricingTerms?.validThrough).toBe("2026-11-30");
    expect(catalog.find("test", "model")?.inputCostPer1kTokens).toBe(.002);
  });
  it.each([
    { source: "http://example.com", verifiedAt: "2026-11-04" },
    { source: "https://example.com", verifiedAt: "2026-02-30" },
    { source: "https://example.com", verifiedAt: "2026-11-04", validThrough: "2026-11-01" },
    { source: "https://example.com", verifiedAt: "2026-11-04", unknown: true }
  ])("rejects invalid terms %j", pricingTerms => {
    expect(() => createModelCatalog([{ provider: "test", modelId: "model", pricingTerms }])).toThrow();
  });
});
