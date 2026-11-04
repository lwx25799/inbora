import { expect, test } from 'vitest';
import { HttpDraftProvider, generateDraft } from '../../src/ai/draft-service.js';
import { approved, candidate, database, pending, snapshot } from '../helpers.js';

test('real provider needs a grant; successful HTTPS contract records usage without actual network', async () => {
  const s = database(); let calls = 0;
  const transport: typeof fetch = async (_input, init) => {
    calls++; expect(init?.redirect).toBe('error');
    expect(String(init?.body)).toContain('businessData');
    return new Response(JSON.stringify({ text: '谢谢你的消息。', model: 'contract-model', usage: { inputTokens: 20, outputTokens: 5 }, estimatedCost: null }));
  };
  try {
    await expect(new HttpDraftProvider(null, undefined, transport).generate(s, candidate(), [])).rejects.toThrow('AUTHORIZATION_REQUIRED');
    expect(calls).toBe(0);
    const id = await generateDraft(s, pending(s), new HttpDraftProvider({ endpoint: 'https://model.example/draft', model: 'contract-model', approvedAt: '2026-11-04' }, 'synthetic-contract-key', transport));
    expect(s.draft(id).status).toBe('DRAFT'); expect(calls).toBe(1);
    expect(s.db.prepare('SELECT input_tokens,output_tokens FROM model_calls').get()).toEqual({ input_tokens: 20, output_tokens: 5 });
  } finally { s.close(); }
});
test('HTTP failure consumes one durable reservation and never retries', async () => {
  const s = database(); let calls = 0;
  try {
    const provider = new HttpDraftProvider({ endpoint: 'https://model.example/draft', model: 'contract-model', approvedAt: '2026-11-04' }, 'synthetic-contract-key', async () => { calls++; throw new Error('synthetic timeout'); });
    await expect(provider.generate(s, candidate(), [])).rejects.toThrow('NO_RETRY'); expect(calls).toBe(1);
    expect(s.db.prepare("SELECT used FROM budgets WHERE kind='MODEL'").get()).toEqual({ used: 1 });
  } finally { s.close(); }
});

test.each(['message','history'] as const)('review: personal email in %s cannot reach external transport or consume budget', async where => {
  const s = database(); let calls=0;
  try {
    const provider=new HttpDraftProvider({endpoint:'https://model.example/draft',model:'contract-model',approvedAt:'2026-11-04'},'synthetic-contract-key',async()=>{calls++;return new Response('{}');});
    const personal=candidate({text:'My email is private@example.test, please contact me there.'});
    await expect(provider.generate(s,where==='message'?personal:candidate(),where==='history'?[personal]:[])).rejects.toThrow('SENSITIVE_MANUAL_HANDLING');
    expect(calls).toBe(0); expect(s.db.prepare("SELECT used FROM budgets WHERE kind='MODEL'").get()).toEqual({used:0});
  }finally{s.close();}
});
test('review: confirmed outgoing text enters context and blocks duplicate model reply', async()=>{
  const s=database(); let sawOutgoing=false;
  try{
    const d=approved(s);const prior=s.draft(d);const i=s.recordIntent(d,snapshot(candidate()),false);s.receipt(i,'CONFIRMED','fixture-proof');
    const next=pending(s,candidate({platformEventId:'next',occurredAt:'2026-11-05T00:00:00Z'}));
    const provider=new HttpDraftProvider({endpoint:'https://model.example/draft',model:'contract-model',approvedAt:'2026-11-04'},'synthetic-contract-key',async(_url,init)=>{
      sawOutgoing=String(init?.body).includes('OUTGOING');return new Response(JSON.stringify({text:prior.text,model:'contract-model',usage:{inputTokens:1,outputTokens:1},estimatedCost:null}));});
    await expect(generateDraft(s,next,provider)).rejects.toThrow('NO_RETRY');expect(sawOutgoing).toBe(true);
  }finally{s.close();}
});
