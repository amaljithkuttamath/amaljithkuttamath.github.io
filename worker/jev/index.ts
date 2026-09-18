import { handle, consumeQuota, type QuotaState } from './api';
interface Storage {
  transaction<T>(fn:(tx: {get<T>(key:string):Promise<T|undefined>; put(key:string,value:unknown):Promise<void>})=>Promise<T>):Promise<T>;
}
interface Env {
  TYPESAFE_API_KEY?: string;
  QUOTAS: { idFromName(name:string): unknown; get(id:unknown):{fetch(input:Request):Promise<Response>} };
}
/** One durable counter for this deliberately small, capped demo. Never stores prompts or raw IPs. */
export class JevQuota {
  constructor(private ctx: {storage:Storage}) {}
  async fetch(request: Request) {
    const {client, now} = await request.json() as {client:string;now:number};
    const result = await this.ctx.storage.transaction(async tx=>{
      const previous = await tx.get<QuotaState>('usage');
      const next = consumeQuota(previous,client,now);
      if (next.allowed) await tx.put('usage',next.state);
      return {allowed:next.allowed,retryAfter:next.retryAfter};
    });
    return Response.json(result);
  }
}
export default {
  async fetch(request:Request,env:Env) {
    return handle(request,{
      key:env.TYPESAFE_API_KEY ?? '', now:Date.now, upstream:(input,init)=>fetch(input,init),
      reserve:async(client,now)=>{
        const stub=env.QUOTAS.get(env.QUOTAS.idFromName('jev-public-budget-v1'));
        const response=await stub.fetch(new Request('https://quota/reserve',{method:'POST',body:JSON.stringify({client,now})}));
        if (!response.ok) throw new Error('Quota unavailable');
        const value=await response.json() as {allowed?:unknown;retryAfter?:unknown};
        if(typeof value.allowed!=='boolean'||typeof value.retryAfter!=='number'||!Number.isFinite(value.retryAfter)||value.retryAfter<0) throw new Error('Invalid quota');
        return {allowed:value.allowed,retryAfter:value.retryAfter};
      },
    });
  },
};
