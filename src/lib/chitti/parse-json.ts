// parse-json.ts — extract the first balanced-looking top-level JSON object from
// a text blob. Shared by the planner (parsePlanBrief) and the verifier
// (parseVerifierVerdict): both ask a model for bare JSON but must tolerate it
// wrapped in ``` fences or a sentence of prose. Never throws.
// ── Verdict parsing (pure, exported for tests) ────────────────────────────
// Pull the first balanced-looking top-level JSON object out of a text blob.
// The verifier is asked for bare JSON, but models wrap it in ``` fences or a
// sentence of prose; we take the slice from the first '{' to the last '}' and
// try to parse it. Returns a plain object or null (never throws).
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
