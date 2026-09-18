import { type Answer, type Question, type Request } from './model';
export interface LabField { id: string; label: string; maxLength: number; multiline?: boolean }
export interface LabExample { id: string; label: string; inputs: Record<string, string> }
export interface LabSpec { id: string; primary: string; fields: LabField[]; questions: Record<string, Question> }
export interface Lab extends LabSpec { title: string; description: string; examples: LabExample[]; note: string; source: string }
export interface LabResponse { answers: Record<string, Answer> }
export interface LabRecording { task: string; example: string; recorded_at: string; request: Request; response: LabResponse; latency_ms: number }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export function buildLabRequest(task: LabSpec, inputs: Record<string, string>): Request {
  const state: Record<string, string> = {};
  for (const field of task.fields) {
    const value = inputs[field.id]?.trim();
    if (!value || value.length > field.maxLength) throw new Error(`${field.label}: enter 1–${field.maxLength.toLocaleString()} characters.`);
    state[field.id] = value;
  }
  return { model: 'jev-latest', state, questions: task.questions };
}
export function validateLabResponse(task: LabSpec, raw: unknown): raw is LabResponse {
  if (!object(raw) || !object(raw.answers)) return false;
  for (const [id, q] of Object.entries(task.questions)) {
    const a = raw.answers[id];
    if (!object(a) || a.type !== q.type) return false;
    if (q.type === 'noul') { if (!number(a.noul) || a.noul < 0 || a.noul > 1) return false; continue; }
    const keys = Object.keys(q.criteria ?? {});
    if (!object(a.probabilities) || Object.keys(a.probabilities).length !== keys.length) return false;
    const p = keys.map(key => (a.probabilities as Record<string, unknown>)[key]);
    if (!p.every(v => number(v) && v >= 0 && v <= 1)) return false;
    const values = p as number[];
    if (Math.abs(values.reduce((s, v) => s + v, 0) - 1) > .02) return false;
    if (q.type === 'choice') {
      if (typeof a.choice !== 'string' || !keys.includes(a.choice)) return false;
      if ((a.probabilities[a.choice] as number) < Math.max(...values) - 1e-6) return false;
    } else if (q.type === 'score') {
      if (!number(a.score) || a.score < 0 || a.score > keys.length - 1) return false;
    } else return false;
  }
  return true;
}
export function reviewDecision(answer: Answer, threshold: number) {
  const probability = answer.probabilities?.[answer.choice ?? ''] ?? 0;
  return { label: answer.choice ?? 'unknown', probability, review: probability < threshold };
}
export function leadComposite(answers: Record<string, Answer>) {
  return ((answers.fit.score ?? 0) * .5 + (answers.intent.score ?? 0) * .3 + (answers.timing.score ?? 0) * .2) / 3 * 100;
}
