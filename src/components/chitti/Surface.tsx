import { useEffect, useState, useRef } from "react";
import {
  A2uiSurface,
  createComponentImplementation,
  type ReactCatalogComponent,
} from "@a2ui/react/v0_9";
import {
  Catalog,
  MessageProcessor,
  type ActionPayload,
  type SurfaceModel,
  type ProcessableMessagePayload,
} from "@a2ui/web_core/v0_9";
import {
  resultApi,
  questionApi,
  boundedSurface,
} from "../../lib/chitti/workspace/catalog";
import { CATALOG_ID } from "../../lib/chitti/workspace/model";
import { cleanShareState } from "../../lib/chitti/share";
import { Result, ResultInteraction } from "./Result";

const resultComponent = createComponentImplementation(
  resultApi,
  ({ props, context }) => {
    let result = null;
    try {
      result = cleanShareState(JSON.parse(props.resultJSON));
    } catch {}
    return result ? (
      <Result
        result={result}
        onSteer={(name, value) =>
          void context.dispatchAction({ event: { name, context: { value } } })
        }
      />
    ) : (
      <p role="alert">The analysis result could not be validated.</p>
    );
  },
);
const questionComponent = createComponentImplementation(
  questionApi,
  ({ props, context }) => {
    const [text, setText] = useState(""),
      [sent, setSent] = useState(false);
    const answer = (value: string) => {
      if (!value.trim() || sent) return;
      setSent(true);
      void context.dispatchAction({
        event: {
          name: "answer",
          context: { requestId: props.requestId, value },
        },
      });
    };
    return (
      <form
        className="cw-clarification"
        onSubmit={(e) => {
          e.preventDefault();
          answer(text);
        }}
      >
        <h3>{props.question}</h3>
        <div>
          {props.options
            .filter((option): option is string => typeof option === "string")
            .map((option) => (
              <button
                key={option}
                type="button"
                disabled={sent}
                onClick={() => answer(option)}
              >
                {option}
              </button>
            ))}
        </div>
        <label>
          Your answer
          <input
            value={text}
            disabled={sent}
            onChange={(e) => setText(e.target.value)}
            maxLength={2000}
          />
        </label>
        <button disabled={sent || !text.trim()} type="submit">
          Continue
        </button>
      </form>
    );
  },
);
export const analysisCatalog = new Catalog(CATALOG_ID, "v0.9", [
  resultComponent,
  questionComponent,
]);
export default function Surface({
  operations,
  onAction,
  disabled = false,
}: {
  operations: unknown[];
  onAction?: (action: ActionPayload) => void;
  disabled?: boolean;
}) {
  const [model, setModel] =
    useState<SurfaceModel<ReactCatalogComponent> | null>(null);
  const [error, setError] = useState("");
  const callback = useRef(onAction);
  callback.current = onAction;
  const processor = useRef<MessageProcessor<ReactCatalogComponent> | null>(
    null,
  );
  useEffect(
    () => () => {
      processor.current?.dispose();
      processor.current = null;
    },
    [],
  );
  useEffect(() => {
    try {
      if (!boundedSurface(operations)) throw new Error("Invalid surface");
      processor.current ||= new MessageProcessor<ReactCatalogComponent>(
        [analysisCatalog],
        (action) => callback.current?.(action),
      );
      const p = processor.current;
      const id = (operations[0] as { createSurface: { surfaceId: string } })
        .createSurface.surfaceId;
      // Update the existing surface so tabs, filters and focus survive a draft.
      p.processMessages(
        (p.model.surfacesMap.has(id)
          ? operations.slice(1)
          : operations) as ProcessableMessagePayload,
      );
      setModel(p.model.surfacesMap.get(id) || null);
      setError("");
    } catch {
      setModel(null);
      setError("This interface could not be validated. Retry the analysis.");
    }
  }, [operations]);
  return error ? (
    <p role="alert">{error}</p>
  ) : model ? (
    <ResultInteraction.Provider value={!disabled}>
      <A2uiSurface surface={model} />
    </ResultInteraction.Provider>
  ) : (
    <p role="status">Preparing result…</p>
  );
}
