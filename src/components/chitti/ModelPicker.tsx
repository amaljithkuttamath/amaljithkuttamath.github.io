import { useEffect, useRef, useState } from "react";
import { loadModelCatalog, PROVIDERS, providerMeta, type ModelOption, type ProviderId } from "../../lib/chitti/providers";
import type { Settings } from "../../lib/chitti/workspace/model";

type Props = {
  value: Settings;
  locked: boolean;
  running: boolean;
  onChoose: (value: Settings) => void;
  onConnect: (provider: ProviderId, model?: ModelOption) => void;
  onNewChat: () => void;
};

export default function ModelPicker(props: Props) {
  const { value, running } = props;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const connected = !!(value.provider === "chatgpt" ? value.chatgptAccount : value.apiKey);
  const direct = !!value.directOnly || !connected;
  const label = direct ? "Direct queries" : value.model;
  return <div className="cw-model-menu">
    <button type="button" ref={trigger} className="cw-picker-trigger" disabled={running}
      aria-haspopup="dialog" aria-expanded={open} aria-label={`Choose model: ${label}`}
      onClick={() => setOpen(true)}>
      <span>{direct ? "Choose model" : label}</span><span className="cw-chevron" aria-hidden="true" />
    </button>
    {open && <PickerDialog {...props} connected={connected} direct={direct} onClose={() => { setOpen(false); trigger.current?.focus(); }} />}
  </div>;
}

function PickerDialog({ value, locked, connected, direct, onClose, onChoose, onConnect, onNewChat }: Props & {
  connected: boolean; direct: boolean; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const cancelSwitch = useRef<HTMLButtonElement>(null);
  const [provider, setProvider] = useState<ProviderId>(connected ? value.provider : "openrouter");
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<Settings | null>(null);
  const [catalog, setCatalog] = useState<{ models: ModelOption[]; status: "ready" | "offline" } | null>(null);
  const configured = connected && provider === value.provider;
  const canBrowse = configured || provider === "openrouter";
  const meta = providerMeta(provider);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    search.current?.focus({ preventScroll: true });
    return () => element.close();
  }, []);
  useEffect(() => {
    if (pending) cancelSwitch.current?.focus();
  }, [pending]);
  useEffect(() => {
    if (!canBrowse) return;
    let current = true;
    loadModelCatalog(provider, configured ? value.apiKey : undefined, configured ? value.chatgptAccount : undefined, revision > 0)
      .then(({ models, fallback }) => {
        if (current) setCatalog({ models, status: fallback ? "offline" : "ready" });
      }).catch(() => {
        if (current) setCatalog({ models: [], status: "offline" });
      });
    return () => { current = false; };
  }, [provider, configured, canBrowse, value.apiKey, value.chatgptAccount, revision]);

  const dismiss = () => {
    dialog.current?.close();
    onClose();
  };
  const choose = (next: Settings, unchanged: boolean) => {
    if (unchanged) return dismiss();
    if (locked) return setPending(next);
    onChoose(next);
    dismiss();
  };
  const connect = (model?: ModelOption) => {
    dismiss();
    onConnect(provider, model);
  };
  const models = catalog?.models ?? meta.models;
  const options = configured && value.model && !models.some(m => m.id === value.model)
    ? [{ id: value.model, label: value.model, reasoning: value.requestReasoning }, ...models] : models;
  const terms = query.trim().toLowerCase().split(/\s+/);
  const matches = options.filter(m => terms.every(t => `${m.name ?? ""} ${m.label} ${m.id}`.toLowerCase().includes(t)));

  return <dialog ref={dialog} className="cw-picker-dialog" aria-labelledby="cw-picker-title"
    onCancel={e => { e.preventDefault(); dismiss(); }} onClick={e => { if (e.target === dialog.current) dismiss(); }}>
    <div className="cw-picker-content">
      <header><h2 id="cw-picker-title">{pending ? "Switch models in a new chat?" : "Choose a model"}</h2>
        <button type="button" aria-label="Close model picker" onClick={dismiss}>×</button>
      </header>
      {pending ? <>
        <p>Your current conversation stays in Recent chats. The new chat will use <strong>{pending.directOnly ? "direct queries" : pending.model}</strong>.</p>
        <footer><button type="button" ref={cancelSwitch} onClick={() => setPending(null)}>Back to models</button>
          <button type="button" className="cw-primary" onClick={() => { onNewChat(); onChoose(pending); dismiss(); }}>Start new chat</button></footer>
      </> : <>
        <label className="cw-picker-provider">Provider
          <select value={provider} onChange={e => {
            setProvider(e.target.value as ProviderId); setCatalog(null); setRevision(0); setQuery("");
          }}>{PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
        </label>
        {canBrowse ? <>
          <input ref={search} className="cw-model-search" type="search" aria-label="Search models" placeholder="Search by model name or ID"
            value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter") e.preventDefault(); }} />
          <div className="cw-picker-status" role="status">
            {!catalog ? "Loading models…" : catalog.status === "offline" ? "Live catalog unavailable" : `${matches.length} ${matches.length === 1 ? "model" : "models"}`}
            {catalog?.status === "offline" && <button type="button" onClick={() => { setCatalog(null); setRevision(r => r + 1); }}>Retry</button>}
          </div>
          <div className="cw-picker-results" role="group" aria-label="Models">
            {matches.map(model => {
              const selected = configured && !direct && value.model === model.id;
              const title = model.name || model.label;
              return <button type="button" key={model.id} aria-pressed={selected} onClick={() => {
                if (!configured) return connect(model);
                choose({ ...value, model: model.id, requestReasoning: !!model.reasoning, directOnly: false }, selected);
              }}>
                <span><strong>{title}</strong>{title !== model.id && <small>{model.id}</small>}</span>
                {model.free && !/\bfree\b/i.test(title) && <small>Free</small>}
                {selected && <span aria-label="Selected" className="cw-selected-mark">✓</span>}
              </button>;
            })}
            {!matches.length && catalog && <p>{query ? "No matching models. Try another name or ID." : catalog.status === "offline" ? "Retry or check your connection settings." : "No models available for this account."}</p>}
          </div>
          {!configured && <p>Choose a model to connect your OpenRouter API key.</p>}
        </> : <p>{provider === "chatgpt" ? "Connect your ChatGPT subscription to see the models on your plan." : `Connect your ${meta.label} key to see your models.`}</p>}
        <footer>
          <button type="button" aria-pressed={direct} onClick={() => choose({ ...value, directOnly: true }, direct)}>Direct queries{direct && <span aria-hidden="true"> ✓</span>}</button>
          <button type="button" onClick={() => connect()}>{configured ? "Connection settings" : `Connect ${provider === "chatgpt" ? "ChatGPT" : meta.label}`}</button>
        </footer>
      </>}
    </div>
  </dialog>;
}
