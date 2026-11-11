import ChatGPTConnection from "./ChatGPTConnection";
import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Dialog, IconButton, Notice, Select, TextField } from "./ui/controls";
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
import { MicroLabel } from "./ui/primitives";
import { RefreshIcon } from "./ui/icons";
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
  useEffect(
    () => () => {
      loading.current++;
    },
    [],
  );
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
  const load = async () => {
    const version = ++loading.current;
    setStatus("Reading model catalog…");
    try {
      const list = await fetchModels(
        draft.provider,
        draft.apiKey,
        draft.chatgptAccount,
      );
      if (version === loading.current) {
        setModels(list);
        setStatus(`${list.length} models available.`);
      }
    } catch {
      if (version === loading.current)
        setStatus("Could not load models. Check the connection and retry.");
    }
  };
  const canSave = !(
    locked ||
    !draft.sources.length ||
    !draft.model.trim() ||
    (draft.provider === "chatgpt" &&
      (!draft.chatgptAccount || !models.some((m) => m.id === draft.model)))
  );
  return (
    <Dialog
      title="Settings"
      description="Model, key and data sources for new chats"
      onClose={onClose}
      as="form"
      onSubmit={() => {
        if (canSave) onSave(draft, remember);
      }}
      className="cx-settings"
      footer={
        <>
          <Button label="Cancel" variant="ghost" onClick={onClose} />
          <Button type="submit" variant="primary" label="Save settings" disabled={!canSave} />
        </>
      }
    >
      {locked && (
        <Notice title="This chat keeps its model">Start a new chat to switch model or provider.</Notice>
      )}
      <Select
        label="Provider"
        disabled={locked}
        value={draft.provider}
        onChange={(id) => changeProvider(id as ProviderId)}
        options={PROVIDERS.map((p) => ({ value: p.id, label: p.label }))}
      />
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
                model: list.some((m) => m.id === d.model) ? d.model : list[0]?.id || "",
              }));
          }}
        />
      )}
      {draft.provider !== "chatgpt" && (
        <>
          <TextField
            type="password"
            label="API key"
            description="Kept in this browser tab only. Never written into results, links or exports."
            disabled={locked}
            value={draft.apiKey}
            autoComplete="off"
            onChange={(apiKey) => setDraft({ ...draft, apiKey })}
          />
          <Checkbox label="Remember in this tab until it closes" disabled={locked} checked={remember} onChange={setRemember} />
        </>
      )}
      <div className="cx-settings-model">
        {draft.provider === "chatgpt" ? (
          <Select
            label="Model"
            disabled={locked || !models.length}
            placeholder={draft.model || "Connect to load your models"}
            value={models.some((m) => m.id === draft.model) ? draft.model : ""}
            onChange={(model) => setDraft({ ...draft, model })}
            options={models.map((m) => ({ value: m.id, label: m.label }))}
          />
        ) : (
          <>
            <TextField
              label="Model"
              disabled={locked}
              value={draft.model}
              list="cx-models"
              onChange={(model) =>
                setDraft({
                  ...draft,
                  model,
                  requestReasoning: models.find((m) => m.id === model)?.reasoning === true,
                })
              }
            />
            <datalist id="cx-models">
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </datalist>
          </>
        )}
        <IconButton label="Refresh models" icon={<RefreshIcon />} disabled={locked} onClick={() => void load()} />
      </div>
      {status && (
        <p className="cx-status-text" role="status">
          {status}
        </p>
      )}
      <details className="cx-disclosure">
        <summary>
          Data sources <MicroLabel>{draft.sources.length} selected</MicroLabel>
        </summary>
        <div className="cx-disclosure-body">
          <p className="cx-status-text">Results include links to the source records.</p>
          {SOURCES.map((source) => (
            <Checkbox
              key={source.id}
              label={source.label}
              disabled={locked}
              checked={draft.sources.includes(source.id)}
              onChange={(checked) =>
                setDraft({
                  ...draft,
                  sources: checked ? [...draft.sources, source.id] : draft.sources.filter((id) => id !== source.id),
                })
              }
            />
          ))}
        </div>
      </details>
      <details className="cx-disclosure">
        <summary>Advanced</summary>
        <div className="cx-disclosure-body">
          <Checkbox
            label="Allow nested model calls (uses this provider)"
            disabled={locked}
            checked={draft.rlm}
            onChange={(rlm) => setDraft({ ...draft, rlm })}
          />
          <Checkbox
            label="Use Jev for dataset routing and evidence review"
            description="Jev sends search candidates and analysis evidence to the hosted relay. Credentials and conversation history are excluded."
            disabled={locked || !jevBase}
            checked={!!draft.jev}
            onChange={(checked) => setDraft({ ...draft, jev: checked && jevBase ? { base: jevBase } : undefined })}
          />
        </div>
      </details>
    </Dialog>
  );
}
