import { dirname } from "node:path";
import { invokeReadonlyBusinessTool } from "../ai/readonly-business-tools.js";
import {
  BUSINESS_TOOL_IDS,
  type AccountAiFeaturesCommand,
  type BusinessToolsCommand,
  type MediaAssetsCommand,
} from "../contracts/ai-runtime.js";
import type { SendParams } from "../contracts/client.js";
import { requireSafe } from "../core/contracts.js";
import type { SendMediaAttachment } from "../core/send-coordinator.js";
import { AccountAiFeaturesStore } from "../storage/account-ai-features.js";
import { MediaAssetStore } from "../storage/media-asset-store.js";
import type { EventStore } from "../storage/store.js";
import type { WorkbenchAuthority } from "./authority.js";

export type AiRuntimeCommand =
  | AccountAiFeaturesCommand
  | MediaAssetsCommand
  | BusinessToolsCommand;

export interface AiRuntimeCommandContext {
  store: EventStore;
  authority: WorkbenchAuthority;
  root: string;
  now?: () => number;
  onUpdated?: () => void;
  toolTransport?: typeof fetch;
}

export function resolveMediaStoreRoot(store: EventStore, root: string): string {
  if (root && !root.startsWith("synthetic://")) return root;
  if (store.db.name && store.db.name !== ":memory:") return dirname(store.db.name);
  return root;
}

/** Verifies mediaReplyEnabled and local asset sha256/magic-bytes before preview, queue, or SendCoordinator. */
export function prepareSendMediaAttachment(
  store: EventStore,
  root: string,
  params: Pick<SendParams, "mediaAssetId" | "mediaAssetDigest">,
): SendMediaAttachment | undefined {
  if (!params.mediaAssetId) return undefined;
  const mediaRoot = resolveMediaStoreRoot(store, root);
  const features = new AccountAiFeaturesStore(store.db, store.accountId).get();
  requireSafe(features.mediaReplyEnabled, "MEDIA_REPLY_DISABLED");
  const assetStore = new MediaAssetStore(store.db, store.accountId, mediaRoot);
  const verified = assetStore.verifyAsset(params.mediaAssetId, params.mediaAssetDigest!);
  return {
    asset: {
      id: verified.summary.id,
      mimeType: verified.summary.mimeType,
      bytes: verified.bytes,
      sha256: verified.summary.sha256,
      filePath: verified.filePath,
    },
    verify: () => {
      const latest = new AccountAiFeaturesStore(store.db, store.accountId).get();
      requireSafe(latest.mediaReplyEnabled, "MEDIA_REPLY_DISABLED");
      assetStore.verifyAsset(params.mediaAssetId!, params.mediaAssetDigest!);
    },
  };
}

export async function handleAiRuntimeCommand(
  ctx: AiRuntimeCommandContext,
  token: string,
  command: AiRuntimeCommand,
): Promise<unknown> {
  const now = ctx.now ?? ctx.authority.now;
  const featuresStore = new AccountAiFeaturesStore(ctx.store.db, ctx.store.accountId, now);
  const mediaRoot = resolveMediaStoreRoot(ctx.store, ctx.root);

  switch (command.command) {
    case "accountAiFeatures":
      if (command.action === "get") {
        ctx.authority.operator(token, "READ");
        return featuresStore.get();
      }
      ctx.authority.requireGuiControl(token, "CONTROL");
      if (command.action === "setSyncCustomerAvatars") {
        const saved = featuresStore.setSyncCustomerAvatars(command.enabled);
        ctx.store.audit("ACCOUNT_AI_FEATURES_SAVED", ctx.store.accountId, {
          visionEnabled: saved.visionEnabled,
          mediaReplyEnabled: saved.mediaReplyEnabled,
          toolsCount: saved.enabledBusinessTools.length,
          syncCustomerAvatars: saved.syncCustomerAvatars,
        });
        ctx.onUpdated?.();
        return saved;
      }
      {
        const saved = featuresStore.save(command.features);
        ctx.store.audit("ACCOUNT_AI_FEATURES_SAVED", ctx.store.accountId, {
          visionEnabled: saved.visionEnabled,
          mediaReplyEnabled: saved.mediaReplyEnabled,
          toolsCount: saved.enabledBusinessTools.length,
        });
        ctx.onUpdated?.();
        return saved;
      }

    case "mediaAssets": {
      const assetStore = new MediaAssetStore(ctx.store.db, ctx.store.accountId, mediaRoot, now);
      switch (command.action) {
        case "list":
          ctx.authority.operator(token, "READ");
          return { assets: assetStore.list() };
        case "save": {
          ctx.authority.requireGuiControl(token, "CONTROL");
          const asset = await assetStore.save({ name: command.name, base64: command.base64 });
          ctx.store.audit("MEDIA_ASSET_SAVED", asset.id, { mimeType: asset.mimeType, bytes: asset.bytes });
          ctx.onUpdated?.();
          return { asset };
        }
        case "uploadStart":
          ctx.authority.requireGuiControl(token, "CONTROL");
          return assetStore.startUpload(command);
        case "uploadChunk":
          ctx.authority.requireGuiControl(token, "CONTROL");
          return assetStore.appendUploadChunk(command);
        case "uploadFinish": {
          ctx.authority.requireGuiControl(token, "CONTROL");
          const asset = await assetStore.finishUpload(command);
          ctx.store.audit("MEDIA_ASSET_SAVED", asset.id, { mimeType: asset.mimeType, bytes: asset.bytes });
          ctx.onUpdated?.();
          return { asset };
        }
        case "delete": {
          ctx.authority.requireGuiControl(token, "CONTROL");
          const deleted = await assetStore.delete(command.assetId);
          ctx.store.audit("MEDIA_ASSET_DELETED", command.assetId);
          ctx.onUpdated?.();
          return deleted;
        }
      }
    }

    case "businessTools": {
      ctx.authority.operator(token, "READ");
      const features = featuresStore.get();
      if (command.action === "list") {
        return {
          tools: BUSINESS_TOOL_IDS.map(id => ({
            id,
            enabled: features.enabledBusinessTools.includes(id),
            endpointConfigured: Boolean(features.toolEndpoints[id]),
          })),
        };
      }
      return invokeReadonlyBusinessTool({
        accountFeatures: features,
        toolId: command.toolId,
        params: command.params,
        ...(ctx.toolTransport ? { transport: ctx.toolTransport } : {}),
      });
    }
  }
}
