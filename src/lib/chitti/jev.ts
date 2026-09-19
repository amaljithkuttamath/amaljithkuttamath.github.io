// Optional typed judgments over existing search candidates and fetched evidence.
// One client per turn keeps the call budget shared across parent/sub-agent work.
import tasks from '../../data/jev/chitti-tasks.json';
import { buildLabRequest, validateLabResponse, type LabResponse, type LabSpec } from '../jev/labs';
import type { ChartSpec, DataRow, Citation } from './tools';
import type { SeriesHit } from './sources/types';
import type { VerificationVerdict } from './verifier';

export interface JevConfig { base: string; fetch?: typeof fetch }
export interface JevEvidence {
  question: string;
  finding: string;
  spec: ChartSpec | null;
  rows: DataRow[];
  citations: Pick<Citation, 'source' | 'sourceLabel' | 'indicatorId' | 'indicatorName' | 'url'>[];
  intendedInsight?: string;
}
const ROUTE_THRESHOLD = .8;
const REVIEW_THRESHOLD = .9;
const labels: Record<string,string> = {
  answers_question: 'Answer addresses the question',
  supported_by_data: 'Claims supported by fetched rows',
  sources_match: 'Source definitions match the claims',
  chart_matches_data: 'Chart agrees with fetched rows',
  no_overclaim: 'Claims stay within the evidence',
};

export function createJevAssist(config: JevConfig, signal?: AbortSignal) {
  let routes = 0, reviews = 0;
  const fetcher = config.fetch ?? fetch;
  const stopped = () => signal?.throwIfAborted();
  async function call(id: string, inputs: Record<string,string>) {
    stopped();
    const task = tasks.find(t => t.id === id)! as unknown as LabSpec;
    buildLabRequest(task, inputs); // Enforce the same bounds as the server before sending.
    const body = JSON.stringify({task:id, inputs});
    if (new TextEncoder().encode(body).length > 32768) throw new Error('Evidence exceeds the request limit; no partial review was sent.');
    const response = await fetcher(`${config.base}/api/jev/classify`, {
      method:'POST', headers:{'Content-Type':'application/json','X-Jev-Demo':'1'}, body,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(response.status === 429 ? 'Shared Jev usage limit reached.' : 'Jev service unavailable.');
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || !('response' in value) || !validateLabResponse(task,value.response)) throw new Error('Jev returned invalid answers.');
    const raw = value.response as LabResponse;
    return raw;
  }
  const failure = (error: unknown) => {
    stopped(); // Cancellation is never converted to a model verdict or silent routing fallback.
    return error instanceof Error && /^(Shared Jev|Jev |Evidence |Answer and fetched evidence:|Data question:|Dataset candidates:)/.test(error.message)
      ? error.message : 'Jev request failed or timed out.';
  };
  return {
    async route(query: string, hits: SeriesHit[]) {
      stopped();
      if (!hits.length) return {hits, report:'Jev routing skipped: no candidates.'};
      if (routes++ >= 2) return {hits, report:'Jev routing budget reached (two attempts per turn); original order retained.'};
      try {
        const candidates = hits.slice(0,8).map(({id,name,source})=>({id,name,source}));
        const raw = await call('chitti_route', {query, candidates:JSON.stringify(candidates)});
        const answer = raw.answers.dataset;
        const probability = answer.probabilities![answer.choice!];
        const index = /^candidate_[0-7]$/.test(answer.choice!) ? Number(answer.choice!.slice(-1)) : -1;
        const selected = index >= 0 ? candidates[index] : undefined;
        const accept = !!selected && probability >= ROUTE_THRESHOLD;
        return {
          hits: accept ? [hits[index], ...hits.filter((_,i)=>i!==index)] : hits,
          report: `${accept ? `Jev promoted ${selected!.name}` : 'Jev abstained; original search order retained'} (${Math.round(probability*100)}% selected-label probability; 80% uncalibrated cutoff). Only the first ${candidates.length} candidates were reviewed.\n${JSON.stringify(raw)}`,
        };
      } catch (error) { return {hits, report:`${failure(error)} Original search order retained.`}; }
    },
    async review(input: JevEvidence): Promise<VerificationVerdict> {
      stopped();
      const verdict = (status: VerificationVerdict['status'], report: string, issues: string[] = []): VerificationVerdict => ({
        engine:'jev', status, pass:status==='verified', confidence:'none', issues, report,
      });
      if (reviews++ >= 2) return verdict('unavailable','Jev review budget reached (two attempts per turn).');
      if (!input.rows.some(row=>row.value !== null && Number.isFinite(row.value)) || !input.citations.length) {
        return verdict('unverified','Jev review could not establish support: fetched numeric rows and source citations are required.', ['Missing fetched numeric evidence or citations.']);
      }
      try {
        // Whitelist fields. No API credentials, VFS files, conversation history,
        // or provider config can enter this independent request. Never truncate rows.
        const evidence = JSON.stringify({
          question:input.question, finding:input.finding, chart:input.spec,
          rows:input.rows.map(({country,iso3,year,value,indicator})=>({country,iso3,year,value,indicator})),
          citations:input.citations.map(({source,sourceLabel,indicatorId,indicatorName})=>({source,sourceLabel,indicatorId,indicatorName})),
          intendedInsight:input.intendedInsight ?? '',
        });
        if (evidence.length > 22000) return verdict('unavailable','Evidence exceeds the Jev review limit; no partial review was sent.');
        const raw = await call('chitti_review',{evidence});
        const issues = Object.entries(labels).filter(([id])=>raw.answers[id].noul! < REVIEW_THRESHOLD)
          .map(([id,label])=>`${label}: ${Math.round(raw.answers[id].noul!*100)}% yes probability, below the 90% review cutoff.`);
        const status = issues.length ? 'unverified' : 'verified';
        const report = `Jev evidence review ${issues.length ? 'flagged gaps' : 'passed the configured checks'}.\n${issues.join('\n')}\nPolicy: every check must reach 90%; this cutoff is not calibrated and a pass does not establish correctness. All ${input.rows.length} supplied rows were included.\n${JSON.stringify(raw,null,2)}`;
        return verdict(status,report,issues);
      } catch (error) { return verdict('unavailable',failure(error)); }
    },
  };
}
