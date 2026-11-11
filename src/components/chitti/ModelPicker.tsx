import { useState } from "react";
import { PROVIDERS, providerMeta, type ProviderId } from "../../lib/chitti/providers";
import type { Settings } from "../../lib/chitti/workspace/model";
import { Confirm, Menu, type MenuItem } from "./ui/controls";

/** Whether a model is connected and chosen (not "No model"). */
export const modelConnected = (value: Settings) =>
  !value.directOnly && (value.provider === "chatgpt" ? !!value.chatgptAccount : !!value.apiKey);

export default function ModelPicker({
  value,
  locked,
  running,
  onChoose,
  onConnect,
  onNewChat,
}: {
  value: Settings;
  locked: boolean;
  running: boolean;
  onChoose: (value: Settings) => void;
  onConnect: (provider?: ProviderId) => void;
  onNewChat: () => void;
}) {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const connected = value.provider === "chatgpt" ? !!value.chatgptAccount : !!value.apiKey;
  const direct = value.directOnly || !connected;
  const label = direct ? "No model · direct queries" : value.model || providerMeta(value.provider).label;
  const choose = (action: () => void) => {
    if (locked) {
      setPending(() => action);
      return;
    }
    action();
  };
  const models = providerMeta(value.provider).models;
  const options = value.model && !models.some((m) => m.id === value.model) ? [{ id: value.model, label: value.model }, ...models] : models;
  const items: MenuItem[] = [
    {
      type: "section",
      title: "Model",
      items: [
        {
          label: "No model",
          description: "Supported direct queries · no API key",
          disabled: running,
          checked: direct,
          onSelect: () => choose(() => onChoose({ ...value, directOnly: true })),
        },
        ...(connected
          ? options.map<MenuItem>((model) => ({
              label: model.label,
              description: `${providerMeta(value.provider).label} · configured`,
              disabled: running,
              checked: !direct && value.model === model.id,
              onSelect: () => choose(() => onChoose({ ...value, model: model.id, directOnly: false })),
            }))
          : []),
      ],
    },
    {
      type: "section",
      title: "Connections",
      items: PROVIDERS.map<MenuItem>((provider) => ({
        label: provider.label,
        disabled: running,
        description:
          provider.id === value.provider && connected
            ? "Manage connection"
            : provider.id === "chatgpt"
              ? "Connect through the local companion"
              : "Connect with your API key",
        onSelect: () => choose(() => onConnect(provider.id)),
      })),
    },
  ];
  return (
    <>
      <Menu
        label={`Choose model: ${label}`}
        trigger={label}
        icon={<span className="cx-model-dot" data-on={!direct || undefined} />}
        items={items}
        placement="above"
        variant="quiet"
        className="cx-model-trigger"
      />
      {pending && (
        <Confirm
          title="Switch model in a new chat?"
          description="This chat keeps its model. Start a new chat to switch; this conversation stays in Recent chats."
          cancelLabel="Keep current"
          actionLabel="Start new chat"
          onCancel={() => setPending(null)}
          onAction={() => {
            const action = pending;
            setPending(null);
            onNewChat();
            action?.();
          }}
        />
      )}
    </>
  );
}
