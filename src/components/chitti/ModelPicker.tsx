import { useRef, useState } from 'react';
import { PROVIDERS, providerMeta, type ProviderId } from '../../lib/chitti/providers';
import type { Settings } from '../../lib/chitti/workspace/model';

export default function ModelPicker({ value, locked, running, onChoose, onConnect, onNewChat }: {
  value: Settings; locked: boolean; running: boolean;
  onChoose: (value: Settings) => void;
  onConnect: (provider?: ProviderId) => void;
  onNewChat: () => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const connected = value.provider === 'chatgpt' ? !!value.chatgptAccount : !!value.apiKey;
  const label = value.directOnly || !connected ? 'No model · direct queries' : value.model || providerMeta(value.provider).label;
  const choose = (action: () => void) => {
    if (locked) { setPending(() => action); return; }
    action();
    if (menu.current) menu.current.open = false;
  };
  const models = providerMeta(value.provider).models;
  const options = value.model && !models.some(m => m.id === value.model)
    ? [{ id: value.model, label: value.model }, ...models] : models;
  return <details className="cw-model-menu" ref={menu} onKeyDown={e => {
    if (e.key === 'Escape' && menu.current) { menu.current.open = false; menu.current.querySelector('summary')?.focus(); }
  }}>
    <summary aria-label={`Choose model: ${label}`}>{label}<span aria-hidden="true">⌄</span></summary>
    <div className="cw-model-popover" role="group" aria-label="Choose model">
      <h3>Choose a model</h3>
      <button type="button" disabled={running} aria-pressed={value.directOnly || !connected} onClick={() => choose(() => onChoose({ ...value, directOnly: true }))}>
        <strong>No model</strong>{" "}<small>Supported direct queries · no API key</small>
      </button>
      {connected && options.map(model => <button key={model.id} type="button" disabled={running}
        aria-pressed={!value.directOnly && value.model === model.id}
        onClick={() => choose(() => onChoose({ ...value, model: model.id, directOnly: false }))}>
        <strong>{model.label}</strong>{" "}<small>{providerMeta(value.provider).label} · configured</small>
      </button>)}
      <p>Connections</p>
      {PROVIDERS.map(provider => <button key={provider.id} type="button" disabled={running}
        onClick={() => choose(() => onConnect(provider.id))}>
        <strong>{provider.label}</strong>{" "}<small>{provider.id === value.provider && connected ? 'Manage connection' : provider.id === 'chatgpt' ? 'Connect through the local companion' : 'Connect with your API key'}</small>
      </button>)}
      {pending && <div className="cw-model-restart" role="status">
        <p>This chat keeps its model. Start a new chat to switch; this conversation stays in Recent chats.</p>
        <button type="button" onClick={() => setPending(null)}>Keep current</button>
        <button type="button" onClick={() => { onNewChat(); pending(); setPending(null); if (menu.current) menu.current.open = false; }}>Start new chat</button>
      </div>}
    </div>
  </details>;
}
