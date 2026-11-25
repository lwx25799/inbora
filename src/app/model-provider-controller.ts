import { discoverModelCatalog } from "../ai/model-catalog.js";
import { requireModelKey } from "../ai/model-transport.js";
import { validateModelProvider } from "../ai/provider-factory.js";
import { CONNECTION_PAGE_LIMIT, INLINE_MODEL_LIMIT, MODEL_PAGE_LIMIT, type ModelProvidersCommand, type PublicModelState,
  type ModelErrorCode } from "../contracts/model-providers.js";
import { Blocked, requireSafe } from "../core/contracts.js";
import { ModelCredentialStore } from "./credentials.js";
import { ModelRouteGuard, type RouteRevision } from "./model-route-guard.js";
import { publicModelError, testModelProvider } from "./model-provider-test.js";
import { onEmergencyStop } from "../storage/emergency-stop.js";
import { LEGACY_KEY_WARNING } from "../storage/model-provider-migration.js";
import { inlineModelEntries } from "../storage/model-provider-store.js";

export class ModelProviderController {
  private business = new AbortController();
  private readonly tests = new Map<string, { route: RouteRevision; abort: AbortController }>();
  private readonly keyStatus = new Map<string, ModelErrorCode | null>();
  private cleanupFailed = false;
  private stagedCleanupFailed = false;
  private closed = false;
  private detachEmergency?: () => void;

  constructor(readonly guard: ModelRouteGuard, readonly credentials: ModelCredentialStore,
    readonly transport: typeof fetch, readonly updated: () => void) {}

  get models() { return this.guard.models; }
  get signal() { return this.business.signal; }
  get cleanupError() { return this.cleanupFailed || this.stagedCleanupFailed ? "MODEL_CREDENTIAL_CLEANUP_FAILED" : null; }

  async initialize(): Promise<void> {
    this.models.interruptTests();
    this.models.interruptBusinessCalls();
    this.guard.invalidateUnsent("LEGACY_MODEL_ROUTE_UNPROVEN");
    this.stagedCleanupFailed = !await this.credentials.cleanupStaged(ref => !!this.models.getCredential(ref.credentialRevision))
      .catch(() => false);
    const selected = this.models.getSelection();
    for (const connection of this.models.listConnections()) {
      const revisions = new Set([connection.draftRevision, selected.connectionId === connection.id ? selected.routeRevision : null]);
      for (const revision of revisions) {
        if (revision === null) continue;
        const route = this.requireRoute(connection.id, revision);
        if (route.credentialRevision) await this.loadKey(route).catch(() => {});
      }
    }
    await this.cleanup();
    this.state();
    this.detachEmergency = onEmergencyStop(this.guard.automation.store, () => {
      this.abortTests("EMERGENCY_STOPPED");
      this.cancelBusiness("EMERGENCY_STOPPED");
    });
  }

  requireRoute(connectionId: string, revision: number): RouteRevision {
    this.models.requireConnection(connectionId);
    const route = this.models.getRevision(connectionId, revision);
    requireSafe(route, "MODEL_CONNECTION_CONFLICT");
    return route;
  }

  assertKeyed(route: RouteRevision) {
    requireSafe(!this.closed, "CLIENT_CLOSING");
    this.models.requireConnection(route.connectionId);
    const { credentialRevision } = route;
    requireSafe(credentialRevision && this.models.isCredentialActive({ ...route, credentialRevision }), "MODEL_KEY_REQUIRED");
    return { connectionId: route.connectionId, storage: route.storage, credentialRevision };
  }

  async loadKey(route: RouteRevision): Promise<string> {
    const ref = this.assertKeyed(route);
    try {
      const key = requireModelKey(await this.credentials.load(ref, this.models.isCredentialActive));
      this.assertKeyed(route);
      this.keyStatus.set(ref.credentialRevision, null);
      return key;
    } catch (error) {
      this.keyStatus.set(ref.credentialRevision, publicModelError(error));
      throw error;
    }
  }

  private publicRevision(connectionId: string, revision: number, selected: string | null) {
    const { credentialRevision, createdAt: _created, connectionId: _connection, endpointDigest: _digest, ...route } =
      this.requireRoute(connectionId, revision);
    const active = credentialRevision && this.models.isCredentialActive({ ...route, connectionId, credentialRevision });
    const legacyWarning = !credentialRevision && revision === 1 && this.models.db.prepare(
      "SELECT 1 FROM audit_events WHERE event_type=? AND entity_id=? LIMIT 1",
    ).get(LEGACY_KEY_WARNING, connectionId);
    const reason = active ? this.keyStatus.get(credentialRevision!) ?? null
      : legacyWarning ? LEGACY_KEY_WARNING : "MODEL_KEY_REQUIRED";
    const keyPresent = !!active && this.keyStatus.get(credentialRevision!) === null;
    return { ...route, ...this.models.getRevisionStatus(connectionId, revision, selected), keyPresent,
      keyStored: keyPresent && route.storage === "DPAPI", unavailableReason: keyPresent ? null : reason ?? "MODEL_KEY_REQUIRED" };
  }

