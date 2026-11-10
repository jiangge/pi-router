import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import { createGroupStream, createMirrorModels, buildModelMap, __testCreateRouterState, __testRunWithRouterState, __testSetCurrentModelRegistry, __testResetInternalState, resetRoutingPointer } from '../index.js';

const leaf = (id: string, provider = 'p') => ({ id, provider, name:id, api:'group-test-api', input:['text'],reasoning:false,contextWindow:100000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0} });
const group = {id:'plan',members:['router/first','router/second']};
const config = () => ({ models:[{id:'first',channels:['p'],routes:[{channel:'p',model:'a'},{channel:'p',model:'b'}],fallbackModels:['outside']},{id:'second',channels:['p'],modelByChannel:{p:'c'}},{id:'outside',channels:['p'],modelByChannel:{p:'d'}}],groups:[group],failover:{cooldownMs:0} });
let state: ReturnType<typeof __testCreateRouterState>;
let calls: string[];
let behavior: (id:string, stream:any, model:any) => void;
const message = (model:any, content:any[] = []) => ({ role:'assistant',content,api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:1,cacheRead:0,cacheWrite:0,totalTokens:1,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now() });
const fail = (s:any,m:any) => {s.push({type:'error',reason:'error',error:{...message(m),stopReason:'error',errorMessage:'Connection error.'}});s.end();};
const success = (s:any,m:any) => {s.push({type:'done',reason:'stop',message:message(m,[{type:'text',text:'ok'}])});s.end();};
const map = () => buildModelMap(['a','b','c','d'].map(id => leaf(id)) as any);
const run = async (g:any = group, c:any = config(), options?:any, context:any = {messages:[]}) => __testRunWithRouterState(state,async () => {
  const events:any[]=[]; for await (const event of createGroupStream(g,context,options,c,map())) events.push(event);return events;
});
beforeEach(() => {
  state = __testCreateRouterState(); calls=[]; behavior=(_id,s,m) => fail(s,m);
  __testRunWithRouterState(state,() => __testSetCurrentModelRegistry({
    getApiKeyAndHeaders:async () => ({ok:true,apiKey:'actual-upstream-key'}),
    getProvider:() => ({streamSimple:(m:any,_c:any,o:any) => {
      expect(o.apiKey).toBe('actual-upstream-key'); calls.push(m.id);
      const s=createAssistantMessageEventStream(); queueMicrotask(() => behavior(m.id,s,m));return s;
    }}),
  }));
});
afterEach(() => __testResetInternalState());
describe('bounded group orchestration', () => {
  it('tries every member route in order, never member fallback or auto', async () => {
    const events=await run();expect(calls).toEqual(['a','b','c']);
    expect(events.at(-1).error.errorMessage).toMatch(/plan exhausted/);
    expect(state.lastFailures.has('first')).toBe(true);expect(state.lastFailures.has('plan')).toBe(false);
  });
  it('shares a single attempts budget across members', async () => {
    const events=await run({...group,failoverBudget:{maxAttempts:2}}); expect(calls).toEqual(['a','b']);expect(events.at(-1).error.errorMessage).toMatch(/maximum attempts/);
  });
  it('keeps a bounded total deadline and stops after timeout', async () => {
    behavior=() => {};
    const events=await run({...group,failoverBudget:{maxTotalWaitMs:20}});expect(calls).toEqual(['a']);expect(events.at(-1).type).toBe('error');
  });
  it('cooldown skips do not count as attempts', async () => {
    state.cooldowns.set('first@p#a',Date.now()+100000);
    behavior=(_id,s,m) => success(s,m);
    await run({...group,failoverBudget:{maxAttempts:1}});expect(calls).toEqual(['b']);
  });
  it('deduplicates actual upstream identity across canonical members', async () => {
    const c:any=config();c.models[1].modelByChannel.p='a';await run(group,c);expect(calls).toEqual(['a','b']);
  });
  it('does not inherit direct member sticky', async () => {
    state.activeChannels.set('first','p#b');behavior=(_id,s,m) => success(s,m);await run();expect(calls).toEqual(['a']);expect(state.activeChannels.get('first')).toBe('p#b');
  });
  it('pins the successful member/route without polluting other groups or direct sticky', async () => {
    behavior=(id,s,m) => id === 'c' ? success(s,m) : fail(s,m);
    await run();calls=[];await run();expect(calls).toEqual(['c']);
    calls=[];await run({...group,id:'review'});expect(calls).toEqual(['c']); // shared health, separate pin
    state.cooldowns.clear(); calls=[];await run({...group,id:'fresh-review'});expect(calls).toEqual(['a','b','c']);
    expect(state.activeChannels.size).toBe(0);
  });
  it('turn affinity retains tool rounds but recovers on a new user turn', async () => {
    const g={...group,affinity:{mode:'turn',returnToPreferred:true}};
    behavior=(id,s,m) => id === 'c' ? success(s,m) : fail(s,m);
    await run(g);calls=[];await run(g);expect(calls).toEqual(['c']);
    state.affinity.beginUserTurn();state.cooldowns.clear();calls=[];await run(g);expect(calls).toEqual(['a','b','c']);
  });
  it('failed pinned member tries its other routes before other members', async () => {
    behavior=(id,s,m) => id === 'b' ? success(s,m) : fail(s,m);await run();calls=[];
    state.cooldowns.clear();behavior=(_id,s,m) => fail(s,m);await run();expect(calls).toEqual(['b','a','c']);
  });
  it('group reset removes only that pin and does not erase shared member health', async () => {
    behavior=(id,s,m) => id === 'c' ? success(s,m) : fail(s,m);await run();
    __testRunWithRouterState(state,() => resetRoutingPointer(config() as any,'plan'));
    expect(state.lastFailures.has('first')).toBe(true);
    expect(state.cooldowns.size).toBeGreaterThan(0);
    state.cooldowns.clear();calls=[];await run();expect(calls).toEqual(['a','b','c']);
  });
  it('cancellation dispatches no candidate', async () => {
    const controller=new AbortController();controller.abort();const events=await run(group,config(),{signal:controller.signal});expect(calls).toEqual([]);expect(events.at(-1).reason).toBe('aborted');
  });
  it.each(['text_delta','thinking_delta','toolcall_start','done'])('never fails over after committed %s', async type => {
    behavior=(_id,s,m) => {
      const msg=message(m,[{type:'text',text:'started'}]);
      if(type==='done') s.push({type,reason:'stop',message:msg});
      else s.push({type,delta:'started',contentIndex:0,partial:msg});
      fail(s,m);
    };
    await run();expect(calls).toEqual(['a']);
  });
  it('checks group capabilities even with economic policy disabled', async () => {
    const events=await run(group,config(),{}, {messages:[{role:'user',content:[{type:'image',data:'xx',mimeType:'image/png'}]}]});expect(calls).toEqual([]);expect(events.at(-1).error.errorMessage).toMatch(/image/);
  });
  it('publishes groups alongside ordinary mirrors using conservative metadata', () => {
    const mirrors=createMirrorModels(config().models as any,map(),[group]);
    expect(mirrors.map(m => m.id)).toEqual(['auto','first','second','outside','plan']);
    expect(mirrors.at(-1)).toMatchObject({id:'plan',input:['text'],contextWindow:100000,maxTokens:1000,reasoning:false});
  });
});
