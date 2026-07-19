import { describe, expect, it, vi } from "vitest";

import {
  cancelInteraction,
  deleteInteraction,
  googleMapsTool,
  type Interaction,
  type ProviderAdapter
} from "../src/index.js";

const interaction: Interaction = {
  id: "interaction-1",
  status: "cancelled"
};

const createProvider = () => {
  const cancel = vi.fn(async () => interaction);
  const deleteInteractionRequest = vi.fn(async () => ({ id: interaction.id }));

  const provider = {
    name: "test",
    languageModel: () => {
      throw new Error("not used");
    },
    interactions: {
      create: vi.fn(),
      get: vi.fn(),
      cancel,
      delete: deleteInteractionRequest,
      stream: vi.fn()
    }
  } as unknown as ProviderAdapter;

  return { provider, cancel, deleteInteractionRequest };
};

describe("Google helpers", () => {
  it("creates a Google Maps hosted tool with location and widget configuration", () => {
    expect(
      googleMapsTool({
        latitude: -34.6037,
        longitude: -58.3816,
        enableWidget: true
      })
    ).toMatchObject({
      kind: "hosted",
      name: "google_maps",
      type: "googleMaps",
      toolClass: "web-search",
      config: {
        latitude: -34.6037,
        longitude: -58.3816,
        enableWidget: true
      }
    });
  });

  it("delegates interaction cancellation and deletion", async () => {
    const { provider, cancel, deleteInteractionRequest } = createProvider();

    await expect(cancelInteraction({ provider, id: interaction.id })).resolves.toEqual(interaction);
    await expect(deleteInteraction({ provider, id: interaction.id })).resolves.toEqual({ id: interaction.id });
    expect(cancel).toHaveBeenCalledWith({ id: interaction.id });
    expect(deleteInteractionRequest).toHaveBeenCalledWith({ id: interaction.id });
  });

  it("rejects interaction lifecycle helpers when the provider has no client", async () => {
    const provider = {
      name: "test",
      languageModel: () => {
        throw new Error("not used");
      }
    } as ProviderAdapter;

    await expect(cancelInteraction({ provider, id: interaction.id })).rejects.toThrow(
      'Provider "test" does not support interactions.'
    );
    await expect(deleteInteraction({ provider, id: interaction.id })).rejects.toThrow(
      'Provider "test" does not support interactions.'
    );
  });
});
