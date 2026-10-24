import { catalog } from "../../../lib/chitti/workspace/catalog";
export function GET() {
  return new Response(JSON.stringify(catalog.toJson()), {
    headers: { "Content-Type": "application/json" },
  });
}
