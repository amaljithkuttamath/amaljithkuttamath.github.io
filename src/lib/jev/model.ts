export interface Question { type: string; instructions: unknown; criteria?: Record<string, unknown> | unknown[] }
export interface Request { model: string; state: unknown; questions: Record<string, Question> }
export interface Answer { type: string; choice?: string; noul?: number; score?: number; confidence?: number; probabilities?: Record<string, number> }
function object(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (object(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export function inspectDraft(stateText: string, questionsText: string, original: Request) {
  let state: unknown, questions: unknown;
  try { state = JSON.parse(stateText); questions = JSON.parse(questionsText); } catch { return { ok: false, error: 'Check the JSON syntax: quotes, commas, and brackets.' }; }
  if (!(typeof state === 'string' || Array.isArray(state) || object(state))) return { ok: false, error: 'State must be text, an object, or an array.' };
  if (!object(questions) || !Object.keys(questions).length) return { ok: false, error: 'Add at least one named question.' };
  for (const [id, q] of Object.entries(questions)) {
    if (!object(q) || !['choice', 'score', 'noul'].includes(String(q.type)) || !q.instructions) return { ok: false, error: `${id}: provide a valid type and instructions.` };
    if (q.type === 'choice' && (!object(q.criteria) || Object.keys(q.criteria).length < 2)) return { ok: false, error: `${id}: provide at least two choices.` };
    if (q.type === 'score' && (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10)) return { ok: false, error: `${id}: provide 2–10 ordered levels.` };
  }
  const request = { model: original.model, state, questions: questions as Record<string, Question> };
  return { ok: true, request, matchesRecording: canonical(request) === canonical(original) };
}
export function pretty(value: string) { return value.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase()); }
export function answerView(q: Question, a: Answer) {
  if (a.type === 'noul') return { value: `${Math.round(a.noul! * 100)}%`, caption: 'Probability of yes', bars: [{ label: 'Yes', percent: Math.round(a.noul! * 100) }, { label: 'No', percent: Math.round((1 - a.noul!) * 100) }] };
  const score = a.type === 'score';
  return { value: score ? `${a.score!.toFixed(2)} / ${Object.keys(q.criteria ?? {}).length - 1}` : pretty(a.choice!), caption: score ? 'Position on the ordered rubric' : 'Selected answer', bars: Object.entries(a.probabilities ?? {}).map(([key, p]) => ({ label: score ? String((q.criteria as unknown[])[Number(key)]) : pretty(key), percent: Math.round(p * 100) })) };
}
export function browserDecision(answers: Record<string, { choice?: string }>, elements: { id: string; label: string }[]) {
  if (answers.operation?.choice !== 'click') return { action: pretty(answers.operation?.choice ?? 'unknown'), detail: 'No click is consumed.' };
  const target = elements.find(e => e.id === answers.click_target?.choice);
  return { action: target ? `Click “${target.label}”` : 'No applicable target', detail: 'Selected from the supplied controls.' };
}
