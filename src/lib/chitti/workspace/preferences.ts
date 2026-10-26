import {
  PROVIDERS,
  providerMeta,
  type ProviderConfig,
  type ProviderId,
} from "../providers";

export type ProviderProfile = Omit<ProviderConfig, "provider"> & {
  remember: boolean;
};
export type ProviderProfiles = Partial<Record<ProviderId, ProviderProfile>>;
export type ProviderPreferences = {
  active: ProviderId;
  profiles: ProviderProfiles;
};
type TabStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const PREFERENCES_KEY = "chitti:providers:v1";
const knownProvider = (value: unknown): value is ProviderId =>
  PROVIDERS.some((p) => p.id === value);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value : "");

// Explicit fields prevent one provider's credentials or model flags leaking into another.
export function providerProfile(
  provider: ProviderId,
  value: unknown = {},
): ProviderProfile {
  const p = record(value) ? value : {};
  return {
    model: text(p.model) || providerMeta(provider).models[0]?.id || "",
    apiKey: provider === "chatgpt" ? "" : text(p.apiKey),
    chatgptAccount:
      provider === "chatgpt" ? text(p.chatgptAccount) || undefined : undefined,
    requestReasoning: provider === "openrouter" && p.requestReasoning === true,
    remember: provider !== "chatgpt" && p.remember === true,
  };
}

export function selectProvider<T extends ProviderConfig>(
  config: T,
  provider: ProviderId,
  profiles: ProviderProfiles,
): T {
  const { remember: _, ...profile } = providerProfile(
    provider,
    profiles[provider],
  );
  return { ...config, provider, ...profile };
}

export function readPreferences(storage: TabStorage): ProviderPreferences {
  const saved = storage.getItem(PREFERENCES_KEY);
  if (saved) {
    try {
      const parsed: unknown = JSON.parse(saved);
      if (
        record(parsed) &&
        knownProvider(parsed.active) &&
        record(parsed.profiles)
      ) {
        const profiles: ProviderProfiles = {};
        for (const { id } of PROVIDERS) {
          if (!record(parsed.profiles[id])) continue;
          const p = providerProfile(id, parsed.profiles[id]);
          profiles[id] = { ...p, apiKey: p.remember ? p.apiKey : "" };
        }
        return { active: parsed.active, profiles };
      }
    } catch {
      /* A damaged record must not prevent key-free data lookups. */
    }
  }
  // Migrate the old single-provider slot without ever assigning its key to a different provider.
  const legacy = storage.getItem("chitti:provider");
  if (!knownProvider(legacy)) return { active: "chatgpt", profiles: {} };
  const key = storage.getItem("chitti:key") || "";
  return {
    active: legacy,
    profiles: {
      [legacy]: providerProfile(legacy, {
        apiKey: key,
        // The old UI persisted model only for ChatGPT, even after switching away.
        model:
          legacy === "chatgpt" ? storage.getItem("chitti:model") : undefined,
        chatgptAccount: storage.getItem("chitti:account"),
        remember: !!key,
      }),
    },
  };
}

export function writePreferences(
  storage: TabStorage,
  active: ProviderId,
  profiles: ProviderProfiles,
) {
  const saved: ProviderProfiles = {};
  for (const { id } of PROVIDERS) {
    if (!profiles[id]) continue;
    const p = providerProfile(id, profiles[id]);
    saved[id] = { ...p, apiKey: p.remember ? p.apiKey : "" };
  }
  storage.setItem(PREFERENCES_KEY, JSON.stringify({ active, profiles: saved }));
  // Only remove legacy storage after the replacement was written successfully.
  for (const key of [
    "chitti:key",
    "chitti:provider",
    "chitti:model",
    "chitti:account",
  ])
    storage.removeItem(key);
}
