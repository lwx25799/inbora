import type { ModelProviderController } from "../app/model-provider-controller.js";
import type { RouteRevision } from "../app/model-route-guard.js";
import type { AccountAiFeatures } from "../contracts/ai-runtime.js";
import type { Grant } from "../contracts/automation.js";
import type {
  ModelCallPurpose,
  ModelPresetId,
  ModelProtocol,
  ModelSlot,
} from "../contracts/model-providers.js";
import { requireSafe } from "../core/contracts.js";
import type { OnnxEmbeddingStatus } from "../knowledge/contracts.js";
import { AccountAiFeaturesStore } from "../storage/account-ai-features.js";
import type { ModelSlotStore } from "../storage/model-slot-store.js";
import type { EventStore } from "../storage/store.js";
import { validateModelProvider } from "./provider-factory.js";

export interface SlotTransportPolicy {
  readonly publicHttpsOnly: true;
  readonly redirect: "error";
  readonly maxRetries: 0;
}

const TRANSPORT_POLICY: SlotTransportPolicy = Object.freeze({
  publicHttpsOnly: true,
  redirect: "error",
  maxRetries: 0,
});

export interface ResolvedSlotRoute {
  readonly slot: ModelSlot;
  readonly connectionId: string;
  readonly routeRevision: number;
  readonly modelId: string;
  readonly presetId: ModelPresetId;
  readonly protocol: ModelProtocol;
  readonly baseUrl: string;
  readonly endpointDigest: string;
  readonly credentialRevision: string;
  readonly revision: RouteRevision;
  readonly selectionRevision: number | null;
  readonly slotRevision: number | null;
  readonly grantVersion: number | null;
}

export type SlotResolution =
  | {
      readonly slot: "primary";
      readonly mode: "primary";
      readonly decision: "use_model";
      readonly route: ResolvedSlotRoute;
      readonly transportPolicy: SlotTransportPolicy;
    }
  | {
      readonly slot: "vision";
      readonly mode: "vision_slot";
      readonly decision: "use_model";
      readonly route: ResolvedSlotRoute;
      readonly transportPolicy: SlotTransportPolicy;
    }
  | {
      readonly slot: "vision";
      readonly mode: "handoff_human";
      readonly decision: "handoff_human";
      readonly reason: "VISION_DISABLED_OR_UNCONFIGURED";
      readonly route: null;
      readonly transportPolicy: SlotTransportPolicy;
    }
  | {
      readonly slot: "utility";
      readonly mode: "utility_slot";
      readonly decision: "use_model";
      readonly route: ResolvedSlotRoute;
      readonly transportPolicy: SlotTransportPolicy;
    }
  | {
      readonly slot: "utility";
      readonly mode: "local_or_primary";
      readonly decision: "fallback_primary" | "local_only";
      readonly route: ResolvedSlotRoute | null;
      readonly transportPolicy: SlotTransportPolicy;
    }
  | {
      readonly slot: "embedding";
      readonly mode: "local_onnx";
      readonly decision: "use_local_onnx";
      readonly route: null;
      readonly transportPolicy: SlotTransportPolicy;
    }
  | {
      readonly slot: "embedding";
      readonly mode: "cloud_embedding";
      readonly decision: "use_model";
      readonly route: ResolvedSlotRoute;
      readonly transportPolicy: SlotTransportPolicy;
    }
  | {
      readonly slot: "embedding";
      readonly mode: "fts5_only";
      readonly decision: "fallback_fts5";
      readonly route: null;
      readonly transportPolicy: SlotTransportPolicy;
    };

export interface ResolveSlotRouteOptions {
  accountFeatures?: AccountAiFeatures;
  onnxReady?: boolean;
  embeddingStatus?: Pick<OnnxEmbeddingStatus, "state" | "engineMode"> | null;
}

function normalizeSlot(purpose: ModelSlot | ModelCallPurpose): ModelSlot {
  switch (purpose) {
    case "primary":
    case "vision":
    case "utility":
    case "embedding":
      return purpose;
    case "PERSONA_ANALYSIS":
      return "utility";
    case "REPLY_GENERATION":
    case "PERSONA_MERGE":
    case "SANDBOX_REPLY":
    case "SANDBOX_COMPARE":
    case "PROVIDER_TEST":
      return "primary";
  }
}

function assertGrantAndBudget(
  store: EventStore,
  controller: ModelProviderController,
  grant: Grant | null,
  expectedPrimaryModelId?: string,
): Grant {
  requireSafe(grant, "REAL_MODEL_AUTHORIZATION_REQUIRED");
  const active = controller.guard.automation.active(grant.kind);
  requireSafe(active && active.version === grant.version, "GRANT_REVOKED");
  controller.guard.automation.requireAccount(grant.scope.ownId);
  requireSafe(controller.guard.automation.allowance(grant.version, "MODEL"), "MODEL_GRANT_EXHAUSTED");
  const budget = store.budget("MODEL");
  requireSafe(budget.maximum === null || budget.used < budget.maximum, "BUDGET_EXHAUSTED");
  if (expectedPrimaryModelId !== undefined) {
    requireSafe(grant.scope.model === expectedPrimaryModelId, "MODEL_OUTSIDE_GRANT");
  }
  return active;
}

