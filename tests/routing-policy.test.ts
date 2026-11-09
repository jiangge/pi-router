import { describe, it, expect } from 'vitest';
import { orderEconomicRoutes, routeIncompatibility } from '../core/routing-policy.js';
import { getModelRouteEntries } from '../router-routes.js';
import { determineChannelOrder, estimateRequestCost } from '../index.js';
const routes = getModelRouteEntries({ id: 'm', channels: ['a','b','c'] });
const p = (input: number, currency = 'USD', source = 'manual') => ({ price: { input, output: input, currency, source } }) as any;
describe('trusted economics', () => {
  it('unknown never equals free', () => expect(estimateRequestCost('???','a',100,100)).toBe(Infinity));
  it('disabled policy preserves legacy ordering', () => expect(orderEconomicRoutes(routes, {}, {}, 1).routes).toEqual(routes));
  it('cheap uses explicit prices and stable ties', () => {
    expect(orderEconomicRoutes(routes, { 'm@a': p(2), 'm@b': p(1), 'm@c': p(1) }, { enabled: true, objective: 'cheap' }, 1).routes.map(r=>r.channel)).toEqual(['b','c','a']);
  });
  it.each(['unknown','reference','currency','expired','negative','NaN'])('falls back for %s prices', kind => {
    const data: any = { 'm@a': p(2), 'm@b': p(1), 'm@c': p(1) };
    if (kind === 'unknown') delete data['m@c'];
    if (kind === 'reference') data['m@c'] = p(1,'USD','reference');
    if (kind === 'currency') data['m@c'] = p(1,'CNY');
    if (kind === 'expired') data['m@c'].price.expiresAt = 1;
    if (kind === 'negative') data['m@c'].price.input = -1;
    if (kind === 'NaN') data['m@c'].price.input = NaN;
    expect(orderEconomicRoutes(routes,data,{enabled:true,objective:'cheap'},1).routes).toEqual(routes);
  });
  it('only explicit no-quota is free, not zero price or subscription', () => {
    const data: any = {'m@a':p(0),'m@c':{free:{kind:'no-quota',source:'manual'}}};
    expect(orderEconomicRoutes(routes,data,{enabled:true,objective:'free'},1).routes.map(r=>r.channel)).toEqual(['c','a','b']);
  });
  it('never moves across exact upstream boundaries or misprices aliases', () => {
    const rs = getModelRouteEntries({id:'alias',routes:[{channel:'a',model:'strong'},{channel:'b',model:'weak'},{channel:'c',model:'strong'}]});
    const result = orderEconomicRoutes(rs,{'alias@a#strong':p(2),'alias@b#weak':p(0),'alias@c#strong':p(1)},{enabled:true,objective:'cheap'},1);
    expect(result.routes.map(r=>r.channel)).toEqual(['c','b','a']);
  });
  it('runtime ordering is opt in and sticky remains legacy by default', () => {
    const config: any = {sticky:false,routingPolicy:{enabled:true,objective:'cheap'},routeMetadata:{'m@a':p(2),'m@b':p(1)}};
    expect(determineChannelOrder('m',{id:'m',channels:['a','b']} as any,config)).toEqual(['b','a']);
  });
  it('filters hard requirements before dispatch', () => {
    expect(routeIncompatibility({contextWindow:1000,input:['text']},{messages:[{content:[{type:'image'}]}]}, {}, 2)).toContain('image');
    expect(routeIncompatibility({contextWindow:1},{messages:[]},{},2)).toContain('context');
    expect(routeIncompatibility({contextWindow:1000,compat:{supportsTools:false}},{tools:[{}]}, {},2)).toContain('tools');
    expect(routeIncompatibility({contextWindow:1000},{},{reasoning:'high'},2)).toContain('reasoning');
  });
});
