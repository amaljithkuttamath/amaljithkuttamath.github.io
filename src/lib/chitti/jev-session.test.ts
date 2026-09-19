import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('./providers',async importOriginal=>({...await importOriginal<typeof import('./providers')>(),complete:vi.fn()}));
vi.mock('./tools',async importOriginal=>({...await importOriginal<typeof import('./tools')>(),findSeriesWithReceipt:vi.fn(async()=>({hits:[{id:'NY.GDP.MKTP.CD',name:'GDP total',source:'worldbank'},{id:'NY.GDP.PCAP.CD',name:'GDP per capita',source:'worldbank'}],receipt:{query:'GDP',sourcesSearched:['World Bank'],candidateCount:2,hitCount:2}}))}));
import {complete} from './providers';
import {createSession} from './session';
import type {TraceEvent} from './receipts';
import {buildSharePayload} from './share';
const model=vi.mocked(complete);
const tool=(name:string,args:Record<string,unknown>,id=name)=>({id,name,arguments:args});
const turn=(toolCalls:ReturnType<typeof tool>[])=>({text:'',toolCalls,usage:{input:10,output:5}});
const checks=['answers_question','supported_by_data','sources_match','chart_matches_data','no_overclaim'];
const route={answers:{dataset:{type:'choice',choice:'candidate_1',probabilities:Object.fromEntries([...Array.from({length:8},(_,i)=>`candidate_${i}`),'none'].map(k=>[k,k==='candidate_1'?.97:k==='none'?.03:0]))}}};
const review={answers:Object.fromEntries(checks.map(id=>[id,{type:'noul',noul:.98}]))};
const cb=()=>{let events:TraceEvent[]=[];return {onTrace:(e:TraceEvent[])=>{events=e;},onFiles:()=>{},onChart:()=>{},onStatus:()=>{},events:()=>events};};
beforeEach(()=>{model.mockReset();vi.stubGlobal('fetch',vi.fn(async()=>Response.json([{page:1,pages:1,total:1},[{country:{value:'India'},countryiso3code:'IND',date:'2020',value:100}]])));});
afterEach(()=>vi.unstubAllGlobals());
function pipeline() {
 model.mockResolvedValueOnce(turn([tool('find_series',{query:'GDP per capita'})]));
 model.mockResolvedValueOnce(turn([tool('fetch_series',{id:'NY.GDP.PCAP.CD',countries:['IND'],ys:2020,ye:2020})]));
 model.mockResolvedValueOnce(turn([tool('render_chart',{type:'bar',title:'GDP per capita',series:[{name:'India',data:[[2020,100]]}]}),tool('finish',{one_line_finding:'India: 100 dollars in 2020.'})]));
}
describe('Jev in the Chitti session',()=>{
 it('uses routing and evidence checks in the real tool loop without a generative verifier call',async()=>{
  pipeline();
  const calls:unknown[]=[];
  const fetcher=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{const body=JSON.parse(init!.body as string);calls.push(body);return Response.json({response:body.task==='chitti_route'?route:review});});
  const capture=cb();
  const out=await createSession({provider:'openrouter',model:'test',apiKey:'never-send-me'},{sources:['worldbank'],jev:{base:'https://jev.test',fetch:fetcher}}).ask('India GDP per capita in 2020',capture);
  expect(model).toHaveBeenCalledTimes(3);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(calls)).not.toContain('never-send-me');
  expect(out.verification?.engine).toBe('jev');expect(out.verification?.pass).toBe(true);
  expect(capture.events().find(e=>e.tool==='jev_route')?.detail).toContain('promoted GDP per capita');
  expect(capture.events().find(e=>e.tool==='verify')?.verifyEngine).toBe('jev');
  expect(JSON.parse((calls[1] as any).inputs.evidence).rows[0].value).toBe(100);
 });
 it('does not retry the agent when Jev review is unavailable',async()=>{
  pipeline(); const fetcher=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>JSON.parse(init!.body as string).task==='chitti_route'?Response.json({response:route}):new Response('',{status:429}));
  const out=await createSession({provider:'openrouter',model:'test',apiKey:'x'},{sources:['worldbank'],jev:{base:'https://jev.test',fetch:fetcher}}).ask('India GDP per capita in 2020',cb());
  expect(out.verification?.status).toBe('unavailable');expect(out.retried).toBe(false);expect(model).toHaveBeenCalledTimes(3);
 });
 it('preserves Jev provenance in shared answers and strips unknown verifier fields',()=>{
  const state=buildSharePayload({question:'q',answer:'a',spec:null,rows:[],citations:[],verification:{engine:'jev',status:'verified',confidence:'none',issues:[],apiKey:'secret'} as any});
  expect(state.verification?.engine).toBe('jev');expect(JSON.stringify(state)).not.toContain('secret');
 });
});
