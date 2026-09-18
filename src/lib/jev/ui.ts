import replacement from '../../data/jev/agent/replacement.json';
import outOfStock from '../../data/jev/agent/out-of-stock.json';
import expired from '../../data/jev/agent/expired.json';
import promptData from '../../data/jev/recordings.json';
import { answerView, inspectDraft, pretty, type Answer, type Request } from './model';

type Event = { type: string; step?: number; tool?: string; arguments?: Record<string, unknown>; latency_ms?: number; request?: Request; response?: { answers: Record<string, Answer>; usage?: { input_tokens: number } }; result?: Record<string, unknown>; workspace?: Record<string, unknown>; message?: string };
type Recording = { id: string; prompt: string; recorded_at: string; events: Event[] };
const runs = [replacement, outOfStock, expired] as unknown as Recording[];
const prompts = promptData as unknown as { id: string; request: Request; response: { answers: Record<string, Answer> }; latency_ms: number }[];
function $<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', content = '') { const n = document.createElement(tag); n.className = cls; n.textContent = content; return n; }
function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function validEvent(value: unknown): value is Event {
  if (!object(value) || typeof value.type !== 'string') return false;
  if (value.type === 'decision') return typeof value.tool === 'string' && object(value.arguments) && object(value.request) && object(value.request.questions) && object(value.response) && object(value.response.answers) && typeof value.latency_ms === 'number';
  if (value.type === 'tool_result') return typeof value.tool === 'string' && object(value.result) && object(value.workspace);
  return ['complete', 'error'].includes(value.type) && typeof value.message === 'string';
}
let current = runs[0]; let events: Event[] = []; let selected = 0; let ready = false; let running = false; let controller: AbortController | undefined;
const prompt = $<HTMLTextAreaElement>('j-prompt'); const runButton = $<HTMLButtonElement>('j-run'); const loadButton = $<HTMLButtonElement>('j-load');

