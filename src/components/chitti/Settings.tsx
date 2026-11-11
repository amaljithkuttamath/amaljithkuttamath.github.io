import ChatGPTConnection from "./ChatGPTConnection";
import { useEffect, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
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
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      purpose="form"
      width={540}
      maxHeight="88dvh"
      padding={0}
    >
      <form
        className="cx-settings"
        aria-label="Settings"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) onSave(draft, remember);
        }}
      >
        <DialogHeader
          title="Settings"
          subtitle="Model, key and data sources for new chats"
          onOpenChange={(open) => {
            if (!open) onClose();
          }}
          hasDivider
          className="cx-settings-header"
        />
        <div className="cx-settings-body">
          {locked && (
            <Banner
              status="info"
              title="This chat keeps its model"
              description="Start a new chat to switch model or provider."
              collapsible={false}
            />
          )}
          <Selector
            label="Provider"
            isDisabled={locked}
            value={draft.provider}
            onChange={(id) => changeProvider(id as ProviderId)}
            options={PROVIDERS.map((p) => ({ value: p.id, label: p.label }))}
            width="100%"
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
                    model: list.some((m) => m.id === d.model)
                      ? d.model
                      : list[0]?.id || "",
                  }));
              }}
            />
          )}
          {draft.provider !== "chatgpt" && (
            <>
              <TextInput
                type="password"
                label="API key"
                description="Kept in this browser tab only. Never written into results, links or exports."
                isDisabled={locked}
                value={draft.apiKey}
                autoComplete="off"
                onChange={(apiKey) => setDraft({ ...draft, apiKey })}
                width="100%"
              />
              <CheckboxInput
                label="Remember in this tab until it closes"
                isDisabled={locked}
                value={remember}
                onChange={setRemember}
              />
            </>
          )}
          <div className="cx-settings-model">
            {draft.provider === "chatgpt" ? (
              <Selector
                label="Model"
                isDisabled={locked || !models.length}
                placeholder={draft.model || "Connect to load your models"}
                value={models.some((m) => m.id === draft.model) ? draft.model : ""}
                onChange={(model) => setDraft({ ...draft, model })}
                options={models.map((m) => ({ value: m.id, label: m.label }))}
                width="100%"
              />
            ) : (
              <>
                <TextInput
                  label="Model"
                  isDisabled={locked}
                  value={draft.model}
                  onChange={(model) =>
                    setDraft({
                      ...draft,
                      model,
                      requestReasoning:
                        models.find((m) => m.id === model)?.reasoning === true,
                    })
                  }
                  width="100%"
                  {...({ list: "cx-models" } as object)}
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
            <IconButton
              label="Refresh models"
              tooltip="Refresh models"
              icon={<RefreshIcon />}
              isDisabled={locked}
              onClick={() => void load()}
            />
          </div>
          {status && (
            <Text as="p" type="supporting" role="status">
              {status}
            </Text>
          )}
          <Collapsible
            className="cx-settings-section"
            defaultIsOpen={false}
            trigger={
              <span className="cx-settings-trigger">
                Data sources <MicroLabel>{draft.sources.length} selected</MicroLabel>
              </span>
            }
          >
            <div className="cx-settings-group">
              <Text as="p" type="supporting">
                Results include links to the source records.
              </Text>
              {SOURCES.map((source) => (
                <CheckboxInput
                  key={source.id}
                  label={source.label}
                  isDisabled={locked}
                  value={draft.sources.includes(source.id)}
                  onChange={(checked) =>
                    setDraft({
                      ...draft,
                      sources: checked
                        ? [...draft.sources, source.id]
                        : draft.sources.filter((id) => id !== source.id),
                    })
                  }
                />
              ))}
            </div>
          </Collapsible>
          <Collapsible
            className="cx-settings-section"
            defaultIsOpen={false}
            trigger={<span className="cx-settings-trigger">Advanced</span>}
          >
            <div className="cx-settings-group">
              <CheckboxInput
                label="Allow nested model calls (uses this provider)"
                isDisabled={locked}
                value={draft.rlm}
                onChange={(rlm) => setDraft({ ...draft, rlm })}
              />
              <CheckboxInput
                label="Use Jev for dataset routing and evidence review"
                description="Jev sends search candidates and analysis evidence to the hosted relay. Credentials and conversation history are excluded."
                isDisabled={locked || !jevBase}
                value={!!draft.jev}
                onChange={(checked) =>
                  setDraft({
                    ...draft,
                    jev: checked && jevBase ? { base: jevBase } : undefined,
                  })
                }
              />
            </div>
          </Collapsible>
        </div>
        <footer className="cx-settings-footer">
          <Button label="Cancel" variant="ghost" onClick={onClose} />
          <Button type="submit" variant="primary" label="Save settings" isDisabled={!canSave} />
        </footer>
      </form>
    </Dialog>
  );
}
