import {
  modelGrantSchema, modelGrantV2Schema, replyPolicySchema, replyPolicyV2Schema,
  type Grant, type ModelGrant, type ModelGrantV2, type ReplyPolicy, type ReplyPolicyV2,
} from "../contracts/automation.js";
import type { ConnectionRevision, ModelSelection } from "../contracts/model-providers.js";
import { digest, requireSafe } from "../core/contracts.js";
import type { EventStore } from "./store.js";
import { ModelProviderStore } from "./model-provider-store.js";

type Route = ConnectionRevision & { endpointDigest: string };

export function modelExtensionPresent(store: EventStore): boolean {
  return !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'm\\_%' ESCAPE '\\' LIMIT 1").get();
}

export function parseStoredModelGrant(kind: Grant["kind"], raw: unknown): ModelGrant | ReplyPolicy | ModelGrantV2 | ReplyPolicyV2 {
  const versioned = typeof raw === "object" && raw !== null && Object.hasOwn(raw, "contractVersion");
  const schema = kind === "MODEL" ? (versioned ? modelGrantV2Schema : modelGrantSchema)
    : (versioned ? replyPolicyV2Schema : replyPolicySchema);
  const parsed = schema.safeParse(raw);
  requireSafe(parsed.success, "GRANT_CORRUPT");
  return parsed.data;
}

function binding(selection: ModelSelection, route: Route) {
  return {
    connectionId: route.connectionId, routeRevision: route.routeRevision, selectionRevision: selection.selectionRevision,
    protocol: route.protocol, endpointDigest: route.endpointDigest,
  };
}

export function bindModelGrant(kind: Grant["kind"], scope: ModelGrant | ReplyPolicy, selection: ModelSelection, route: Route) {
  const schema = kind === "MODEL" ? modelGrantV2Schema : replyPolicyV2Schema;
  return schema.parse({ ...scope, model: selection.modelId, contractVersion: 2, modelBinding: binding(selection, route) });
}

export function currentModelGrantScope(store: EventStore, kind: Grant["kind"], scope: ModelGrant | ReplyPolicy) {
  if (!modelExtensionPresent(store)) return parseStoredModelGrant(kind, scope);
  const models = new ModelProviderStore(store.db);
  const selection = models.getSelection();
  const route = selection.connectionId && models.getRevision(selection.connectionId, selection.routeRevision);
  requireSafe(route, "MODEL_CONNECTION_NOT_APPLIED");
  return bindModelGrant(kind, scope, selection, route);
}

export function grantMatchesModel(grant: Grant, selection: ModelSelection, route: Route): boolean {
  if (grant.scope.model !== selection.modelId) return false;
  if ("contractVersion" in grant.scope) {
    return grant.scope.contractVersion === 2 && "modelBinding" in grant.scope
      && digest(grant.scope.modelBinding) === digest(binding(selection, route));
  }
  return selection.selectionRevision === 1 && route.routeRevision === 1 && route.presetId === "deepseek"
    && route.protocol === "OPENAI_CHAT" && route.baseUrl === "https://api.deepseek.com";
}
