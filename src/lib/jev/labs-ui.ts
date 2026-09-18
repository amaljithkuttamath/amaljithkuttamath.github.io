import catalog from '../../data/jev/labs.json';
import captured from '../../data/jev/lab-recordings.json';
import { answerView, pretty, type Request } from './model';
import { buildLabRequest, validateLabResponse, reviewDecision, leadComposite, type Lab, type LabRecording } from './labs';
const tasks = catalog as unknown as Lab[];
const recordings = captured as unknown as LabRecording[];
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => { const node = document.createElement(tag); node.className = cls; node.textContent = text; return node; };
let task = tasks[0], example = task.examples[0];
let result: LabRecording | undefined;
let live = false, ready = false, running = false;
let controller: AbortController | undefined;
const controls = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
const run = $<HTMLButtonElement>('jl-run');
const selector = $<HTMLSelectElement>('jl-example');
const threshold = $<HTMLInputElement>('jl-threshold');
function inputs() { return Object.fromEntries([...controls].map(([id, input]) => [id, input.value])); }
function request(): Request { return buildLabRequest(task, inputs()); }
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = element('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function showResult() {
  const target = $('jl-results'); target.replaceChildren();
  $('jl-threshold-value').textContent = `${threshold.value}%`;
  $('jl-response').textContent = result ? JSON.stringify(result.response, null, 2) : 'No response for this input.';
  $<HTMLButtonElement>('jl-download').disabled = !result;
  $('jl-origin').textContent = result ? live ? 'LIVE RESULT' : 'RECORDED RESULT' : 'NO RESULT';
  $('jl-meta').textContent = result ? `${Math.round(result.latency_ms)} ms · ${new Date(result.recorded_at).toLocaleDateString()} · ${result.request.model}` : '';
  if (!result) { target.append(element('p', 'j-empty', running ? 'Jev is evaluating the supplied text…' : 'Edited text needs a fresh inference. Run locally, copy the request into Playground, or restore an example.')); return; }
  const primary = result.response.answers[task.primary];
  const decision = reviewDecision(primary, Number(threshold.value) / 100);
  const summary = element('div', 'jl-verdict');
  summary.append(element('span', 'j-kicker', pretty(task.primary)), element('strong', 'j-answer-value', pretty(decision.label)));
  summary.append(element('p', '', `${Math.round(decision.probability * 100)}% selected-label probability`));
  summary.append(element('span', decision.review ? 'jl-review' : 'jl-pass', decision.review ? 'Send to human review' : 'Meets the chosen threshold'));
  target.append(summary);
  if (task.id === 'leads') target.append(element('p', 'jl-composite', `Composite: ${leadComposite(result.response.answers).toFixed(1)} / 100 · 50% fit + 30% intent + 20% timing. A rubric score, not a sale probability.`));
  for (const [id, question] of Object.entries(task.questions)) {
    const answer = result.response.answers[id], view = answerView(question, answer);
    const card = element('article', 'j-answer jl-answer');
    const head = element('div', 'j-answer-head'); head.append(element('h3', '', pretty(id)), element('span', 'j-type', question.type)); card.append(head);
    if (id !== task.primary) card.append(element('strong', 'j-answer-value', view.value), element('p', '', view.caption));
    const bars = element('div', 'j-bars');
    for (const value of view.bars) {
      const row = element('div', 'j-bar'), heading = element('div', 'j-bar-label'), track = element('div', 'j-bar-track'), fill = element('i');
      heading.append(element('span', '', value.label), element('span', '', `${value.percent}%`));
      fill.style.width = `${value.percent}%`; track.append(fill); row.append(heading, track); bars.append(row);
    }
    card.append(bars); target.append(card);
  }
}
function edited() {
  live = false; result = undefined;
  try {
    const payload = request();
    $('jl-request').textContent = JSON.stringify(payload, null, 2);
    // A saved answer belongs to the exact state AND question set that produced it.
    result = recordings.find(r => r.task === task.id && JSON.stringify(r.request) === JSON.stringify(payload));
    if (result && !validateLabResponse(task, result.response)) result = undefined;
    $('jl-status').textContent = result ? 'Showing an actual saved Jev response to this exact request.' : 'Input changed. Saved answers are hidden until a matching example is restored.';
    run.disabled = !ready || running; $<HTMLButtonElement>('jl-copy').disabled = false;
  } catch (error) {
    $('jl-request').textContent = '';
    $('jl-status').textContent = error instanceof Error ? error.message : 'Check the input.';
    run.disabled = true; $<HTMLButtonElement>('jl-copy').disabled = true;
  }
  showResult();
}
function loadExample() {
  example = task.examples.find(e => e.id === selector.value) ?? task.examples[0];
  for (const [id, input] of controls) input.value = example.inputs[id];
  edited();
}
function selectTask(id: string) {
  if (running) return;
  task = tasks.find(t => t.id === id) ?? tasks[0];
  document.querySelectorAll<HTMLButtonElement>('[data-lab]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lab === task.id)));
  $('jl-title').textContent = task.title; $('jl-description').textContent = task.description; $('jl-note').textContent = task.note;
  $<HTMLAnchorElement>('jl-source').href = task.source;
  selector.replaceChildren();
  for (const sample of task.examples) { const option = element('option', '', sample.label); option.value = sample.id; selector.append(option); }
  const fields = $('jl-fields'); fields.replaceChildren(); controls.clear();
  for (const field of task.fields) {
    const group = element('div', 'jl-field'), label = element('label', '', field.label);
    const input = field.multiline ? element('textarea') : element('input');
    input.id = `jl-field-${field.id}`; label.htmlFor = input.id; input.maxLength = field.maxLength;
    if (input instanceof HTMLTextAreaElement) input.rows = field.id === 'text' ? 7 : 4;
    input.spellcheck = false; input.addEventListener('input', edited); controls.set(field.id, input); group.append(label, input); fields.append(group);
  }
  loadExample();
}
function setRunning(value: boolean) {
  running = value;
  for (const input of controls.values()) input.readOnly = value;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-lab], [data-mode]')) button.disabled = value;
  selector.disabled = value; $<HTMLButtonElement>('jl-restore').disabled = value;
  $<HTMLButtonElement>('jl-copy').disabled = value;
  run.disabled = value || !ready; $('jl-stop').hidden = !value;
}
for (const [index, lab] of tasks.entries()) {
  const button = element('button', 'jl-task'); button.type = 'button'; button.dataset.lab = lab.id;
  button.append(element('span', 'j-kicker', String(index + 1).padStart(2, '0')), element('strong', '', lab.title), element('span', 'jl-task-arrow', '↗'));
  button.addEventListener('click', () => selectTask(lab.id)); $('jl-tasks').append(button);
}
selector.addEventListener('change', loadExample);
$('jl-restore').addEventListener('click', loadExample);
threshold.addEventListener('input', showResult);
$('jl-copy').addEventListener('click', async () => {
  let payload: Request; try { payload = request(); } catch { return; }
  try { await navigator.clipboard.writeText(JSON.stringify(payload, null, 2)); $('jl-status').textContent = 'Request copied. Paste its state and questions into TypeSafe Playground.'; }
  catch { download(payload, `jev-${task.id}-request.json`); $('jl-status').textContent = 'Clipboard unavailable. Request downloaded as JSON.'; }
});
$('jl-download').addEventListener('click', () => { if (result) download(result, `jev-${task.id}-result.json`); });
$('jl-stop').addEventListener('click', () => controller?.abort());
run.addEventListener('click', async () => {
  if (running || !ready) return;
  let payload: Request; try { payload = request(); } catch { return; }
  result = undefined; live = true; controller = new AbortController(); setRunning(true); showResult();
  $('jl-status').textContent = 'Sending this input to TypeSafe through the local backend…';
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller?.abort(); }, 35000);
  try {
    const response = await fetch('/api/jev/classify', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jev-Demo': '1' }, body: JSON.stringify({ task: task.id, inputs: payload.state }), signal: controller.signal });
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : `Runtime returned HTTP ${response.status}.`);
    if (!validateLabResponse(task, value?.response) || typeof value?.latency_ms !== 'number' || !Number.isFinite(value.latency_ms)) throw new Error('The runtime returned an invalid classification.');
    result = { task: task.id, example: 'custom', request: payload, response: value.response, latency_ms: value.latency_ms, recorded_at: new Date().toISOString() };
    $('jl-status').textContent = 'Live inference complete. These answers belong to the current input.';
  } catch (error) {
    $('jl-status').textContent = controller.signal.aborted ? timedOut ? 'The request timed out. Try again.' : 'Stopped. The in-flight server call may still finish.' : error instanceof Error ? error.message : 'Classification failed.';
  } finally { clearTimeout(timeout); setRunning(false); showResult(); }
});
selectTask(task.id);
if (import.meta.env.DEV) {
  fetch('/api/jev/health').then(r => r.ok ? r.json() : null).then(value => {
    ready = value?.ready === true;
    try { request(); run.disabled = !ready || running; } catch { run.disabled = true; }
    $('jl-runtime').textContent = ready ? 'Live local runtime connected. Your input is sent to TypeSafe when you classify.' : 'Start the local backend to classify custom text. Saved examples work now.';
  }).catch(() => { $('jl-runtime').textContent = 'Local runtime unavailable. Explore saved examples or copy a request into Playground.'; });
} else $('jl-runtime').textContent = 'Recorded mode on GitHub Pages. Custom text needs the local backend or TypeSafe Playground; the API key stays private.';
