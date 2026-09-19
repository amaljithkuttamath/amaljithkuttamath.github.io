import catalog from '../../src/data/jev/labs.json';
import chittiTasks from '../../src/data/jev/chitti-tasks.json';
import { buildLabRequest, validateLabResponse, type LabSpec } from '../../src/lib/jev/labs';
const tasks = [...catalog, ...chittiTasks] as unknown as LabSpec[];
const ORIGIN = 'https://amaljithkuttamath.github.io';
export const LIMITS = { perMinute: 5, perDay: 20, dailyTotal: 200 } as const;
export interface QuotaState { day: number; total: number; clients: Record<string, { total: number; minute: number; count: number }> }
export function consumeQuota(previous: QuotaState | undefined, client: string, now: number) {
  const day = Math.floor(now / 86400000), minute = Math.floor(now / 60000);
  const state: QuotaState = previous?.day === day ? structuredClone(previous) : { day, total: 0, clients: {} };
  const ip = state.clients[client] ?? { total: 0, minute, count: 0 };
  if (ip.minute !== minute) { ip.minute = minute; ip.count = 0; }
  const dailyBlocked = state.total >= LIMITS.dailyTotal || ip.total >= LIMITS.perDay;
  if (dailyBlocked || ip.count >= LIMITS.perMinute) return { allowed: false, retryAfter: Math.max(1, Math.ceil(((dailyBlocked ? (day + 1) * 86400000 : (minute + 1) * 60000) - now) / 1000)), state };
  state.total++; ip.total++; ip.count++; state.clients[client] = ip;
  return { allowed: true, retryAfter: 0, state };
}
export interface Dependencies {
  key: string;
  reserve: (client: string, now: number) => Promise<{allowed: boolean; retryAfter: number}>;
  upstream: typeof fetch;
  now: () => number;
}
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
class OversizedBody extends Error {}
async function readBody(request: Request) {
  if (Number(request.headers.get('Content-Length')) > 32768) throw new OversizedBody();
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const {done, value} = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 32768) { await reader.cancel(); throw new OversizedBody(); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function clientHash(ip: string, key: string, now: number) {
  const encoder = new TextEncoder();
  const secret = await crypto.subtle.importKey('raw', encoder.encode(key), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC',secret,encoder.encode(`${Math.floor(now/86400000)}:${ip}`));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function handle(request: Request, deps: Dependencies): Promise<Response> {
  const origin = request.headers.get('Origin');
  const headers: Record<string,string> = { 'Content-Type':'application/json', 'Cache-Control':'no-store', 'Vary':'Origin', 'X-Content-Type-Options':'nosniff' };
  if (origin === ORIGIN) Object.assign(headers, {'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Expose-Headers':'Retry-After'});
  const reply = (status: number, value: unknown, extra: Record<string,string> = {}) => new Response(JSON.stringify(value), {status,headers:{...headers,...extra}});
  if (origin !== ORIGIN) return reply(403,{error:'Origin not allowed.'});
  const path = new URL(request.url).pathname;
  if (!['/api/jev/classify','/api/jev/health'].includes(path)) return reply(404,{error:'Not found.'});
  if (request.method === 'OPTIONS') return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-Jev-Demo','Access-Control-Max-Age':'600'}});
  if (path === '/api/jev/health' && request.method === 'GET') return reply(200,{ready:!!deps.key,mode:'public_classification',limits:LIMITS});
  if (path !== '/api/jev/classify' || request.method !== 'POST') return reply(405,{error:'Method not allowed.'});
  if (request.headers.get('X-Jev-Demo') !== '1' || !request.headers.get('CF-Connecting-IP')) return reply(403,{error:'Request not allowed.'});
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return reply(415,{error:'Send a JSON request.'});
  if (!deps.key) return reply(503,{error:'Live classification is not configured yet.'});
  let task: LabSpec | undefined, payload;
  try {
    const body = await readBody(request);
    if (!isObject(body) || Object.keys(body).sort().join(',') !== 'inputs,task' || typeof body.task !== 'string' || !isObject(body.inputs)) throw new Error();
    task = tasks.find(t=>t.id===body.task);
    if (!task || Object.keys(body.inputs).sort().join(',') !== task.fields.map(f=>f.id).sort().join(',') || !Object.values(body.inputs).every(v=>typeof v==='string')) throw new Error();
    payload = buildLabRequest(task,body.inputs as Record<string,string>);
  } catch (error) { return reply(error instanceof OversizedBody ? 413 : 400,{error:error instanceof OversizedBody ? 'Input is too large.' : 'Check the task and required input fields.'}); }
  const started = deps.now();
  try {
    const client = await clientHash(request.headers.get('CF-Connecting-IP')!,deps.key,started);
    const quota = await deps.reserve(client,started);
    if (!quota.allowed) return reply(429,{error:'The demo usage limit has been reached. Try again after the indicated wait.',retry_after:quota.retryAfter},{'Retry-After':String(quota.retryAfter)});
  } catch { return reply(503,{error:'Usage checks are temporarily unavailable. Try again later.'}); }
  // Reserve before the provider call and do not refund: failures and retries also consume the hard cap.
  try {
    const upstream = await deps.upstream('https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${deps.key}`},body:JSON.stringify(payload),signal:AbortSignal.timeout(25000),redirect:'manual'});
    if (!upstream.ok) { await upstream.body?.cancel(); return reply(502,{error:'The model service could not complete this request. Try again later.'}); }
    const result = await upstream.json();
    if (!validateLabResponse(task,result)) return reply(502,{error:'The model returned an invalid classification.'});
    return reply(200,{response:result,latency_ms:Math.max(0,deps.now()-started)});
  } catch { return reply(502,{error:'The model service is temporarily unavailable. Try again later.'}); }
}
