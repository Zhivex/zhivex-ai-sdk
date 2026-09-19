import {test,expect} from 'vitest';
import {ProviderToolCallError} from '../src/errors.js';
const make=(usage:any)=>new ProviderToolCallError({provider:'openai',diagnosticCode:'FIXTURE',reason:'incomplete_arguments',usage});
test('copies and freezes only numeric usage fields',()=>{
 const usage={inputTokens:12,outputTokens:8,totalTokens:20,secret:'discard'};
 const error=make(usage); usage.inputTokens=999;
 expect(error.usage).toEqual({inputTokens:12,outputTokens:8,totalTokens:20});expect(Object.isFrozen(error.usage)).toBe(true);
 expect(JSON.stringify(error)).not.toContain('discard');expect(error.retryable).toBe(false);
});
for(const usage of [{inputTokens:12},{inputTokens:NaN,outputTokens:8},{inputTokens:12,outputTokens:Infinity},{inputTokens:12,outputTokens:8,cachedInputTokens:-1},{inputTokens:12,outputTokens:8,reasoningTokens:'2'}]) test('rejects invalid or incomplete usage',()=>expect(make(usage).usage).toBeUndefined());
