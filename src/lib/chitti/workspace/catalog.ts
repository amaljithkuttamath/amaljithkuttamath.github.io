import { Catalog } from "@a2ui/web_core/catalog";
import { z } from "zod";
import { CATALOG_ID } from "./model";
export const resultApi = {
  name: "AnalysisResult",
  schema: z.object({ resultJSON: z.string().max(2_000_000) }).strict(),
};
export const questionApi = {
  name: "Clarification",
  schema: z
    .object({
      requestId: z.string().max(100),
      question: z.string().max(500),
      options: z.array(z.string().max(120)).min(2).max(5),
    })
    .strict(),
};
export const catalog = new Catalog(CATALOG_ID, "v0.9", [
  resultApi,
  questionApi,
]);
/** Bound input before the protocol library visits any collection or expression. */
export function boundedSurface(operations: unknown[]): boolean {
  if (!Array.isArray(operations) || operations.length !== 2) return false;
  const [create, update] = operations as any[];
  const surfaceId = create?.createSurface?.surfaceId;
  if (
    create?.version !== "v0.9" ||
    update?.version !== "v0.9" ||
    create?.createSurface?.catalogId !== CATALOG_ID ||
    !["result", "question"].includes(surfaceId)
  )
    return false;
  const body = update?.updateComponents;
  if (
    body?.surfaceId !== surfaceId ||
    !Array.isArray(body.components) ||
    body.components.length !== 1
  )
    return false;
  const component = body.components[0];
  if (component?.id !== "root") return false;
  if (surfaceId === "result")
    return (
      component.component === "AnalysisResult" &&
      typeof component.resultJSON === "string" &&
      component.resultJSON.length <= 2_000_000
    );
  return (
    component.component === "Clarification" &&
    typeof component.requestId === "string" &&
    component.requestId.length <= 100 &&
    typeof component.question === "string" &&
    component.question.length <= 500 &&
    Array.isArray(component.options) &&
    component.options.length >= 2 &&
    component.options.length <= 5 &&
    component.options.every(
      (o: unknown) => typeof o === "string" && o.length <= 120,
    )
  );
}
