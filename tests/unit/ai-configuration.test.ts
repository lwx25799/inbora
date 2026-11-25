import { expect, test } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { saveAiSettings } from '../../src/app/ai-configuration.js';
import { buildReplySystemPrompt, replyStyleRules } from '../../src/ai/reply-style.js';
import { prompt } from '../../src/ai/draft-service.js';
import { candidate, privateTemp } from '../helpers.js';

test('business settings persist only the three prompt fields', async () => {
  const root = privateTemp('ai-config-');
  try {
    const settings = { persona: 'Friendly support', business: 'Care instructions', rules: 'Be brief' };
    await saveAiSettings(root, settings);
    expect(JSON.parse(await readFile(join(root, 'client-settings.json'), 'utf8'))).toEqual(settings);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('formal reply and sandbox tryReply share the same style rules and omit model id from system settings', () => {
  const settings = {
    persona: '自然简洁',
    business: '生鲜商品不支持无理由退款',
    rules: '遇到投诉请引导人工客服',
  };
  const formal = buildReplySystemPrompt({ baseSystem: prompt(candidate(), []).system, settings });
  const sandbox = buildReplySystemPrompt({ sandbox: true, settings });
  expect(formal).toContain(replyStyleRules);
  expect(sandbox).toContain(replyStyleRules);
  expect(formal).toContain(settings.business);
  expect(sandbox).toContain(settings.business);
  expect(sandbox).toContain('隔离试聊');
  expect(formal).not.toContain('deepseek-flash');
  expect(sandbox).not.toContain('deepseek-flash');
});
