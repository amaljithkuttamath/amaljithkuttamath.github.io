import ChatGPTConnection from "./ChatGPTConnection";
import { useEffect, useRef, useState } from "react";
import {
  PROVIDERS,
  loadModelCatalog,
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
  newChat,
  onSave,
  onClose,
}: {
  value: Config;
  locked: boolean;
  newChat: boolean;
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
      chatgptAccount: undefined,
      requestReasoning: false,
    });
    setModels(providerMeta(id).models);
    setStatus("");
  };
  const load = async (refresh = true) => {
    const version = ++loading.current;
    setStatus("Reading model catalog…");
    try {
      const { models: list, fallback } = await loadModelCatalog(
        draft.provider,
        draft.apiKey,
        draft.chatgptAccount,
        refresh,
      );
      if (version === loading.current) {
        setModels(list);
        setStatus(fallback ? "Live catalog unavailable. Retry to load more models." : `${list.length} models available.`);
      }
    } catch {
      if (version === loading.current)
        setStatus("Could not load models. Check the connection and retry.");
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
          <h2>Model connection</h2>
          <button type="button" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </header>
        {newChat && (
          <p className="cw-notice">
            Applying this connection starts a new chat. Your conversation stays in Recent chats.
          </p>
        )}
        <label>
          Provider
          <select
            disabled={locked}
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
        {draft.provider === "chatgpt" && (
          <ChatGPTConnection
            account={draft.chatgptAccount}
            locked={locked}
            onAccount={(id) => {
              if (!locked) setDraft((d) => ({ ...d, chatgptAccount: id }));
            }}
            onModels={(list) => {
              setModels(list);
              if (!locked)
                setDraft((d) => ({
                  ...d,
                  model: list.some((m) => m.id === d.model)
                    ? d.model
                    : list[0]?.id || "",
                }));
            }}
          />
        )}
        <fieldset disabled={locked}>
          {draft.provider !== "chatgpt" && (
            <>
              <label>
                API key
                <input
                  type="password"
                  value={draft.apiKey}
                  autoComplete="off"
                  onChange={(e) => {
                    loading.current++;
                    setModels(providerMeta(draft.provider).models);
                    setStatus("");
                    setDraft({ ...draft, apiKey: e.target.value });
                  }}
                  onBlur={() => { if (draft.apiKey.trim()) void load(false); }}
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
            </>
          )}
          <div className="cw-model-picker">
            <label>
              Model
              {draft.provider === "chatgpt" ? (
                <select
                  value={draft.model}
                  disabled={!models.length}
                  onChange={(e) =>
                    setDraft({ ...draft, model: e.target.value })
                  }
                >
                  {!models.length && (
                    <option value={draft.model}>
                      {draft.model || "Connect to load your models"}
                    </option>
                  )}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  list="cw-models"
                  value={draft.model}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      model: e.target.value,
                      requestReasoning:
                        models.find((m) => m.id === e.target.value)
                          ?.reasoning === true,
                    })
                  }
                />
              )}
            </label>
            <datalist id="cw-models">
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </datalist>
            <button
              type="button"
              aria-label="Load models"
              onClick={() => void load()}
            >
              Load models
            </button>
          </div>
          {status && <p role="status">{status}</p>}
          <details className="cw-source-settings">
            <summary>
              Data sources <span>{draft.sources.length} selected</span>
            </summary>
            <p>Results include links to the source records.</p>

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
          </details>
          <details>
            <summary>Advanced</summary>
            <label className="cw-check">
              <input
                type="checkbox"
                checked={draft.rlm}
                onChange={(e) => setDraft({ ...draft, rlm: e.target.checked })}
              />
              Allow nested model calls (uses this provider)
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
            disabled={
              locked ||
              (draft.provider !== "chatgpt" && !draft.apiKey.trim()) ||
              !draft.sources.length ||
              !draft.model.trim() ||
              (draft.provider === "chatgpt" &&
                (!draft.chatgptAccount ||
                  !models.some((m) => m.id === draft.model)))
            }
          >
            {newChat ? "Start new chat" : "Use model"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