function jsonDetails(title: string, value: unknown) { const d = el('details', 'j-data-detail'); d.append(el('summary', '', title), el('pre', '', JSON.stringify(value, null, 2))); return d; }
function bars(values: Record<string, number>) {
  const group = el('div', 'j-bars');
  for (const [label, value] of Object.entries(values).sort((a, b) => b[1] - a[1])) {
    if (!Number.isFinite(value)) continue;
    const row = el('div', 'j-bar'); const head = el('div', 'j-bar-label'); head.append(el('span', '', pretty(label)), el('span', '', `${Math.round(value * 100)}%`));
    const track = el('div', 'j-bar-track'); const fill = el('i'); fill.style.width = `${Math.max(0, Math.min(100, value * 100))}%`; track.append(fill); row.append(head, track); group.append(row);
  }
  return group;
}
function inspect(index: number) {
  selected = index; const event = events[index]; const target = $('j-decision'); target.replaceChildren(); $('j-workspace').replaceChildren();
  $('j-workspace').classList.remove('j-rejected');
  document.querySelectorAll<HTMLButtonElement>('[data-step]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.step) === index)));
  if (!event) { $('j-step-number').textContent = ''; $('j-raw-decision').textContent = ''; target.append(el('p', 'j-empty', 'Choose a scenario or run a request to inspect a decision.')); return; }
  $('j-step-number').textContent = `STEP ${event.step ?? ''}`;
  const answer = event.response?.answers.tool;
  const top = el('div', 'j-picked'); top.append(el('span', 'j-kicker', 'JEV SELECTED'), el('h3', '', event.tool ?? 'Unknown'));
  target.append(top);
  if (answer?.probabilities) target.append(bars(answer.probabilities));
  const args = el('div', 'j-args'); args.append(el('span', 'j-kicker', 'ARGUMENTS CONSUMED BY CODE'));
  const entries = Object.entries(event.arguments ?? {});
  if (!entries.length) args.append(el('p', '', 'No tool arguments.'));
  for (const [key, value] of entries) { const row = el('div', 'j-arg'); row.append(el('code', '', key), el('strong', '', JSON.stringify(value))); args.append(row); }
  if (event.tool === 'prepare_resolution' && !('expedite' in (event.arguments ?? {}))) args.append(el('p', 'j-default-note', 'Shipping speed was omitted; the tool keeps its standard-shipping default.'));
  target.append(args);
  $('j-raw-decision').textContent = JSON.stringify({ request: event.request, response: event.response }, null, 2);
  const result = events[index + 1];
  if (result?.type === 'tool_result') {
    const box = $('j-workspace'); box.append(el('span', 'j-kicker', 'TOOL RETURNED'), el('h3', '', result.result?.ok === false ? 'Execution rejected' : 'Workspace updated'));
    box.classList.toggle('j-rejected', result.result?.ok === false);
    box.append(el('pre', '', JSON.stringify(result.result, null, 2)), jsonDetails('Observed workspace after this step', result.workspace));
  } else if (result?.type === 'complete') {
    $('j-workspace').append(el('span', 'j-kicker', 'TURN COMPLETE'), el('p', '', result.message ?? ''), jsonDetails('Final demo workspace', result.workspace));
  }
}
function renderTrace(follow = false) {
  const trace = $('j-trace'); trace.replaceChildren(); let latest = -1;
  events.forEach((event, index) => {
    if (event.type !== 'decision') return;
    latest = index; const result = events[index + 1];
    const button = el('button', 'j-step'); button.type = 'button'; button.dataset.step = String(index); button.setAttribute('aria-pressed', String(index === selected));
    const number = el('span', 'j-step-index', String(event.step).padStart(2, '0'));
    const body = el('span', 'j-step-body'); body.append(el('strong', '', event.tool ?? 'Unknown'), el('code', '', JSON.stringify(event.arguments)));
    const caption = result?.type === 'tool_result' ? result.result?.ok === false ? 'Rejected by tool · feedback returned to Jev' : 'Tool executed · observation returned to Jev' : event.tool === 'finish' ? 'Agent chose to stop' : event.tool === 'clarify' ? 'Agent asks for clarification' : result?.type === 'error' ? 'Run stopped before tool completion' : 'Awaiting tool result';
    body.append(el('small', result?.result?.ok === false ? 'j-warning-text' : '', caption));
    const timing = el('span', 'j-step-time', `${Math.round(event.latency_ms ?? 0)} ms`);
    button.append(number, body, timing); button.addEventListener('click', () => inspect(index)); trace.append(button);
  });
  const decisions = events.filter(e => e.type === 'decision'); const elapsed = decisions.reduce((sum, e) => sum + (e.latency_ms ?? 0), 0);
  $('j-trace-meta').textContent = decisions.length ? `${decisions.length} model decisions · ${(elapsed / 1000).toFixed(2)} s in Jev requests · click any step` : 'The next decision will appear here.';
  const last = events.at(-1);
  $('j-run-status').textContent = last?.type === 'complete' ? last.message! : last?.type === 'error' ? last.message! : running ? 'Agent running… decisions stream from the backend.' : '';
  $('j-run-status').classList.toggle('j-warning-text', last?.type === 'error');
  if (latest >= 0) inspect(follow ? latest : selected); else inspect(-1);
}
function loadRecording(id: string) {
  if (running) return;
  current = runs.find(r => r.id === id) ?? runs[0]; prompt.value = current.prompt; events = current.events; selected = 0;
  $('j-source').textContent = 'RECORDED RUN';
  document.querySelectorAll<HTMLButtonElement>('[data-scenario]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scenario === id)));
  loadButton.textContent = 'Load recorded run'; renderTrace();
}
prompt.addEventListener('input', () => {
  if (running) return;
  if (prompt.value.trim() !== current.prompt.trim()) { events = []; selected = 0; $('j-source').textContent = 'EDITED REQUEST'; loadButton.textContent = 'Restore recorded request'; renderTrace(); }
  else loadRecording(current.id);
  runButton.disabled = !ready || prompt.value.trim().length < 5;
});
loadButton.addEventListener('click', () => loadRecording(current.id));
document.querySelectorAll<HTMLButtonElement>('[data-scenario]').forEach(b => b.addEventListener('click', () => loadRecording(b.dataset.scenario!)));
function setRunning(value: boolean) {
  running = value; prompt.readOnly = value; runButton.disabled = value || !ready; loadButton.disabled = value;
  $('j-stop').hidden = !value;
  document.querySelectorAll<HTMLButtonElement>('[data-scenario], [data-mode]').forEach(b => b.disabled = value);
}
$('j-stop').addEventListener('click', () => controller?.abort());
runButton.addEventListener('click', async () => {
  if (!ready || running) return;
  controller = new AbortController(); events = []; selected = 0; $('j-source').textContent = 'LIVE RUN'; setRunning(true); renderTrace();
  try {
    const response = await fetch('/api/jev/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jev-Demo': '1' }, body: JSON.stringify({ prompt: prompt.value }), signal: controller.signal });
    if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(typeof body?.error === 'string' ? body.error : `Agent runtime returned HTTP ${response.status}.`); }
    if (!response.body) throw new Error('The runtime did not return a stream.');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = '';
    const accept = (line: string) => { if (!line.trim()) return; const event: unknown = JSON.parse(line); if (!validEvent(event)) throw new Error('The runtime returned an invalid event.'); events.push(event); renderTrace(true); };
    while (true) { const chunk = await reader.read(); if (chunk.done) break; pending += decoder.decode(chunk.value, { stream: true }); let newline: number; while ((newline = pending.indexOf('\n')) >= 0) { accept(pending.slice(0, newline)); pending = pending.slice(newline + 1); } }
    pending += decoder.decode(); accept(pending);
    if (!['complete', 'error'].includes(events.at(-1)?.type ?? '')) throw new Error('The stream ended before the agent completed.');
  } catch (error) { events.push({ type: 'error', message: controller.signal.aborted ? 'Stopped. No further decisions will be requested after the in-flight call returns.' : error instanceof Error ? error.message : 'The agent run failed.' }); }
  finally { setRunning(false); renderTrace(); }
});

