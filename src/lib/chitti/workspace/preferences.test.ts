import { describe, expect, it } from "vitest";
import {
  PREFERENCES_KEY,
  providerProfile,
  readPreferences,
  selectProvider,
  writePreferences,
  type ProviderProfiles,
} from "./preferences";
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
}
const profiles: ProviderProfiles = {
  openrouter: providerProfile("openrouter", {
    apiKey: "router-test-key",
    model: "router-model",
    remember: true,
    requestReasoning: true,
  }),
  openai: providerProfile("openai", {
    apiKey: "openai-test-key",
    model: "openai-model",
    remember: true,
  }),
  anthropic: providerProfile("anthropic", {
    apiKey: "anthropic-test-key",
    model: "anthropic-model",
    remember: false,
  }),
  chatgpt: providerProfile("chatgpt", {
    chatgptAccount: "public-account",
    model: "subscription-model",
  }),
};
describe("provider preferences", () => {
  it("retains opted-in keys independently when ChatGPT is selected and after reload", () => {
    const tab = storage();
    writePreferences(tab, "chatgpt", profiles);
    const loaded = readPreferences(tab);
    expect(loaded.active).toBe("chatgpt");
    expect(loaded.profiles.openrouter).toEqual(profiles.openrouter);
    expect(loaded.profiles.openai).toEqual(profiles.openai);
    expect(loaded.profiles.chatgpt).toEqual(profiles.chatgpt);
    expect(loaded.profiles.anthropic?.apiKey).toBe("");
    expect(tab.getItem(PREFERENCES_KEY)).not.toContain("anthropic-test-key");
    expect(profiles.anthropic?.apiKey).toBe("anthropic-test-key");
  });
  it("selects only the target credential/model while keeping common data preferences", () => {
    const initial = {
      provider: "openrouter" as const,
      ...profiles.openrouter!,
      sources: ["worldbank"],
      rlm: true,
    };
    const subscription = selectProvider(initial, "chatgpt", profiles);
    expect(subscription.apiKey).toBe("");
    expect(subscription.chatgptAccount).toBe("public-account");
    const api = selectProvider(subscription, "openai", profiles);
    expect(api.apiKey).toBe("openai-test-key");
    expect(api.model).toBe("openai-model");
    expect(api.chatgptAccount).toBeUndefined();
    expect(api.requestReasoning).toBe(false);
    expect(api.sources).toEqual(["worldbank"]);
    expect(api.rlm).toBe(true);
    expect(selectProvider(api, "openrouter", profiles).apiKey).toBe(
      "router-test-key",
    );
  });
  it("unremembering one key removes only that stored key", () => {
    const tab = storage();
    writePreferences(tab, "openai", profiles);
    const changed = {
      ...profiles,
      openrouter: { ...profiles.openrouter!, remember: false },
    };
    writePreferences(tab, "chatgpt", changed);
    expect(readPreferences(tab).profiles.openrouter?.apiKey).toBe("");
    expect(readPreferences(tab).profiles.openai?.apiKey).toBe(
      "openai-test-key",
    );
    expect(changed.openrouter.apiKey).toBe("router-test-key");
  });
  it("migrates the existing remembered provider before removing legacy slots", () => {
    const tab = storage();
    tab.setItem("chitti:provider", "openrouter");
    tab.setItem("chitti:key", "legacy-test-key");
    tab.setItem("chitti:model", "legacy-model");
    const old = readPreferences(tab);
    writePreferences(tab, "chatgpt", {
      ...old.profiles,
      chatgpt: profiles.chatgpt,
    });
    expect(readPreferences(tab).profiles.openrouter?.apiKey).toBe(
      "legacy-test-key",
    );
    expect(readPreferences(tab).profiles.openrouter?.model).toBe(
      "legacy-model",
    );
    expect(tab.getItem("chitti:key")).toBeNull();
  });
  it("keeps legacy storage intact if its replacement cannot be written", () => {
    const tab = storage();
    tab.setItem("chitti:key", "legacy-test-key");
    expect(() =>
      writePreferences(
        {
          ...tab,
          setItem: () => {
            throw new Error("quota");
          },
        },
        "openrouter",
        profiles,
      ),
    ).toThrow("quota");
    expect(tab.getItem("chitti:key")).toBe("legacy-test-key");
  });
  it("does not persist unknown fields or OAuth secrets", () => {
    const tab = storage();
    writePreferences(tab, "chatgpt", {
      chatgpt: {
        ...profiles.chatgpt!,
        apiKey: "must-not-store",
        access_token: "secret-token",
        remember: true,
      } as any,
    });
    expect(tab.getItem(PREFERENCES_KEY)).not.toContain("must-not-store");
    expect(tab.getItem(PREFERENCES_KEY)).not.toContain("secret-token");
  });
  it("rejects corrupted/unknown stored providers without breaking the workspace", () => {
    const tab = storage();
    for (const raw of ["{", "null", '{"active":"other","profiles":{}}']) {
      tab.setItem(PREFERENCES_KEY, raw);
      expect(readPreferences(tab)).toEqual({ active: "chatgpt", profiles: {} });
    }
  });
});
