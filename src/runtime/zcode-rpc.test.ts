import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractCatalogFromSnapshot, resolveModelTarget } from "./zcode-rpc.js";

const SAMPLE_SNAPSHOT = {
  settings: {
    model: {
      current: {
        providerId: "new-provider",
        modelId: "deepseek-v4.1-flash:1017",
        options: { reasoningLevel: "max" },
      },
      available: [
        {
          ref: { providerId: "new-provider", modelId: "deepseek-v4.1-flash:1017" },
          label: "DeepSeek V4.1 Flash",
          providerLabel: "New Provider",
          contextWindow: 128000,
          maxOutputTokens: 16384,
          reasoning: {
            levels: [
              { value: "low", label: "Low" },
              { value: "high", label: "High" },
              { value: "max", label: "Max" },
            ],
            defaultLevel: "high",
          },
        },
        {
          ref: { providerId: "new-provider-3", modelId: "codekey/gpt-6.1-sol" },
          label: "GPT-6.1 Sol",
          reasoning: { levels: [{ value: "medium", label: "Medium" }] },
        },
        {
          ref: { providerId: "provider-a", modelId: "shared-model" },
          label: "Shared Model",
        },
        {
          ref: { providerId: "provider-b", modelId: "shared-model" },
          label: "Shared Model",
        },
      ],
    },
  },
};

describe("zcode-rpc model catalog and resolution", () => {
  it("extractCatalogFromSnapshot parses current selection and available models", () => {
    const parsed = extractCatalogFromSnapshot(SAMPLE_SNAPSHOT);
    assert.deepEqual(parsed.current, {
      provider_id: "new-provider",
      model_id: "deepseek-v4.1-flash:1017",
      reasoning_level: "max",
    });
    assert.equal(parsed.models.length, 4);
    assert.equal(parsed.models[0]?.reasoning_default_level, "high");
  });

  it("resolveModelTarget resolves unambiguous model_id, provider/model, suffix matches, and default reasoning level", () => {
    const { models } = extractCatalogFromSnapshot(SAMPLE_SNAPSHOT);

    const direct = resolveModelTarget(models, { model_id: "deepseek-v4.1-flash:1017", reasoning_level: "high" });
    assert.deepEqual(direct, {
      providerId: "new-provider",
      modelId: "deepseek-v4.1-flash:1017",
      reasoningLevel: "high",
    });

    const autoDefault = resolveModelTarget(models, { model_id: "new-provider/deepseek-v4.1-flash:1017" });
    assert.deepEqual(autoDefault, {
      providerId: "new-provider",
      modelId: "deepseek-v4.1-flash:1017",
      reasoningLevel: "high",
    });

    const suffix = resolveModelTarget(models, { model_id: "gpt-6.1-sol" });
    assert.deepEqual(suffix, {
      providerId: "new-provider-3",
      modelId: "codekey/gpt-6.1-sol",
      reasoningLevel: "medium",
    });
  });

  it("resolveModelTarget rejects ambiguous model_id, missing model, or unsupported reasoning_level", () => {
    const { models } = extractCatalogFromSnapshot(SAMPLE_SNAPSHOT);

    assert.throws(
      () => resolveModelTarget(models, { model_id: "shared-model" }),
      /MODEL_AMBIGUOUS/,
    );

    const disambiguated = resolveModelTarget(models, { provider_id: "provider-b", model_id: "shared-model" });
    assert.deepEqual(disambiguated, { providerId: "provider-b", modelId: "shared-model" });

    assert.throws(
      () => resolveModelTarget(models, { model_id: "nonexistent-model" }),
      /MODEL_NOT_FOUND/,
    );

    assert.throws(
      () => resolveModelTarget(models, { model_id: "deepseek-v4.1-flash:1017", reasoning_level: "ultra" }),
      /INVALID_REASONING_LEVEL/,
    );
  });
});