document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.addEventListener('click', () => {
  for (const mode of ['labs', 'agent', 'prompts']) $(`j-${mode}`).hidden = mode !== button.dataset.mode;
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
}));

let example = prompts[0]; const state = $<HTMLTextAreaElement>('j-state'); const questions = $<HTMLTextAreaElement>('j-questions');
function showPrompt() {
  example = prompts.find(p => p.id === $<HTMLSelectElement>('j-example').value) ?? prompts[0];
  state.value = JSON.stringify(example.request.state, null, 2); questions.value = JSON.stringify(example.request.questions, null, 2); updatePrompt();
}
function updatePrompt() {
  const draft = inspectDraft(state.value, questions.value, example.request); const answers = $('j-answers'); answers.replaceChildren();
  $<HTMLButtonElement>('j-copy').disabled = !draft.ok;
  $('j-edit-status').textContent = !draft.ok ? draft.error! : draft.matchesRecording ? `Original request · ${Math.round(example.latency_ms)} ms recorded latency.` : 'Edited request. Copy into Playground to run a fresh inference.';
  $('j-prompt-note').textContent = '';
  if (!draft.ok || !draft.matchesRecording) { answers.append(el('p', 'j-empty', 'A new prompt needs a new answer. Saved results are hidden while the request is edited.')); return; }
  for (const [id, answer] of Object.entries(example.response.answers)) {
    const view = answerView(example.request.questions[id], answer); const card = el('article', 'j-answer');
    const head = el('div', 'j-answer-head'); head.append(el('h3', '', pretty(id)), el('span', 'j-type', answer.type));
    card.append(head, el('strong', 'j-answer-value', view.value), el('p', '', view.caption));
    const detail = el('details', 'j-data-detail'); detail.append(el('summary', '', 'Prompt, criteria & probabilities'), el('pre', '', JSON.stringify({ question: example.request.questions[id], answer }, null, 2))); card.append(detail); answers.append(card);
  }
  $('j-prompt-note').textContent = example.id.startsWith('code_guard') ? 'Observed miss: the comparison on L2 needs repair. Jev points to L3, even after prompt refinement. The source response is preserved.' : 'These are actual recorded answers to invented examples. Confidence does not guarantee correctness.';
}
state.addEventListener('input', updatePrompt); questions.addEventListener('input', updatePrompt);
$('j-example').addEventListener('change', showPrompt); $('j-restore').addEventListener('click', showPrompt);
$('j-copy').addEventListener('click', async () => {
  const draft = inspectDraft(state.value, questions.value, example.request); if (!draft.ok) return;
  const contents = JSON.stringify(draft.request, null, 2);
  try { await navigator.clipboard.writeText(contents); $('j-edit-status').textContent = 'Copied. Open Playground and paste the state and questions.'; }
  catch {
    const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' })); const a = el('a'); a.href = url; a.download = 'jev-request.json'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('j-edit-status').textContent = 'Clipboard unavailable. Downloaded the request as JSON.';
  }
});
loadRecording(current.id); showPrompt();
if (import.meta.env.DEV) {
  fetch('/api/jev/health').then(r => r.ok ? r.json() : null).then(value => { ready = value?.ready === true; runButton.disabled = !ready; $('j-runtime').textContent = ready ? 'Live Deep Agents runtime connected. Run a request with the server’s TypeSafe key.' : 'Start the local agent runtime to enable live requests. Recorded runs work now.'; }).catch(() => { $('j-runtime').textContent = 'Local runtime not connected. Recorded runs work now.'; });
} else $('j-runtime').textContent = 'Recorded mode · run the local Deep Agents backend to try custom requests. See Code & setup below.';
