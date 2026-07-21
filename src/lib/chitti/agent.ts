// agent.ts — the Chitti agent's public facade. Phase A split the former
// monolith into focused modules by responsibility; this file re-exports every
// prior symbol so all existing `import { ... } from './agent'` keeps working
// unchanged. Module map:
//   ./session          — createSession + the per-turn closures, session state,
//                         session types (ChittiSession/SessionOptions/
//                         AgentCallbacks/AgentOutput), runAgent, buildRejectionSteer
//   ./prompts          — buildSystemPrompt / buildSubAgentPrompt
//   ./planner          — needsPlan / parsePlanBrief / matchStepToEvent +
//                         countCountryMentions + PlanStep/InsightBrief
//   ./verifier         — verify / parseVerifierVerdict + verdict types
//   ./spec             — normalizeSpec
//   ./receipts         — TraceEvent
//   ./dashboards-agent — resolveTileRef / refreshDashboard / refreshTile /
//                         defaultDashboardTitle + TileRefreshResult
//   ./budgets          — the per-turn budget constants
// See ./ARCHITECTURE.md for the full layering.

export * from './session';
export { buildSystemPrompt, buildSubAgentPrompt } from './prompts';
export {
  needsPlan,
  countCountryMentions,
  parsePlanBrief,
  matchStepToEvent,
  type PlanStep,
  type InsightBrief,
} from './planner';
export {
  parseVerifierVerdict,
  type VerifyStatus,
  type VerificationVerdict,
  type ParsedVerdict,
} from './verifier';
export { normalizeSpec } from './spec';
export type { TraceEvent } from './receipts';
export {
  resolveTileRef,
  refreshDashboard,
  defaultDashboardTitle,
  refreshTile,
  type TileRefreshResult,
} from './dashboards-agent';
