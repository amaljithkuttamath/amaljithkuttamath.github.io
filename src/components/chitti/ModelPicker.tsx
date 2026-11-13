import { useEffect, useState } from "react";
import { loadModelCatalog, PROVIDERS, providerMeta, type ModelOption, type ProviderId } from "../../lib/chitti/providers";
import type { Settings } from "../../lib/chitti/workspace/model";

import { Button, Dialog, Select, TextField } from "./ui/controls";

export const modelConnected = (value: Settings) =>
  !value.directOnly && !!(value.provider === "chatgpt" ? value.chatgptAccount : value.apiKey);

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
  const connected = !!(value.provider === "chatgpt" ? value.chatgptAccount : value.apiKey);
  const direct = !!value.directOnly || !connected;
  const label = direct ? "Direct queries" : value.model;
  return <>
    <button type="button" className="cx-btn cx-model-trigger" data-size="sm" data-variant="quiet" disabled={running}
      aria-haspopup="dialog" aria-expanded={open} aria-label={`Choose model: ${label}`}
      onClick={() => setOpen(true)}>
      <span className="cx-model-dot" data-on={!direct || undefined} /><span className="cx-btn-label">{direct ? "Choose model" : label}</span>
    </button>
    {open && <PickerDialog {...props} connected={connected} direct={direct} onClose={() => setOpen(false)} />}
  </>;
}

function PickerDialog({ value, locked, connected, direct, onClose, onChoose, onConnect, onNewChat }: Props & {
  connected: boolean; direct: boolean; onClose: () => void;
}) {
  const [provider, setProvider] = useState<ProviderId>(connected ? value.provider : "openrouter");
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<Settings | null>(null);
  const [catalog, setCatalog] = useState<{ models: ModelOption[]; status: "ready" | "offline" } | null>(null);
  const configured = connected && provider === value.provider;
  const canBrowse = configured || provider === "openrouter";
  const meta = providerMeta(provider);
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

  const choose = (next: Settings, unchanged: boolean) => {
    if (unchanged) return onClose();
    if (locked) return setPending(next);
    onChoose(next);
    onClose();
  };
  const connect = (model?: ModelOption) => {
    onClose();
    onConnect(provider, model);
  };
  const models = catalog?.models ?? meta.models;
  const options = configured && value.model && !models.some(m => m.id === value.model)
    ? [{ id: value.model, label: value.model, reasoning: value.requestReasoning }, ...models] : models;
  const terms = query.trim().toLowerCase().split(/\s+/);
  const matches = options.filter(m => terms.every(t => `${m.name ?? ""} ${m.label} ${m.id}`.toLowerCase().includes(t)));

  return <Dialog title={pending ? "Switch models in a new chat?" : "Choose a model"} onClose={onClose}
    footer={pending ? <>
      <Button label="Back to models" onClick={() => setPending(null)} />
      <Button variant="primary" label="Start new chat" onClick={() => { onNewChat(); onChoose(pending); onClose(); }} />
    </> : <>
      <Button label={direct ? "Direct queries ✓" : "Direct queries"} onClick={() => choose({ ...value, directOnly: true }, direct)} />
      <Button label={configured ? "Connection settings" : `Connect ${provider === "chatgpt" ? "ChatGPT" : meta.label}`} onClick={() => connect()} />
    </>}>
    {pending ? <p>Your current conversation stays in Recent chats. The new chat will use <strong>{pending.directOnly ? "direct queries" : pending.model}</strong>.</p> : <>
      <Select label="Provider" value={provider} options={PROVIDERS.map(p => ({value: p.id, label: p.label}))}
        onChange={id => { setProvider(id as ProviderId); setCatalog(null); setRevision(0); setQuery(""); }} />
      {canBrowse ? <>
          <TextField autoFocus hideLabel type="search" label="Search models" placeholder="Search by model name or ID" value={query} onChange={setQuery} />
          <div className="cx-status-text" role="status">
            {!catalog ? "Loading models…" : catalog.status === "offline" ? "Live catalog unavailable" : `${matches.length} ${matches.length === 1 ? "model" : "models"}`}
            {catalog?.status === "offline" && <Button label="Retry" size="sm" onClick={() => { setCatalog(null); setRevision(r => r + 1); }} />}
          </div>
          <div className="cx-model-results" role="group" aria-label="Models">
            {matches.map(model => {
              const selected = configured && !direct && value.model === model.id;
              const title = model.name || model.label;
              return <button type="button" className="cx-menu-item" key={model.id} aria-pressed={selected} onClick={() => {
                if (!configured) return connect(model);
                choose({ ...value, model: model.id, requestReasoning: !!model.reasoning, directOnly: false }, selected);
              }}>
                <span className="cx-menu-text"><strong>{title}</strong>{title !== model.id && <small className="cx-menu-desc">{model.id}</small>}</span>
                {model.free && !/\bfree\b/i.test(title) && <small>Free</small>}
                {selected && <span aria-label="Selected" className="cx-menu-check">✓</span>}
              </button>;
            })}
            {!matches.length && catalog && <p>{query ? "No matching models. Try another name or ID." : catalog.status === "offline" ? "Retry or check your connection settings." : "No models available for this account."}</p>}
          </div>
          {!configured && <p>Choose a model to connect your OpenRouter API key.</p>}
        </> : <p>{provider === "chatgpt" ? "Connect your ChatGPT subscription to see the models on your plan." : `Connect your ${meta.label} key to see your models.`}</p>}
    </>}
  </Dialog>;
}