function buildResolvedRoute(
  controller: ModelProviderController,
  slot: ModelSlot,
  connectionId: string,
  routeRevision: number,
  modelId: string,
  grantVersion: number,
  slotRevision: number | null,
  selectionRevision: number | null,
): ResolvedSlotRoute {
  const route = controller.requireRoute(connectionId, routeRevision);
  const { credentialRevision } = controller.assertKeyed(route);
  validateModelProvider({ ...route, modelId }, route.baseUrl);
  return {
    slot,
    connectionId: route.connectionId,
    routeRevision: route.routeRevision,
    modelId,
    presetId: route.presetId,
    protocol: route.protocol,
    baseUrl: route.baseUrl,
    endpointDigest: route.endpointDigest,
    credentialRevision,
    revision: route,
    selectionRevision,
    slotRevision,
    grantVersion,
  };
}

/**
 * Resolves progressive 4-slot routing (`primary`, `vision`, `utility`, `embedding`) per ADR-007.
 * Enforces public HTTPS, no redirects, maxRetries=0, per-account vision isolation, grant & budget bounds.
 */
export function resolveSlotRoute(
  store: EventStore,
  slotStore: ModelSlotStore,
  controller: ModelProviderController,
  grant: Grant | null,
  purpose: ModelSlot | ModelCallPurpose,
  options: ResolveSlotRouteOptions = {},
): SlotResolution {
  requireSafe(!controller.guard.automation.state().emergencyStopped, "EMERGENCY_STOPPED");
  const slot = normalizeSlot(purpose);
  const accountFeatures = options.accountFeatures ?? new AccountAiFeaturesStore(store.db, store.accountId).get();
  const slots = slotStore.getSlots();

  switch (slot) {
    case "primary": {
      const primary = slots.primary;
      requireSafe(
        primary.connectionId !== null && primary.routeRevision !== null && primary.modelId !== null,
        "MODEL_CONNECTION_NOT_APPLIED",
      );
      const activeGrant = assertGrantAndBudget(store, controller, grant, primary.modelId);
      const route = buildResolvedRoute(
        controller,
        "primary",
        primary.connectionId,
        primary.routeRevision,
        primary.modelId,
        activeGrant.version,
        null,
        primary.selectionRevision,
      );
      return {
        slot: "primary",
        mode: "primary",
        decision: "use_model",
        route,
        transportPolicy: TRANSPORT_POLICY,
      };
    }

    case "vision": {
      if (!accountFeatures.visionEnabled || !slots.vision) {
        return {
          slot: "vision",
          mode: "handoff_human",
          decision: "handoff_human",
          reason: "VISION_DISABLED_OR_UNCONFIGURED",
          route: null,
          transportPolicy: TRANSPORT_POLICY,
        };
      }
      const activeGrant = assertGrantAndBudget(store, controller, grant);
      const route = buildResolvedRoute(
        controller,
        "vision",
        slots.vision.connectionId,
        slots.vision.routeRevision,
        slots.vision.modelId,
        activeGrant.version,
        slots.vision.revision,
        null,
      );
      return {
        slot: "vision",
        mode: "vision_slot",
        decision: "use_model",
        route,
        transportPolicy: TRANSPORT_POLICY,
      };
    }

    case "utility": {
      if (slots.utility) {
        const activeGrant = assertGrantAndBudget(store, controller, grant);
        const route = buildResolvedRoute(
          controller,
          "utility",
          slots.utility.connectionId,
          slots.utility.routeRevision,
          slots.utility.modelId,
          activeGrant.version,
          slots.utility.revision,
          null,
        );
        return {
          slot: "utility",
          mode: "utility_slot",
          decision: "use_model",
          route,
          transportPolicy: TRANSPORT_POLICY,
        };
      }
      const primary = slots.primary;
      if (primary.connectionId !== null && primary.routeRevision !== null && primary.modelId !== null) {
        const activeGrant = assertGrantAndBudget(store, controller, grant, primary.modelId);
        const primaryRoute = buildResolvedRoute(
          controller,
          "primary",
          primary.connectionId,
          primary.routeRevision,
          primary.modelId,
          activeGrant.version,
          null,
          primary.selectionRevision,
        );
        return {
          slot: "utility",
          mode: "local_or_primary",
          decision: "fallback_primary",
          route: primaryRoute,
          transportPolicy: TRANSPORT_POLICY,
        };
      }
      return {
        slot: "utility",
        mode: "local_or_primary",
        decision: "local_only",
        route: null,
        transportPolicy: TRANSPORT_POLICY,
      };
    }

    case "embedding": {
      const onnxReady =
        options.onnxReady === true ||
        options.embeddingStatus?.engineMode === "HYBRID_ONNX" ||
        options.embeddingStatus?.state === "REUSED_LOCAL" ||
        options.embeddingStatus?.state === "DOWNLOAD_READY";
      if (onnxReady) {
        return {
          slot: "embedding",
          mode: "local_onnx",
          decision: "use_local_onnx",
          route: null,
          transportPolicy: TRANSPORT_POLICY,
        };
      }
      if (slots.embedding) {
        const activeGrant = assertGrantAndBudget(store, controller, grant);
        const route = buildResolvedRoute(
          controller,
          "embedding",
          slots.embedding.connectionId,
          slots.embedding.routeRevision,
          slots.embedding.modelId,
          activeGrant.version,
          slots.embedding.revision,
          null,
        );
        return {
          slot: "embedding",
          mode: "cloud_embedding",
          decision: "use_model",
          route,
          transportPolicy: TRANSPORT_POLICY,
        };
      }
      return {
        slot: "embedding",
        mode: "fts5_only",
        decision: "fallback_fts5",
        route: null,
        transportPolicy: TRANSPORT_POLICY,
      };
    }
  }
}
