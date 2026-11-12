import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setupAssistant } from '../mcp-helpers.js';
import { startMcpStdio } from '../mcp-stdio-harness.js';
import { AssistantFacade } from '../../src/mcp/assistant-facade.js';
import { startAssistantControl } from '../../src/mcp/control-server.js';
import { assistantTools, operationSchema, replySchema, statusSchema, threadSchema } from '../../src/mcp/tool-contracts.js';
import { pending } from '../helpers.js';

test.each(['source', 'built'] as const)('%s SDK stdio calls all sixteen tools against one real ClientService and durable ledger', async mode => {
  const f = await setupAssistant({ sendLimit: 2, modelLimit: 2 });
  f.browser.collect = async () => {};
  f.browser.open = async () => {};
  f.service.authority.release(f.token, f.eventId, f.input.generation);
  // Re-enable only through the trusted GUI entrypoint; scope and limits are not caller inputs.
  await f.service.dispatch(f.gui, { command: 'setLocalAssistantGrant', confirmed: true, enabled: true });
  f.auto.grant('MODEL', { ownId: 'own-1', channels: ['DIRECT_MESSAGE'], model: 'deepseek-flash', modelLimit: 2, expiresAt: null });
  await f.service.dispatch(f.gui, { command: 'configureAi', settings: { model: 'deepseek-flash', persona: '', business: '', rules: '' }, key: 'synthetic-only' });
  const events: string[] = [];
  f.service.events.on('update', ({ event }: { event: string }) => events.push(event));
  const facade = new AssistantFacade(f.service);
  const control = await startAssistantControl({ root: f.root, dispatch: (session, tool, args) => facade.dispatch(session, tool, args) });
  facade.instanceId = control.instanceId;
  const mcp = await startMcpStdio(f.root, mode);
  const invoked = new Set<string>();
  const call = async (tool: string, args: unknown = {}) => { invoked.add(tool); return mcp.call(tool, args); };
  const operation = async (tool: string, args: Record<string, unknown>) => {
    const id = randomUUID();
    const accepted = operationSchema.parse(await call(tool, { operationId: id, ...args }));
    expect(accepted.operationId).toBe(id);
    await facade.drain();
    if (tool === 'inbora_send_reply') await f.service.drain();
    return operationSchema.parse(await call('inbora_get_operation', { operationId: id }));
  };
  try {
    const listed = await mcp.rpc('tools/list', {});
    expect((listed.result as { tools: { name: string }[] }).tools.map(tool => tool.name).sort()).toEqual(Object.keys(assistantTools).sort());
    const status = statusSchema.parse(await call('inbora_get_status'));
    expect(status).toMatchObject({ runtime: f.root, instanceId: control.instanceId, assistant: { enabled: true } });
    const inbox = await call('inbora_list_inbox', {}) as { items: { eventId: string; unread: boolean }[] };
    expect(inbox.items).toContainEqual(expect.objectContaining({ eventId: f.eventId, unread: true }));
    const thread = threadSchema.parse(await call('inbora_get_thread', { eventId: f.eventId }));
    expect(thread.event.text).toBe(f.payload.text);
    expect(await call('inbora_get_diagnostics')).toMatchObject({ version: 1, model: { total: { requests: 0 } } });
    expect(await call('inbora_inspect_preview', { eventId: f.eventId })).toEqual({ eventId: f.eventId, previews: [] });

    expect(await operation('inbora_sync_inbox', {})).toMatchObject({ state: 'SUCCEEDED', result: { kind: 'sync' } });
    expect(await operation('inbora_mark_all_read', {})).toMatchObject({ state: 'SUCCEEDED', result: { kind: 'read', marked: 1 } });
    expect(await operation('inbora_set_automatic_reply', { enabled: false })).toMatchObject({ state: 'SUCCEEDED', result: { kind: 'automatic', enabled: false } });

    const opened = await operation('inbora_open_reply', { eventId: f.eventId });
    expect(opened.state).toBe('SUCCEEDED');
    const reply = replySchema.parse(opened.result);
    const { kind: _kind, draft: _draft, ...binding } = reply;
    const saved = await operation('inbora_save_draft', { ...binding, text: 'Synthetic MCP saved reply' });
    expect(saved).toMatchObject({ state: 'SUCCEEDED', result: { kind: 'saved', draft: { source: 'MCP_ASSISTED', version: 1 } } });
    binding.expectedVersion = 1;
    const suggested = await operation('inbora_generate_suggestion', binding);
    expect(suggested).toMatchObject({ state: 'SUCCEEDED', result: { kind: 'suggestion', text: 'Synthetic assistant suggestion', stale: false } });
    expect(f.calls()).toBe(1);
    const sent = await operation('inbora_send_reply', { ...binding, text: 'Synthetic MCP saved reply' });
    expect(sent).toMatchObject({ state: 'SUCCEEDED', result: { kind: 'send', status: 'CONFIRMED' } });
    expect(f.browser.clicks).toBe(1);
    expect(f.store.budget('SEND').used).toBe(1);
    expect(f.store.budget('MODEL').used).toBe(1);
    const consumed = f.service.authority.assistant.state().used;
    expect(consumed).toEqual({ MODEL: 1, SEND: 1 });
    const same = operationSchema.parse(await call('inbora_send_reply', { operationId: sent.operationId, ...binding, text: 'Synthetic MCP saved reply' }));
    expect(same.state).toBe('SUCCEEDED');
    expect(f.browser.clicks).toBe(1);
    expect(await operation('inbora_close_reply', { eventId: f.eventId, generation: binding.generation })).toMatchObject({ state: 'SUCCEEDED' });

    pending(f.store, { ...f.payload, platformEventId: '900000000000000001',
      occurredAt: new Date(Date.now() - 10).toISOString(), text: '[synthetic image]', observationIssue: 'DM_CONTENT_UNVERIFIED', contentType: 'IMAGE' });
    const mediaId = f.store.events().find(event => event.payload.platformEventId === '900000000000000001')!.id;
    const preview = await operation('inbora_refresh_preview', { eventId: mediaId });
    expect(preview.error).toBeNull();
    expect(preview).toMatchObject({ state: 'SUCCEEDED', result: { kind: 'preview', scheduled: true } });
    const newInbox = await call('inbora_list_inbox', {}) as { items: { unread: boolean }[] };
    expect(newInbox.items.some(item => item.unread)).toBe(true);
    expect(await operation('inbora_emergency_stop', {})).toMatchObject({ state: 'SUCCEEDED', result: { kind: 'stop', emergencyStopped: true } });
    expect(statusSchema.parse(await call('inbora_get_status')).emergencyStopped).toBe(true);
    expect(events).toEqual(expect.arrayContaining(['inbox_updated', 'takeover_updated', 'draft_updated', 'send_status_updated']));
    expect([...invoked].sort()).toEqual(Object.keys(assistantTools).sort());

    await f.service.dispatch(f.gui, { command: 'setLocalAssistantGrant', confirmed: true, enabled: false });
    await expect(call('inbora_get_thread', { eventId: f.eventId })).rejects.toThrow('ASSISTANT_PERMISSION_REQUIRED');
    expect(operationSchema.parse(await call('inbora_get_operation', { operationId: saved.operationId })).result).toBeNull();
    expect(f.service.authority.assistant.state().used).toEqual(consumed);
    expect(f.browser.clicks).toBe(1);
  } finally {
    await mcp.close();
    await control.close();
    await facade.close();
    await f.close();
  }
}, 40_000);