  state(offset = 0, limit = CONNECTION_PAGE_LIMIT, expectedListRevision?: number): PublicModelState {
    return this.models.db.transaction(() => {
      const selection = this.models.getSelection();
      const { connections, ...page } = this.models.listConnectionsPage(selection, offset,
        Math.min(limit, CONNECTION_PAGE_LIMIT), expectedListRevision);
      const modelDisplayName = selection.connectionId === null ? null : this.models.getModelDisplayName(selection);
      const displaySelection = modelDisplayName && selection.connectionId !== null ? { ...selection, modelDisplayName } : selection;
      return { selection: displaySelection, ...page, connections: connections.map(({ deletedAt: _deleted, models, ...connection }) => {
        const applied = selection.connectionId === connection.id
          ? this.publicRevision(connection.id, selection.routeRevision, selection.modelId) : null;
        return { ...connection,
          models: inlineModelEntries(models, applied ? selection.modelId : null),
          totalModelCount: models.length, modelsTruncated: models.length > INLINE_MODEL_LIMIT,
          draft: this.publicRevision(connection.id, connection.draftRevision, null), applied,
        };
      }) };
    })();
  }

  registerTest(id: string, route: RouteRevision): AbortSignal {
    const abort = new AbortController();
    this.tests.set(id, { route, abort });
    return abort.signal;
  }

  unregisterTest(id: string): void { this.tests.delete(id); }

  private abortTests(reason: string): void {
    for (const test of this.tests.values()) test.abort.abort(new Blocked(reason));
  }

  private cancelRevokedTests(): void {
    for (const { route, abort } of this.tests.values()) {
      try { this.assertKeyed(route); } catch { abort.abort(new Blocked("MODEL_ROUTE_CHANGED")); }
    }
  }

  private cancelBusiness(reason: string): void {
    this.business.abort(new Blocked(reason));
    this.business = new AbortController();
  }

  close(): void {
    this.detachEmergency?.();
    this.closed = true;
    this.business.abort(new Blocked("MODEL_CANCELLED"));
    this.abortTests("MODEL_CANCELLED");
  }

  validateTarget(route: RouteRevision, modelId: string): void {
    validateModelProvider({ ...route, modelId }, route.baseUrl);
  }

  async cleanup(): Promise<void> {
    try {
      await this.credentials.cleanup(this.models);
      this.cleanupFailed = !!this.models.db.prepare("SELECT 1 FROM m_credentials WHERE cleanup_state='FAILED'").get();
    } catch { this.cleanupFailed = true; }
  }

  async clearKey(connectionId: string, expectedVersion: number): Promise<PublicModelState> {
    const changed = this.models.db.transaction(() => {
      const previous = this.models.getSelection();
      const current = previous.connectionId === connectionId;
      this.models.deleteKeys(connectionId, expectedVersion);
      if (current) {
        const { selection, route } = this.guard.current();
        this.guard.switchGrants(previous, selection, route, true);
        this.guard.invalidateUnsent("MODEL_ROUTE_CHANGED");
      }
      return current;
    }).immediate();
    if (changed) this.cancelBusiness("MODEL_ROUTE_CHANGED");
    this.cancelRevokedTests();
    await this.cleanup();
    this.updated();
    return this.state();
  }

  async dispatch(c: ModelProvidersCommand, authorize: () => void): Promise<unknown> {
    switch (c.action) {
      case "list": return c.connectionId
        ? this.models.listModelsPage(c.connectionId, c.offset ?? 0, c.limit ?? MODEL_PAGE_LIMIT)
        : this.state(c.offset, c.limit, c.expectedListRevision);
      case "save":
        this.models.saveConnection(c);
        break;
      case "setKey": {
        if (c.storage === "DELETE") return this.clearKey(c.connectionId, c.expectedVersion);
        requireModelKey(c.key);
        const check = () => {
          authorize();
          this.models.requireConnectionVersion(c.connectionId, c.expectedVersion);
          return undefined;
        };
        await this.credentials.save(c.connectionId, c.key, ref => {
          check();
          const updated = this.models.setCredential(c.connectionId, c.expectedVersion, ref);
          this.keyStatus.set(ref.credentialRevision, null);
          return updated;
        }, c.storage, check);
        break;
      }
      case "delete":
        this.models.deleteConnection(c.connectionId, c.expectedVersion);
        this.cancelRevokedTests();
        break;
      case "discover": {
        const route = this.requireRoute(c.connectionId, c.routeRevision);
        const apiKey = await this.loadKey(route);
        const beforeRequest = () => {
          authorize();
          this.assertKeyed(route);
        };
        beforeRequest();
        const result = await discoverModelCatalog({ revision: route, apiKey, transport: this.transport, beforeRequest });
        beforeRequest();
        const summary = this.models.recordCatalog(result.catalog);
        this.updated();
        return summary;
      }
      case "apply": {
        const command = { kind: "APPLY", input: c } as const;
        const existing = this.models.getCommand(command);
        if (existing) return existing.result;
        const route = this.requireRoute(c.connectionId, c.routeRevision);
        try { await this.loadKey(route); }
        catch (error) {
          authorize();
          const replay = this.models.getCommand(command);
          if (replay) return replay.result;
          throw error;
        }
        authorize();
        const replay = this.models.getCommand(command);
        if (replay) return replay.result;
        this.validateTarget(route, c.modelId);
        let changed = false;
        const selection = this.models.apply(c, (previous, next, revision) => {
          this.guard.switchGrants(previous, next, revision);
          this.guard.invalidateUnsent("MODEL_ROUTE_CHANGED");
          changed = true;
          return undefined;
        });
        if (changed) {
          this.cancelBusiness("MODEL_ROUTE_CHANGED");
          this.updated();
          await this.cleanup();
        }
        return selection;
      }
      case "test": return testModelProvider(this, c, authorize);
    }
    await this.cleanup();
    this.updated();
    return this.state();
  }
}
