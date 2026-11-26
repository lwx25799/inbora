import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { BrowserService } from "../src/app/browser-service.js";
import { ClientService } from "../src/app/service.js";
import { DeepSeekProvider } from "../src/ai/deepseek.js";
import { EventStore } from "../src/storage/store.js";
import { migrateClient } from "../src/storage/client-migration.js";
import type { ModelPresetId, ModelProtocol, ModelSelection, PublicModelState } from "../src/contracts/model-providers.js";
import type { ReplyPolicy } from "../src/contracts/automation.js";
import { pending, privateTemp } from "./helpers.js";

export async function providerState(service: ClientService, token: string) {
  return await service.dispatch(token, { command: "modelProviders", action: "list" }) as PublicModelState;
}

export async function applyModel(service: ClientService, token: string, connectionId: string, routeRevision: number,
  modelId: string, expectedSelectionRevision?: number, commandId = randomUUID()) {
  return await service.dispatch(token, { command: "modelProviders", action: "apply", confirmed: true, commandId,
    expectedSelectionRevision: expectedSelectionRevision ?? (await providerState(service, token)).selection.selectionRevision,
    connectionId, routeRevision, modelId }) as ModelSelection;
}

export async function installFixtureKey(service: ClientService, token: string, {
  key = "synthetic-model-key", grant = false, storage = "MEMORY",
}: { key?: string; grant?: boolean; storage?: "MEMORY" | "DPAPI" } = {}) {
  const state = await providerState(service, token);
  const connection = state.connections.find(row => row.id === state.selection.connectionId)!;
  const updated = await service.dispatch(token, { command: "modelProviders", action: "setKey", storage, key,
    connectionId: connection.id, expectedVersion: connection.version }) as PublicModelState;
  const next = updated.connections.find(row => row.id === connection.id)!;
  await applyModel(service, token, next.id, next.draftRevision, state.selection.modelId!);
  if (grant) {
    const budget = service.store.budget("MODEL");
    await service.dispatch(token, { command: "setModelGrant", confirmed: true, scope: {
      ownId: service.store.accountOwnId(service.accountId), channels: ["COMMENT_NOTIFICATION", "DIRECT_MESSAGE"],
      model: state.selection.modelId, modelLimit: budget.maximum === null ? null : budget.maximum - budget.used, expiresAt: null,
    } });
  }
}

export async function stageFixtureModel(service: ClientService, token: string, name = "Second model",
  presetId: ModelPresetId = "custom", protocol: ModelProtocol = "OPENAI_CHAT") {
  const modelId = "vendor/model:review";
  const state = await service.dispatch(token, { command: "modelProviders", action: "save", connectionId: null,
    expectedVersion: 0, name, presetId, protocol, baseUrl: "https://models.example.com/v1", region: null,
    manualModels: [{ modelId }] }) as PublicModelState;
  const connection = state.connections.find(c => c.name === name)!;
  const updated = await service.dispatch(token, { command: "modelProviders", action: "setKey",
    connectionId: connection.id, expectedVersion: connection.version, key: "synthetic-alternate-key", storage: "MEMORY" }) as PublicModelState;
  const next = updated.connections.find(c => c.id === connection.id)!;
  return { connectionId: next.id, routeRevision: next.draftRevision, modelId, version: next.version };
}

export function chatAnswer(text = "Synthetic model answer.", model = "vendor/model:review"): Response {
  return Response.json({ model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

export const fixturePolicy: ReplyPolicy = {
  ownId: "own-1", model: "deepseek-flash", channels: ["DIRECT_MESSAGE"],
  modelLimit: 2, sendLimit: 2, expiresAt: null, futureOwnWorks: false, workIds: [],
  conversationIds: ["conversation-1"], entireInbox: false, containsAny: [], excludesAny: [],
  instructions: "Reply briefly.", startHour: 0, endHour: 24,
};

export async function modelFixture(transport: typeof fetch = async () => chatAnswer(),
  makeBrowser: (root: string) => BrowserService = root => new BrowserService(root)) {
  const root = privateTemp("worker-2c-model-");
  const dbPath = join(root, "main.sqlite");
  const store = new EventStore(dbPath, true);
  await migrateClient(store, join(root, "schema3.sqlite"));
  const eventId = pending(store);
  const provider = new DeepSeekProvider(transport);
  const start = async () => {
    const service = new ClientService(store, makeBrowser(root), provider);
    await service.loadSettings();
    return { service, token: service.authority.issueSession() };
  };
  const { service, token } = await start();
  const close = async () => {
    try { await service.close(); }
    finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  };
  return { root, dbPath, store, eventId, service, token, start, close };
}
