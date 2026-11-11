import { useState } from 'react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { DropdownMenu, type DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { PROVIDERS, providerMeta, type ProviderId } from '../../lib/chitti/providers';
import type { Settings } from '../../lib/chitti/workspace/model';

export default function ModelPicker({ value, locked, running, onChoose, onConnect, onNewChat }: {
  value: Settings; locked: boolean; running: boolean;
  onChoose: (value: Settings) => void;
  onConnect: (provider?: ProviderId) => void;
  onNewChat: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const connected = value.provider === 'chatgpt' ? !!value.chatgptAccount : !!value.apiKey;
  const direct = value.directOnly || !connected;
  const label = direct ? 'No model · direct queries' : value.model || providerMeta(value.provider).label;
  const choose = (action: () => void) => {
    setOpen(false);
    if (locked) { setPending(() => action); return; }
    action();
  };
  const models = providerMeta(value.provider).models;
  const options = value.model && !models.some(m => m.id === value.model)
    ? [{ id: value.model, label: value.model }, ...models] : models;
  const check = <Icon icon="check" size="sm" />;
  const items: DropdownMenuOption[] = [
    {
      type: 'section', title: 'Model', items: [
        { label: 'No model', description: 'Supported direct queries · no API key', isDisabled: running,
          endContent: direct ? check : undefined, onClick: () => choose(() => onChoose({ ...value, directOnly: true })) },
        ...(connected ? options.map(model => ({
          label: model.label, description: `${providerMeta(value.provider).label} · configured`, isDisabled: running,
          endContent: !direct && value.model === model.id ? check : undefined,
          onClick: () => choose(() => onChoose({ ...value, model: model.id, directOnly: false })),
        })) : []),
      ],
    },
    {
      type: 'section', title: 'Connections', items: PROVIDERS.map(provider => ({
        label: provider.label, isDisabled: running,
        description: provider.id === value.provider && connected ? 'Manage connection' : provider.id === 'chatgpt' ? 'Connect through the local companion' : 'Connect with your API key',
        onClick: () => choose(() => onConnect(provider.id)),
      })),
    },
  ];
  return <>
    <DropdownMenu
      isMenuOpen={open}
      onOpenChange={setOpen}
      placement="above"
      menuWidth={300}
      menuMaxHeight={420}
      button={{
        label: `Choose model: ${label}`,
        size: 'sm',
        variant: 'ghost',
        className: 'cx-model-trigger',
        icon: <StatusDot variant={direct ? 'neutral' : 'success'} label={direct ? 'No model connected' : 'Model connected'} />,
        children: <span className="cx-model-label">{label}</span>,
      }}
      items={items}
    />
    <AlertDialog
      isOpen={!!pending}
      onOpenChange={isOpen => { if (!isOpen) setPending(null); }}
      title="Switch model in a new chat?"
      description="This chat keeps its model. Start a new chat to switch; this conversation stays in Recent chats."
      cancelLabel="Keep current"
      actionLabel="Start new chat"
      actionVariant="primary"
      onAction={() => { const action = pending; setPending(null); onNewChat(); action?.(); }}
    />
  </>;
}
