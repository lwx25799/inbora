import { generateModelText, type ModelResponseTelemetry } from "../ai/model-client.js";
import { Blocked, requireSafe } from "../core/contracts.js";
import { modelErrorCodeSchema, type ModelProvidersCommand, type ModelTestResult } from "../contracts/model-providers.js";
import type { ModelProviderController } from "./model-provider-controller.js";

export function publicModelError(error: unknown) {
  const parsed = modelErrorCodeSchema.safeParse(error instanceof Blocked ? error.code : null);
  return parsed.success ? parsed.data : "MODEL_RESPONSE_INVALID";
}

export async function testModelProvider(controller: ModelProviderController,
  input: Extract<ModelProvidersCommand, { action: "test" }>, authorize: () => void): Promise<ModelTestResult> {
  const { models, automation } = controller.guard;
  const command = { kind: "TEST", input } as const;
  const replay = models.getCommand(command);
  if (replay) return replay.result;
  requireSafe(!automation.state().emergencyStopped, "EMERGENCY_STOPPED");
  const route = controller.requireRoute(input.connectionId, input.routeRevision);
  controller.validateTarget(route, input.modelId);
  const budget = automation.store.budget("MODEL");
  requireSafe(budget.maximum === null || budget.used < budget.maximum, "BUDGET_EXHAUSTED");
  const emergencyRevision = automation.emergencyRevision();
  let apiKey: string;
  try { apiKey = await controller.loadKey(route); }
  catch (error) {
    authorize();
    const existing = models.getCommand(command);
    if (existing) return existing.result;
    throw error;
  }
  authorize();
  const reservation = models.startTest(input, () => {
    authorize();
    requireSafe(!automation.state().emergencyStopped && automation.emergencyRevision() === emergencyRevision, "EMERGENCY_STOPPED");
    automation.store.consumeBudget("MODEL");
    return undefined;
  });
  if (!reservation.snapshot) return reservation.result;
  const signal = controller.registerTest(input.commandId, route);
  const check = () => {
    requireSafe(!automation.state().emergencyStopped, "EMERGENCY_STOPPED");
    controller.assertKeyed(route);
    signal.throwIfAborted();
  };
  const started = Date.now();
  let telemetry: ModelResponseTelemetry | undefined;
  let result: ModelTestResult;
  try {
    const output = await generateModelText({
      revision: route, snapshot: reservation.snapshot, apiKey, signal,
      transport: controller.transport, beforeRequest: () => { authorize(); check(); },
      onTelemetry: safe => { telemetry = safe; },
    });
    check();
    result = { ...reservation.result, status: "SUCCEEDED", reason: null,
      elapsedMs: Date.now() - started, reportedModelId: output.reportedModelId, usage: output.usage };
  } catch (error) {
    const stopped = automation.state().emergencyStopped || signal.reason instanceof Blocked && signal.reason.code === "EMERGENCY_STOPPED";
    const interrupted = signal.aborted || stopped ||
      error instanceof Blocked && ["MODEL_KEY_REQUIRED", "MODEL_ROUTE_CHANGED", "MODEL_CONNECTION_CONFLICT"].includes(error.code);
    result = { ...reservation.result, status: interrupted ? "INTERRUPTED" : "FAILED",
      elapsedMs: Date.now() - started, reason: stopped ? "EMERGENCY_STOPPED" : interrupted ? "MODEL_ROUTE_CHANGED" : publicModelError(error),
      usage: telemetry?.usage ?? null, reportedModelId: telemetry?.reportedModelId ?? null };
  }
  try { return models.finishTest(result); }
  finally {
    controller.unregisterTest(input.commandId);
    await controller.cleanup();
    controller.updated();
  }
}
