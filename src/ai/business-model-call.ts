import { randomUUID } from "node:crypto";
import {
  generateModelText,
  type ModelGenerationMessage,
  type ModelResponseTelemetry,
} from "./model-client.js";
import { endpointDigest } from "./provider-presets.js";
import { validateModelProvider } from "./provider-factory.js";
import type { BusinessRoute } from "../app/model-route-guard.js";
import type { ModelProviderController } from "../app/model-provider-controller.js";
import type { Grant } from "../contracts/automation.js";
import { modelCallErrorCodeSchema, type ModelResult, type OptionalModelSlot } from "../contracts/model-providers.js";
import { Blocked, requireSafe } from "../core/contracts.js";
import type { EventStore } from "../storage/store.js";
import { modelExtensionPresent } from "../storage/model-grant-binding.js";

export interface BoundModelCall {
  controller: ModelProviderController;
  snapshot: BusinessRoute;
  kind: Grant["kind"];
  slot?: OptionalModelSlot;
}

interface Call {
  store: EventStore;
  purpose: BusinessRoute["purpose"];
  model: string;
  key: string;
  transport: typeof fetch;
  signal?: AbortSignal | undefined;
  binding?: BoundModelCall | undefined;
  taskId?: string | undefined;
  messages: ModelGenerationMessage[];
  allowVision?: boolean | undefined;
  check(): void;
  reserve(id: string): void;
  linkReservedCall?(id: string): void;
  validate(result: ModelResult): string;
}

export function modelCallFailureReason(error: unknown) {
  const reason = modelCallErrorCodeSchema.safeParse(error instanceof Blocked ? error.code : null);
  return reason.success ? reason.data : "MODEL_RESPONSE_INVALID";
}

export async function callBusinessModel(input: Call): Promise<{ text: string; model: string; callId: string }> {
  const { store, binding, purpose } = input;
  const controller = binding?.controller;
  // CLI/schema2 and standalone legacy consumers use the same protocol client.
  requireSafe(binding || !modelExtensionPresent(store), "MODEL_CONNECTION_NOT_APPLIED");
  const legacyUrl = "https://api.deepseek.com";
  const legacy = {
    connectionId: randomUUID(), credentialRevision: randomUUID(), endpointDigest: endpointDigest(legacyUrl),
    presetId: "deepseek", protocol: "OPENAI_CHAT", routeRevision: 1,
  } as const;
  const snapshot = binding?.snapshot ?? {
    ...legacy, purpose, modelId: input.model, selectionRevision: 1, grantVersion: 1,
  };
  const revision = controller?.requireRoute(snapshot.connectionId, snapshot.routeRevision) ?? {
    ...legacy, baseUrl: legacyUrl, storage: "MEMORY", region: null, createdAt: Date.now(),
  };
  validateModelProvider(snapshot, revision.baseUrl);
  const signal = controller ? AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : [])]) : input.signal;
  const checkSlotCurrent = () => {
    const slotName = binding?.slot;
    if (!controller || !slotName) return;
    const slotRoute = controller.slots.getSlot(slotName);
    requireSafe(
      slotRoute &&
        slotRoute.connectionId === snapshot.connectionId &&
        slotRoute.routeRevision === snapshot.routeRevision &&
        slotRoute.modelId === snapshot.modelId,
      "MODEL_ROUTE_CHANGED",
    );
    controller.assertKeyed(revision);
    requireSafe(!controller.guard.automation.state().emergencyStopped, "EMERGENCY_STOPPED");
    const active = controller.guard.automation.active(binding.kind);
    requireSafe(active?.version === snapshot.grantVersion, "GRANT_REVOKED");
  };
  const check = () => {
    if (binding) {
      if (binding.slot) checkSlotCurrent();
      else controller!.guard.assertCurrent(snapshot, binding.kind);
    }
    if (signal?.aborted) throw signal.reason instanceof Blocked ? signal.reason : new Blocked("MODEL_CANCELLED");
    input.check();
  };
  check();
  const apiKey = controller ? await controller.loadKey(revision) : input.key;
  const id = randomUUID();
  store.db.transaction(() => {
    check();
    input.reserve(id);
    store.consumeBudget("MODEL");
    store.db.prepare("INSERT INTO model_calls VALUES(?,?,'STARTED',NULL,NULL,NULL,NULL)").run(id, snapshot.modelId);
    if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='k_model_purposes'").get()) {
      store.db.prepare("INSERT INTO k_model_purposes VALUES(?,?,?)").run(id, purpose, input.taskId ?? null);
    }
    if (!binding?.slot) controller?.models.recordCallRoute(id, snapshot);
    input.linkReservedCall?.(id);
  }).immediate();
  const started = Date.now();
  let telemetry: ModelResponseTelemetry | undefined;
  const finish = (code: ReturnType<typeof modelCallFailureReason> | null, acceptedText = false) => {
    const status = code ? "FAILED" : "SUCCEEDED";
    store.db.transaction(() => {
      store.db.prepare("UPDATE model_calls SET status=?,input_tokens=?,output_tokens=?,elapsed_ms=? WHERE id=?").run(
        status, telemetry?.usage.inputTokens ?? null, telemetry?.usage.outputTokens ?? null, Date.now() - started, id,
      );
      if (!binding?.slot) {
        controller?.models.finishCallRoute(id, {
          outcome: !code ? "SUCCEEDED" : acceptedText ? "DISCARDED" : signal?.aborted ? "CANCELLED" : "FAILED",
          reportedModel: telemetry?.reportedModelId ?? null, usageDetails: telemetry?.usage ?? null,
          errorCode: code,
        });
      }
      if (!code) store.audit("MODEL_CALL_SUCCEEDED", id);
    }).immediate();
  };
  let acceptedText = false;
  try {
    const result = await generateModelText({
      snapshot, revision, apiKey, signal, messages: input.messages,
      allowVision: Boolean(input.allowVision || binding?.slot === "vision"),
      transport: controller?.transport ?? input.transport, beforeRequest: check,
      onTelemetry: safe => { telemetry = safe; },
    });
    telemetry = result;
    acceptedText = true;
    check();
    const text = input.validate(result);
    finish(null);
    return { text, model: result.reportedModelId ?? snapshot.modelId, callId: id };
  } catch (error) {
    finish(modelCallFailureReason(error), acceptedText);
    throw error;
  }
}
