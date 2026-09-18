import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
let providerCalls=0;
const recorded=JSON.parse(readFileSync('../../src/data/jev/lab-recordings.json','utf8'))[0].response;
const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:"jev-test",bindings:{TYPESAFE_API_KEY:'test-only-secret'},outboundService:async request=>{providerCalls++;assert.equal(request.url,'https://api.typesafe.ai/v1/systemone');assert.equal(request.headers.get('Authorization'),'Bearer test-only-secret');return Response.json(recorded);},modules:true,script:readFileSync('../../.worker-build/index.js','utf8'),compatibilityDate:'2026-09-18',durableObjects:{QUOTAS:{className:'JevQuota',useSQLite:true}}}]}));
try {
 const reply=await mf.dispatchFetch('https://local-worker/api/jev/classify',{method:'POST',headers:{Origin:'https://amaljithkuttamath.github.io','Content-Type':'application/json','X-Jev-Demo':'1','CF-Connecting-IP':'192.0.2.11'},body:JSON.stringify({task:'sentiment',inputs:{text:'Great app',target:'app'}})});
 assert.equal(reply.status,200);assert.equal(providerCalls,1);assert.ok((await reply.json()).response.answers.sentiment);
 const ns=await mf.getDurableObjectNamespace('QUOTAS');
 const now=Date.UTC(2026,8,18);
 const call=(stub,client)=>stub.fetch('https://quota/reserve',{method:'POST',body:JSON.stringify({client,now})}).then(r=>r.json());
 const burst=ns.get(ns.idFromName('burst-test'));
 const results=await Promise.all(Array.from({length:30},()=>call(burst,'same-client')));
 assert.equal(results.filter(r=>r.allowed).length,5);
 const global=ns.get(ns.idFromName('global-test'));
 const caps=await Promise.all(Array.from({length:220},(_,i)=>call(global,'client-'+i)));
 assert.equal(caps.filter(r=>r.allowed).length,200);
 assert.equal((await call(ns.get(ns.idFromName('global-test')),'new-client')).allowed,false);
 console.log('PASS: real Durable Object transactions admit exactly 5/30 burst requests and 200/220 global requests.');
} finally {await mf.dispose();}
