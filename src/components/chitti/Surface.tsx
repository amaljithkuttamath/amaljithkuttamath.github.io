import { useEffect, useState } from "react";
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
import { Result } from "./Result";

const resultComponent = createComponentImplementation(
  resultApi,
  ({ props }) => {
    let result = null;
    try {
      result = cleanShareState(JSON.parse(props.resultJSON));
    } catch {}
    return result ? (
      <Result result={result} />
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
}: {
  operations: unknown[];
  onAction?: (action: ActionPayload) => void;
}) {
  const [model, setModel] =
    useState<SurfaceModel<ReactCatalogComponent> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const processor = new MessageProcessor<ReactCatalogComponent>(
      [analysisCatalog],
      onAction,
    );
    try {
      if (!boundedSurface(operations)) throw new Error("Invalid surface");
      processor.processMessages(operations as ProcessableMessagePayload);
      setModel([...processor.model.surfacesMap.values()][0] || null);
      setError("");
    } catch {
      setModel(null);
      setError("This interface could not be validated. Retry the analysis.");
    }
    return () => processor.dispose();
  }, [operations, onAction]);
  return error ? (
    <p role="alert">{error}</p>
  ) : model ? (
    <A2uiSurface surface={model} />
  ) : (
    <p role="status">Preparing result…</p>
  );
}
