// Composer flow: the "+ new question" two-step confirm (arm -> wipe) and the
// destructive thread reset. Extracted verbatim. Owns its private newQuestion*
// state; boot keeps the actual event-listener registrations (order unchanged)
// and points them at these handlers. unlockSources comes from config.ts.
import { run, allTurns, liveChartTurns, consoleEl, threadEl, newConvoBtn, composerQ } from './state';
import { unlockSources } from './config';

// ── "+ new question" (non-destructive two-step reset) ────────────────────
// The reset is genuinely destructive: it wipes the whole thread AND unlocks
// the source picker (the session's databases can only be changed by starting
// over). This thread model keeps every turn as full history — there is no
// collapsed-turn pattern to fold prior turns into — so rather than silently
// discarding history on one accidental tap, the chip ARMS a confirm: the
// first click turns it into "wipe N turns + start fresh?" for a few seconds;
// only a second click within that window actually resets. Any click
// elsewhere, or the timeout, disarms it. No window.confirm (kept inline).
let newQuestionArmed = false;
let newQuestionTimer: number | null = null;

export function resetNewQuestionChip() {
  newQuestionArmed = false;
  if (newQuestionTimer !== null) {
    clearTimeout(newQuestionTimer);
    newQuestionTimer = null;
  }
  newConvoBtn.textContent = '+ new question';
  newConvoBtn.classList.remove('ch-new-convo-armed');
}

export function performNewQuestion() {
  resetNewQuestionChip();
  run.session = null;
  unlockSources();
  // Dispose live charts before clearing the DOM so ECharts releases its
  // global registry entry and resize listener.
  for (const tb of liveChartTurns) {
    tb.chartInstance?.dispose();
    tb.chartInstance = null;
  }
  threadEl.innerHTML = '';
  allTurns.length = 0;
  liveChartTurns.length = 0;
  // Back to the empty state: the setup panel (chips + BYOK) returns; the
  // composer drops back to the first-question placeholder; the chip hides.
  consoleEl.style.display = '';
  newConvoBtn.style.display = 'none';
  composerQ.placeholder = 'Ask about the world…';
  composerQ.value = '';
  composerQ.focus();
}

export function handleNewConvoClick() {
  // Never-stuck: a mid-run click stops the current turn first, so the reset
  // proceeds against a settled session instead of racing an in-flight ask().
  if (run.running && run.runController) run.runController.abort();

  if (!newQuestionArmed) {
    const n = allTurns.length;
    newQuestionArmed = true;
    newConvoBtn.textContent = `wipe ${n} turn${n === 1 ? '' : 's'} + start fresh?`;
    newConvoBtn.classList.add('ch-new-convo-armed');
    // Auto-disarm so an armed chip never lingers into the next glance.
    newQuestionTimer = window.setTimeout(resetNewQuestionChip, 4000);
    return;
  }
  // Second, deliberate click within the window → actually reset.
  performNewQuestion();
}

export function maybeDisarmOnClick(e: MouseEvent) {
  if (
    newQuestionArmed &&
    e.target !== newConvoBtn &&
    !newConvoBtn.contains(e.target as Node)
  ) {
    resetNewQuestionChip();
  }
}
