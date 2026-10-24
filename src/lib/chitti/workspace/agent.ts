import { exportTurnTrace } from "../tracing";
import { AbstractAgent } from "@ag-ui/client";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { Observable } from "rxjs";
import {
  createSession,
  type ChittiSession,
  type SessionOptions,
} from "../session";
import { editView, type ViewEdit } from "./steering";
import { parseFastPath, runFastPath } from "../fastpath";
import { cleanShareState, type ShareStateV1 } from "../share";
import {
  resultSurface,
  questionSurface,
  type Analysis,
  type Settings,
  type Question,
} from "./model";

/** One adapter translates the existing source/agent engine to standard AG-UI events.
 * Credentials stay in private configuration, never in state, messages, or surfaces. */
export class ChittiAgent extends AbstractAgent {
  private workspace: ShareStateV1 | null = null;
  private viewEdit: ViewEdit | null = null;
  private session: ChittiSession | null = null;
  private settings: Settings;
  private controller: AbortController | null = null;
  private answer: ((value: string) => void) | null = null;
  private pendingQuestion: Question | null = null;
  private forceAgent = false;
  private stopRequested = false;
  private inputHandler: SessionOptions["requestInput"];
  constructor(
    settings: Settings,
    private dependencies = { createSession, runFastPath },
  ) {
    super({
      agentId: "chitti",
      initialState: { analysis: null, question: null },
    });
    this.settings = settings;
  }
  get sessionLocked() {
    return this.session !== null;
  }
  configure(settings: Settings) {
    if (this.isRunning || this.session)
      throw new Error("Start a new analysis to change model or sources.");
    this.settings = settings;
  }
  useWorkspace(result: ShareStateV1 | null, edit?: ViewEdit) {
    if (this.isRunning)
      throw new Error("Wait for the current run or stop it first.");
    this.workspace = result ? cleanShareState(result) : null;
    if (!this.workspace) this.session = null;
    this.viewEdit = edit || null;
  }
  reset() {
    this.workspace = null;
    this.viewEdit = null;
    this.stop();
    this.session = null;
    this.forceAgent = false;
    this.setMessages([]);
    this.setState({ analysis: null, question: null });
  }
  escalate() {
    this.forceAgent = true;
  }
  respond(id: string, value: string) {
    if (this.pendingQuestion?.id !== id || !value.trim() || !this.answer)
      return false;
    this.answer(value.trim().slice(0, 2000));
    return true;
  }
  stop() {
    if (this.isRunning) this.stopRequested = true;
    this.controller?.abort();
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((sink) => {
      const controller = new AbortController();
      this.controller = controller;
      if (this.stopRequested) controller.abort();
      this.stopRequested = false;
      const last = [...input.messages].reverse().find((m) => m.role === "user");
      const question =
        typeof last?.content === "string" ? last.content.trim() : "";
      const forceAgent = this.forceAgent;
      this.forceAgent = false;
      const workspace = this.workspace;
      const viewEdit = this.viewEdit;
      this.workspace = null;
      this.viewEdit = null;
      const startedAt = Date.now();
      const cfg = { ...this.settings, sources: [...this.settings.sources] };
      const analysis: Analysis = {
        id: input.runId,
        question,
        phase: "running",
        status: "Finding data",
        origin: "direct",
        result: null,
        trace: [],
        files: {},
      };
      const send = (event: BaseEvent) => {
        if (!sink.closed) sink.next(event);
      };
      const publish = () =>
        send({
          type: EventType.STATE_SNAPSHOT,
          snapshot: {
            analysis: { ...analysis },
            question: this.pendingQuestion,
          },
        } as BaseEvent);
      const surface = (operations: unknown[]) =>
        send({
          type: EventType.CUSTOM,
          name: "a2ui",
          value: { operations },
        } as BaseEvent);
      const patch = (value: Partial<Analysis>) => {
        if (!controller.signal.aborted) {
          Object.assign(analysis, value);
          publish();
        }
      };
      const finish = () => {
        send({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
        sink.complete();
      };
      const trace = (events: Analysis["trace"]) =>
        patch({ trace: structuredClone(events) });
      const requestInput: NonNullable<SessionOptions["requestInput"]> = (
        q,
        signal,
      ) =>
        new Promise((resolve, reject) => {
          if (signal?.aborted || controller.signal.aborted) {
            reject(new Error("Stopped"));
            return;
          }
          const pending = { id: crypto.randomUUID(), ...q };
          this.pendingQuestion = pending;
          patch({ phase: "waiting", status: "Needs your input" });
          surface(questionSurface(pending));
          const abort = () => {
            cleanup();
            reject(new Error("Stopped"));
          };
          const cleanup = () => {
            controller.signal.removeEventListener("abort", abort);
            signal?.removeEventListener("abort", abort);
            this.answer = null;
            this.pendingQuestion = null;
          };
          this.answer = (value) => {
            cleanup();
            patch({ phase: "running", status: "Continuing with your answer" });
            resolve(value);
          };
          controller.signal.addEventListener("abort", abort, { once: true });
          signal?.addEventListener("abort", abort, { once: true });
        });
      this.inputHandler = requestInput;
      send({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      publish();
      void (async () => {
        try {
          if (controller.signal.aborted) return;
          if (!question) throw new Error("Enter a data question.");
          if (!cfg.sources.length)
            throw new Error("Select at least one data source in Settings.");
          if (workspace && viewEdit) {
            const result = editView(workspace, viewEdit);
            if (!result)
              throw new Error("This view cannot be changed that way.");
            patch({
              result,
              origin: "view",
              phase: "done",
              status: "View updated; no model or new fetch",
            });
            surface(resultSurface(result));
            return;
          }
          const plan =
            !workspace && !this.session && !forceAgent
              ? parseFastPath(question)
              : null;
          if (plan) {
            const timeout = AbortSignal.timeout(20_000);
            const signal = AbortSignal.any([controller.signal, timeout]);
            let directActive = true;
            try {
              const result = await Promise.race([
                this.dependencies.runFastPath(plan, {
                  sources: cfg.sources,
                  onTrace: (events) => {
                    if (directActive) trace(events);
                  },
                  signal,
                }),
                new Promise<never>((_, reject) =>
                  signal.addEventListener(
                    "abort",
                    () => reject(new Error("Direct lookup stopped")),
                    { once: true },
                  ),
                ),
              ]);
              if (controller.signal.aborted) return;
              if ("spec" in result) {
                analysis.result = cleanShareState({
                  v: 1,
                  q: question,
                  answer:
                    result.summary || `${result.rows.length} values retrieved.`,
                  spec: result.spec,
                  rows: result.rows,
                  citations: result.citations,
                  verification: null,
                  ts: new Date().toISOString(),
                });
                patch({
                  phase: "done",
                  status: "Direct from source; no model used",
                  trace: result.trace,
                });
                surface(resultSurface(analysis.result!));
                return;
              }
            } catch {
              if (controller.signal.aborted) return;
            } finally {
              directActive = false;
            }
          }
          if (!cfg.apiKey.trim()) {
            patch({
              phase: "needs-key",
              status:
                "This question needs a model. Connect one in Settings, then retry.",
            });
            return;
          }
          this.forceAgent = false;
          patch({
            origin: "agent",
            status: "Planning analysis",
            model: cfg.model,
          });
          if (workspace) this.session = null;
          this.session ||= this.dependencies.createSession(cfg, {
            workspace: workspace || undefined,
            sources: cfg.sources,
            rlm: cfg.rlm,
            jev: cfg.jev,
            requestInput: (question, signal) =>
              this.inputHandler
                ? this.inputHandler(question, signal)
                : Promise.reject(new Error("No active run")),
          });
          const output = await this.session.ask(
            question,
            {
              onTrace: trace,
              onFiles: (files) => patch({ files: { ...files } }),
              onChart: () =>
                patch({ status: "Chart prepared; checking evidence" }),
              onPreview: (preview) => {
                if (controller.signal.aborted) return;
                const result = cleanShareState({
                  v: 1,
                  q: question,
                  answer: "",
                  spec: preview.chartSpec,
                  rows: preview.rows,
                  citations: preview.citations,
                  verification: null,
                  ts: new Date().toISOString(),
                });
                if (result) {
                  patch({ result, status: "Draft chart; checking evidence" });
                  surface(resultSurface(result));
                }
              },
              onStatus: (status) => patch({ status }),
              onModel: (model) => patch({ model }),
            },
            controller.signal,
          );
          const result = cleanShareState({
            v: 1,
            q: question,
            answer: output.finding,
            spec: output.chartSpec || workspace?.spec || null,
            rows: output.rows,
            citations: output.citations,
            verification:
              output.aborted || (!output.chartSpec && workspace?.spec)
                ? null
                : output.verification,
            ts: new Date().toISOString(),
          });
          analysis.result = result;
          analysis.cost = output.cost;
          if (output.aborted || controller.signal.aborted) {
            analysis.phase = "stopped";
            analysis.status = "Stopped. Partial results retained.";
            publish();
          } else
            patch({
              phase: "done",
              status:
                output.verification?.status === "verified"
                  ? "Evidence check passed"
                  : "Analysis complete",
            });
          if (result) {
            surface(resultSurface(result));
            if (result.answer) {
              const messageId = crypto.randomUUID();
              send({
                type: EventType.TEXT_MESSAGE_START,
                messageId,
                role: "assistant",
              } as BaseEvent);
              send({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId,
                delta: result.answer,
              } as BaseEvent);
              send({
                type: EventType.TEXT_MESSAGE_END,
                messageId,
              } as BaseEvent);
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            analysis.phase = "error";
            analysis.status =
              error instanceof Error ? error.message : "Analysis failed";
            publish();
            send({
              type: EventType.RUN_ERROR,
              message: analysis.status,
            } as BaseEvent);
            sink.complete();
            return;
          }
        } finally {
          this.pendingQuestion = null;
          this.answer = null;
          this.inputHandler = undefined;
          this.stopRequested = false;
          if (controller.signal.aborted && analysis.phase !== "stopped") {
            analysis.phase = "stopped";
            analysis.status = "Stopped";
            publish();
          }
          if (this.controller === controller) this.controller = null;
          void exportTurnTrace({
            question,
            trace: analysis.trace,
            model: cfg.model,
            provider: cfg.provider,
            finding: analysis.result?.answer,
            verification: analysis.result?.verification,
            cost: analysis.cost,
            aborted: controller.signal.aborted,
            error: analysis.phase === "error" ? analysis.status : undefined,
            startedAt,
            endedAt: Date.now(),
          });
          if (!sink.closed) finish();
        }
      })();
      return () => {
        controller.abort();
      };
    });
  }
}
