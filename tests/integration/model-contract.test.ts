import { expect, test } from 'vitest';
import { HttpDraftProvider, generateDraft } from '../../src/ai/draft-service.js';
import { candidate, database, pending } from '../helpers.js';

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
