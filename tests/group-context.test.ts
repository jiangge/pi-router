import { describe, expect, it } from 'vitest';
import { commonGroupCapabilities, groupContextIncompatibility as check } from '../core/group-context.js';
const model = {id:'x',provider:'p',api:'anthropic-messages',input:['text','image'],reasoning:true,maxTokens:1000,contextWindow:10000};
describe('group context safety', () => {
  it('computes intersection and minimum without unknown defaults', () => {
    expect(commonGroupCapabilities([model,{...model,input:['text'],reasoning:false,contextWindow:5000}])).toMatchObject({input:['text'],reasoning:false,contextWindow:5000,maxTokens:1000});
    expect(commonGroupCapabilities([])).toBeUndefined();
    expect(commonGroupCapabilities([{...model,maxTokens:undefined}])).toBeUndefined();
  });
  it.each([
    ['images', {...model,input:['text']}, {messages:[{role:'user',content:[{type:'image'}]}]}, {}, /image/],
    ['tools', {...model,compat:{supportsTools:false}}, {tools:[{}],messages:[]}, {}, /tools/],
    ['unknown custom tools', {...model,api:'custom'}, {tools:[{}]}, {}, /unknown/],
    ['reasoning', {...model,reasoning:false}, {}, {reasoning:'high'}, /reasoning/],
    ['output', model, {}, {maxTokens:2000}, /output/],
    ['window', {...model,contextWindow:100}, {}, {}, /capacity/],
    ['unknown metadata', {...model,maxTokens:undefined}, {}, {}, /metadata/],
    ['orphan result', model, {messages:[{role:'toolResult',toolCallId:'x'}]}, {}, /orphan/],
    ['unpaired call', model, {messages:[{role:'assistant',content:[{type:'toolCall',id:'x'}]}]}, {}, /unpaired/],
  ])('rejects %s', (_name, m, c, o, expected) => expect(check(m,c,o,10)).toMatch(expected));
  it('preserves full paired foreign history for host conversion without mutation', () => {
    const context = {systemPrompt:'do not lose this',messages:[{role:'assistant',provider:'other',api:'openai-responses',model:'other',content:[{type:'thinking',thinkingSignature:'foreign',thinking:'private'},{type:'toolCall',id:'call|123',name:'read',arguments:{}}]},{role:'toolResult',toolCallId:'call|123',content:[{type:'text',text:'already executed'}]}]};
    const before = structuredClone(context);
    expect(check(model,context,{},100)).toBeUndefined();
    expect(context).toEqual(before);
    expect(check({...model,api:'custom'},context,{},100)).toMatch(/conversion/);
  });
});
