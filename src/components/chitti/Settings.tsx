import { useEffect, useRef, useState } from "react";
import {
  PROVIDERS,
  fetchModels,
  providerMeta,
  type ProviderId,
  type ModelOption,
} from "../../lib/chitti/providers";
import { SOURCES } from "../../lib/chitti/tools";
import { classificationBase } from "../../lib/jev/runtime";
import type { Settings as Config } from "../../lib/chitti/workspace/model";
const jevBase = classificationBase(
  import.meta.env.DEV,
  import.meta.env.PUBLIC_JEV_API_URL,
);
export default function Settings({
  value,
  locked,
  onSave,
  onClose,
}: {
  value: Config;
  locked: boolean;
  onSave: (value: Config, remember: boolean) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(value),
    [remember, setRemember] = useState(() => {
      try {
        return !!sessionStorage.getItem("chitti:key");
      } catch {
        return false;
      }
    }),
    [models, setModels] = useState<ModelOption[]>(
      providerMeta(value.provider).models,
    ),
    [status, setStatus] = useState("");
  const loading = useRef(0);
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      loading.current++;
    };
  }, []);
  const changeProvider = (id: ProviderId) => {
    loading.current++;
    setDraft({
      ...draft,
      provider: id,
      model: providerMeta(id).models[0]?.id || "",
      apiKey: "",
      requestReasoning: false,
    });
    setModels(providerMeta(id).models);
    setStatus("");
  };
  const load = async () => {
    const version = ++loading.current;
    setStatus("Reading model catalog…");
    try {
      const list = await fetchModels(draft.provider, draft.apiKey);
      if (version === loading.current) {
        setModels(list);
        setStatus(`${list.length} models available.`);
      }
    } catch {
      if (version === loading.current)
        setStatus("Catalog unavailable. Enter a model ID below.");
    }
  };
  return (
    <dialog
      ref={dialog}
      className="cw-settings"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === dialog.current) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(draft, remember);
        }}
      >
        <header>
          <h2>Model & sources</h2>
          <button type="button" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </header>
        <p>
          Simple lookups work without a model. Analysis uses your chosen
          provider and key.
        </p>
        {locked && (
          <p className="cw-notice">
            This session’s configuration is locked. Start a new analysis to
            change it.
          </p>
        )}
        <fieldset disabled={locked}>
          <label>
            Provider
            <select
              value={draft.provider}
              onChange={(e) => changeProvider(e.target.value as ProviderId)}
            >
              {PROVIDERS.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            API key
            <input
              type="password"
              value={draft.apiKey}
              autoComplete="off"
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            />
          </label>
          <label className="cw-check">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Remember in this tab until it closes
          </label>
          <label>
            Model
            <input
              list="cw-models"
              value={draft.model}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  model: e.target.value,
                  requestReasoning:
                    models.find((m) => m.id === e.target.value)?.reasoning ===
                    true,
                })
              }
            />
            <datalist id="cw-models">
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </datalist>
          </label>
          <button type="button" onClick={() => void load()}>
            Load available models
          </button>
          <p role="status">{status}</p>
          <legend>Data sources</legend>
          <div className="cw-source-options">
            {SOURCES.map((source) => (
              <label className="cw-check" key={source.id}>
                <input
                  type="checkbox"
                  checked={draft.sources.includes(source.id)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      sources: e.target.checked
                        ? [...draft.sources, source.id]
                        : draft.sources.filter((id) => id !== source.id),
                    })
                  }
                />
                {source.label}
              </label>
            ))}
          </div>
          <details>
            <summary>Agent options</summary>
            <label className="cw-check">
              <input
                type="checkbox"
                checked={draft.rlm}
                onChange={(e) => setDraft({ ...draft, rlm: e.target.checked })}
              />
              Allow nested model calls (uses your key)
            </label>
            <label className="cw-check">
              <input
                type="checkbox"
                disabled={!jevBase}
                checked={!!draft.jev}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    jev:
                      e.target.checked && jevBase
                        ? { base: jevBase }
                        : undefined,
                  })
                }
              />
              Use Jev for dataset routing and evidence review
            </label>
            <p>
              Jev sends search candidates and analysis evidence to the hosted
              relay. Credentials and conversation history are excluded.
            </p>
          </details>
        </fieldset>
        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={locked || !draft.sources.length || !draft.model.trim()}
          >
            Apply settings
          </button>
        </footer>
      </form>
    </dialog>
  );
}
