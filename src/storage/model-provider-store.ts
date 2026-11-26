import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { catalogReachedLimit, mergeModelCatalog } from "../ai/model-catalog.js";
import { endpointDigest as endpointDigestForUrl, normalizeBaseUrl } from "../ai/provider-presets.js";
import { validateModelCredentialRef, type ModelCredentialRef } from "../app/credentials.js";
import {
  INLINE_MODEL_LIMIT, MODEL_CALL_PURPOSES, MODEL_PROTOCOLS, MODEL_PROVIDER_TEST_VERSION,
  connectionRevisionSchema, modelCatalogResultSchema, modelCatalogSummarySchema, modelConnectionSchema,
  modelCallErrorCodeSchema, modelIdSchema, modelProvidersCommandSchema,
  modelRouteSnapshotSchema, modelSelectionSchema, modelTestResultSchema, modelUsageDetailsSchema,
  type ConnectionRevision, type ModelCallPurpose, type ModelCatalogEntry, type ModelCatalogPage,
  type ModelCatalogResult, type ModelCatalogSummary,
  type ModelConnection, type ModelCallErrorCode, type ModelProtocol,
  type ModelProvidersCommand, type ModelRouteSnapshot, type ModelSelection, type ModelTestResult, type ModelUsageDetails,
} from "../contracts/model-providers.js";
import { Blocked, digest, requireSafe } from "../core/contracts.js";

const protocols = MODEL_PROTOCOLS.map(protocol => `'${protocol}'`).join(",");
const purposes = MODEL_CALL_PURPOSES.map(purpose => `'${purpose}'`).join(",");
const sql = `
CREATE TABLE m_provider_schema (
  id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1)
) STRICT;
CREATE TABLE m_connections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, preset_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0), draft_revision INTEGER NOT NULL CHECK(draft_revision>0),
  models_json TEXT NOT NULL CHECK(json_valid(models_json) AND json_type(models_json)='array'
    AND json_array_length(models_json)<=4000 AND length(models_json)<=2400000),
  models_fetched_at INTEGER, deleted_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  FOREIGN KEY(id,draft_revision) REFERENCES m_connection_revisions(connection_id,route_revision) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE UNIQUE INDEX m_live_connection_name ON m_connections(name) WHERE deleted_at IS NULL;
CREATE TABLE m_credentials (
  credential_revision TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES m_connections(id),
  storage TEXT NOT NULL CHECK(storage IN ('MEMORY','DPAPI')), created_at INTEGER NOT NULL, revoked_at INTEGER,
  cleanup_state TEXT NOT NULL CHECK(cleanup_state IN ('ACTIVE','PENDING','FAILED','DONE')),
  cleanup_error TEXT, UNIQUE(connection_id,credential_revision,storage),
  CHECK((revoked_at IS NULL)=(cleanup_state='ACTIVE')),
  CHECK((cleanup_error IS NULL)=(cleanup_state!='FAILED'))
) STRICT;
CREATE TABLE m_connection_revisions (
  connection_id TEXT NOT NULL REFERENCES m_connections(id), route_revision INTEGER NOT NULL CHECK(route_revision>0),
  preset_id TEXT NOT NULL, protocol TEXT NOT NULL CHECK(protocol IN (${protocols})),
  base_url TEXT NOT NULL, region TEXT, credential_revision TEXT,
  storage TEXT NOT NULL CHECK(storage IN ('MEMORY','DPAPI')),
  endpoint_digest TEXT NOT NULL CHECK(length(endpoint_digest)=64), created_at INTEGER NOT NULL,
  catalog_result_json TEXT CHECK(catalog_result_json IS NULL OR json_valid(catalog_result_json)),
  catalog_models_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(catalog_models_json)
    AND json_type(catalog_models_json)='array' AND json_array_length(catalog_models_json)<=4000),
  PRIMARY KEY(connection_id,route_revision),
  UNIQUE(connection_id,route_revision,credential_revision,protocol,endpoint_digest),
  FOREIGN KEY(connection_id,credential_revision,storage) REFERENCES m_credentials(connection_id,credential_revision,storage)
) STRICT;
CREATE TABLE m_selection (
  id INTEGER PRIMARY KEY CHECK(id=1), connection_id TEXT, route_revision INTEGER, model_id TEXT,
  revision INTEGER NOT NULL CHECK(revision>=0),
  CHECK((connection_id IS NULL)=(route_revision IS NULL) AND (connection_id IS NULL)=(model_id IS NULL)
    AND (connection_id IS NULL OR revision>0)),
  FOREIGN KEY(connection_id,route_revision) REFERENCES m_connection_revisions(connection_id,route_revision)
) STRICT;
CREATE TABLE m_call_routes (
  call_id TEXT PRIMARY KEY REFERENCES model_calls(id), connection_id TEXT NOT NULL, route_revision INTEGER NOT NULL,
  selection_revision INTEGER, credential_revision TEXT NOT NULL, protocol TEXT NOT NULL,
  endpoint_digest TEXT NOT NULL, requested_model TEXT NOT NULL, reported_model TEXT, grant_version INTEGER,
  purpose TEXT NOT NULL CHECK(purpose IN (${purposes})),
  outcome TEXT NOT NULL CHECK(outcome IN ('STARTED','SUCCEEDED','FAILED','CANCELLED','DISCARDED','INTERRUPTED')),
  error_code TEXT, usage_details_json TEXT CHECK(usage_details_json IS NULL OR json_valid(usage_details_json)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(connection_id,route_revision,credential_revision,protocol,endpoint_digest)
    REFERENCES m_connection_revisions(connection_id,route_revision,credential_revision,protocol,endpoint_digest),
  CHECK((purpose='PROVIDER_TEST' AND selection_revision IS NULL AND grant_version IS NULL)
    OR (purpose!='PROVIDER_TEST' AND selection_revision IS NOT NULL AND grant_version IS NOT NULL))
) STRICT;
CREATE TABLE m_generation_bindings (
  owner_kind TEXT NOT NULL CHECK(owner_kind IN ('SUGGESTION','DRAFT')), owner_id TEXT NOT NULL,
  owner_version INTEGER NOT NULL CHECK(owner_version>0), call_id TEXT NOT NULL REFERENCES m_call_routes(call_id),
  PRIMARY KEY(owner_kind,owner_id,owner_version)
) STRICT;
CREATE TABLE m_commands (
  command_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('APPLY','TEST')),
  params_digest TEXT NOT NULL CHECK(length(params_digest)=64),
  state TEXT NOT NULL CHECK(state IN ('STARTED','SUCCEEDED','FAILED','INTERRUPTED')),
  call_id TEXT UNIQUE REFERENCES m_call_routes(call_id),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK((kind='APPLY' AND state='SUCCEEDED' AND call_id IS NULL) OR (kind='TEST' AND call_id IS NOT NULL))
) STRICT;
CREATE INDEX m_call_route_credential ON m_call_routes(credential_revision) WHERE purpose='PROVIDER_TEST' AND outcome='STARTED';
CREATE INDEX m_call_route_test ON m_call_routes(connection_id,route_revision) WHERE purpose='PROVIDER_TEST';
INSERT INTO m_provider_schema VALUES (1,1);
INSERT INTO m_selection VALUES (1,NULL,NULL,NULL,0);
`;

const schemaColumns = {
  m_provider_schema: "id version",
  m_connections: "id name preset_id version draft_revision models_json models_fetched_at deleted_at created_at updated_at",
  m_credentials: "credential_revision connection_id storage created_at revoked_at cleanup_state cleanup_error",
  m_connection_revisions: "connection_id route_revision preset_id protocol base_url region credential_revision storage endpoint_digest created_at catalog_result_json catalog_models_json",
  m_selection: "id connection_id route_revision model_id revision",
  m_call_routes: "call_id connection_id route_revision selection_revision credential_revision protocol endpoint_digest requested_model reported_model grant_version purpose outcome error_code usage_details_json created_at",
  m_generation_bindings: "owner_kind owner_id owner_version call_id",
  m_commands: "command_id kind params_digest state call_id result_json created_at updated_at",
} as const;
const schemaForeignKeys: Partial<Record<keyof typeof schemaColumns, string[]>> = {
  m_connections: ["m_connection_revisions 0:id=connection_id 1:draft_revision=route_revision"],
  m_connection_revisions: [
    "m_connections 0:connection_id=id",
    "m_credentials 0:connection_id=connection_id 1:credential_revision=credential_revision 2:storage=storage",
  ],
  m_credentials: ["m_connections 0:connection_id=id"],
  m_selection: ["m_connection_revisions 0:connection_id=connection_id 1:route_revision=route_revision"],
  m_call_routes: [
    "m_connection_revisions 0:connection_id=connection_id 1:route_revision=route_revision 2:credential_revision=credential_revision 3:protocol=protocol 4:endpoint_digest=endpoint_digest",
    "model_calls 0:call_id=id",
  ],
  m_generation_bindings: ["m_call_routes 0:call_id=call_id"],
  m_commands: ["m_call_routes 0:call_id=call_id"],
};

const selectSelection = `SELECT connection_id AS connectionId,route_revision AS routeRevision,
  model_id AS modelId,revision AS selectionRevision FROM m_selection`;

export function inspectModelProviderSchema(db: Database.Database): "ABSENT" | "READY" {
  const version = db.pragma("user_version", { simple: true });
  requireSafe(version === 3 || version === 4, "CLIENT_MIGRATION_REQUIRED");
  const objects = db.prepare("SELECT name,type,sql FROM main.sqlite_schema WHERE substr(name,1,2)='m_'").all() as
    { name: string; type: string; sql: string | null }[];
  if (objects.length === 0) return "ABSENT";
  const columns = db.prepare("SELECT name FROM pragma_table_info(?,'main') ORDER BY cid").pluck();
  const foreignKeys = db.prepare(`SELECT "table" || ' ' ||
    group_concat(seq || ':' || "from" || '=' || "to", ' ' ORDER BY seq)
    FROM pragma_foreign_key_list(?,'main') GROUP BY id ORDER BY 1`).pluck();
  const foreignKeyViolation = db.prepare("SELECT 1 FROM pragma_foreign_key_check(?,'main') LIMIT 1");
  for (const name of Object.keys(schemaColumns) as (keyof typeof schemaColumns)[]) {
    requireSafe(
      objects.some(object => object.name === name && object.type === "table")
      && columns.all(name).join(" ") === schemaColumns[name]
      && foreignKeys.all(name).join("\n") === (schemaForeignKeys[name] ?? []).join("\n"),
      "MODEL_PROVIDER_SCHEMA_INVALID",
    );
    try { requireSafe(!foreignKeyViolation.get(name), "MODEL_PROVIDER_SCHEMA_INVALID"); }
    catch { throw new Blocked("MODEL_PROVIDER_SCHEMA_INVALID"); }
  }
  // SQLite's foreign_key_list omits the deferral mode of the circular draft reference.
  const connectionDdl = objects.find(object => object.name === "m_connections")?.sql
    ?.replace(/'(?:''|[^'])*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|\/\*[\s\S]*?\*\/|--[^\r\n]*/gu, " ") ?? "";
  requireSafe(/,\s*FOREIGN\s+KEY\s*\(\s*id\s*,\s*draft_revision\s*\)\s*REFERENCES\s+m_connection_revisions\s*\(\s*connection_id\s*,\s*route_revision\s*\)\s+DEFERRABLE\s+INITIALLY\s+DEFERRED\s*[,)]/iu.test(connectionDdl),
    "MODEL_PROVIDER_SCHEMA_INVALID");
  requireSafe(db.prepare(`SELECT 1 FROM pragma_index_list('m_connections','main')
    WHERE name='m_live_connection_name' AND "unique"=1 AND partial=1`).get(), "MODEL_PROVIDER_SCHEMA_INVALID");
  const versions = db.prepare("SELECT id,version FROM m_provider_schema").all() as { id: number; version: number }[];
  const selections = db.prepare(selectSelection).all();
  requireSafe(versions.length === 1 && versions[0]?.id === 1 && versions[0].version === 1
    && selections.length === 1 && modelSelectionSchema.safeParse(selections[0]).success
    && db.prepare("SELECT id FROM m_selection").pluck().get() === 1, "MODEL_PROVIDER_SCHEMA_INVALID");
  requireSafe(!db.prepare(`SELECT 1 FROM m_selection s
    LEFT JOIN m_connections c ON c.id=s.connection_id
    LEFT JOIN m_connection_revisions r ON r.connection_id=s.connection_id AND r.route_revision=s.route_revision
    WHERE s.connection_id IS NOT NULL AND (r.connection_id IS NULL OR c.id IS NULL OR c.deleted_at IS NOT NULL)`).get(),
  "MODEL_PROVIDER_SCHEMA_INVALID");
  return "READY";
}

type SaveConnection = Omit<Extract<ModelProvidersCommand, { action: "save" }>, "command" | "action">;
type RouteSettings = Pick<ConnectionRevision, "presetId" | "protocol" | "baseUrl" | "region">;
type StoredRevision = ConnectionRevision & { endpointDigest: string };
type CommandKind = "APPLY" | "TEST";
type RouteCommand = { commandId: string; connectionId: string; routeRevision: number; modelId: string };
type CommandInput = { kind: "APPLY"; input: ApplyModelSelection } | { kind: "TEST"; input: RouteCommand };
export type ApplyModelSelection = RouteCommand & { expectedSelectionRevision: number };
type TestSnapshot = Extract<ModelRouteSnapshot, { purpose: "PROVIDER_TEST" }>;
type BusinessSnapshot = Exclude<ModelRouteSnapshot, TestSnapshot>;
export type TestReservation = { result: ModelTestResult; callId: string; snapshot: TestSnapshot | null };
type CredentialCleanupState = "ACTIVE" | "PENDING" | "FAILED" | "DONE";
export type RegisteredModelCredential = ModelCredentialRef & {
  createdAt: number; revokedAt: number | null; cleanupState: CredentialCleanupState; cleanupError: string | null;
};
export type GenerationOwner = { ownerKind: "SUGGESTION" | "DRAFT"; ownerId: string; ownerVersion: number };
export type ModelCallOutcome = "STARTED" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "DISCARDED" | "INTERRUPTED";
type CallCompletion = {
  outcome: Exclude<ModelCallOutcome, "STARTED">;
  reportedModel: string | null;
  errorCode: ModelCallErrorCode | null;
  usageDetails: ModelUsageDetails | null;
};
export type StoredModelCallRoute = Omit<CallCompletion, "outcome"> & {
  callId: string; connectionId: string; routeRevision: number; selectionRevision: number | null;
  credentialRevision: string; protocol: ModelProtocol; endpointDigest: string; requestedModel: string;
  grantVersion: number | null; purpose: ModelCallPurpose; outcome: ModelCallOutcome; createdAt: number;
};
export type LegacyModelSeed = { connectionId: string; modelId: string; credential: ModelCredentialRef | null };

type Schema<T> = { safeParse(input: unknown): { success: true; data: T } | { success: false } };
function checked<T>(schema: Schema<T>, input: unknown, code = "MODEL_PROVIDER_SCHEMA_INVALID"): T {
  const result = schema.safeParse(input);
  requireSafe(result.success, code);
  return result.data;
}

function decoded<T>(schema: Schema<T>, json: string): T {
  try { return checked(schema, JSON.parse(json)); }
  catch { throw new Blocked("MODEL_PROVIDER_SCHEMA_INVALID"); }
}

function sameRoute(left: RouteSettings, right: RouteSettings): boolean {
  return left.presetId === right.presetId && left.protocol === right.protocol
    && left.baseUrl === right.baseUrl && left.region === right.region;
}

function projectModels(discovered: ModelCatalogEntry[], manual: ModelCatalogEntry[], selected: string | null): ModelCatalogEntry[] {
  const models = new Map(manual.map(model => [model.modelId, model]));
  for (const model of discovered) {
    if (!models.has(model.modelId) && models.size < 4000) models.set(model.modelId, model);
  }
  if (selected && !models.has(selected)) {
    if (models.size === 4000) models.delete([...models.keys()].at(-1)!);
    models.set(selected, discovered.find(model => model.modelId === selected)
      ?? { modelId: selected, displayName: null, source: "DISCOVERED" });
  }
  return [...models.values()];
}

export function inlineModelEntries(models: ModelCatalogEntry[], selected: string | null): ModelCatalogEntry[] {
  const preview = models.slice(0, INLINE_MODEL_LIMIT);
  if (selected && !preview.some(model => model.modelId === selected)) {
    const entry = models.find(model => model.modelId === selected);
    if (entry) preview[INLINE_MODEL_LIMIT - 1] = entry;
  }
  return preview;
}

const storedCatalogSummarySchema = modelCatalogSummarySchema.omit({ selectedModelInCatalog: true }).extend({
  retainedSelectedModelId: modelIdSchema.nullable(),
});

const connections = `SELECT id,name,preset_id AS presetId,version,draft_revision AS draftRevision,
  models_json AS modelsJson,models_fetched_at AS modelsFetchedAt,deleted_at AS deletedAt FROM m_connections`;
const credentialColumns = `c.credential_revision AS credentialRevision,c.connection_id AS connectionId,c.storage,
  c.created_at AS createdAt,c.revoked_at AS revokedAt,c.cleanup_state AS cleanupState,c.cleanup_error AS cleanupError`;
const unreferenced = `c.cleanup_state!='DONE' AND (c.revoked_at IS NOT NULL OR (
  NOT EXISTS (SELECT 1 FROM m_selection s JOIN m_connection_revisions r
    ON r.connection_id=s.connection_id AND r.route_revision=s.route_revision WHERE r.credential_revision=c.credential_revision)
  AND NOT EXISTS (SELECT 1 FROM m_connections n JOIN m_connection_revisions r
    ON r.connection_id=n.id AND r.route_revision=n.draft_revision
    WHERE n.deleted_at IS NULL AND r.credential_revision=c.credential_revision)
  AND NOT EXISTS (SELECT 1 FROM m_call_routes t WHERE t.credential_revision=c.credential_revision
    AND t.purpose='PROVIDER_TEST' AND t.outcome='STARTED')
))`;

export class ModelProviderStore {
  constructor(readonly db: Database.Database, private readonly now: () => number = Date.now) {
    requireSafe(inspectModelProviderSchema(db) === "READY", "MODEL_PROVIDER_SCHEMA_INVALID");
    requireSafe(db.pragma("foreign_keys", { simple: true }) === 1, "MODEL_PROVIDER_SCHEMA_INVALID");
  }

  private decodeConnection(row: Omit<ModelConnection, "models"> & { modelsJson: string }): ModelConnection {
    const { modelsJson, ...fields } = row;
    try { return checked(modelConnectionSchema, { ...fields, models: JSON.parse(modelsJson) }); }
    catch { throw new Blocked("MODEL_PROVIDER_SCHEMA_INVALID"); }
  }

  listConnections(): ModelConnection[] {
    return (this.db.prepare(connections + " WHERE deleted_at IS NULL ORDER BY created_at,id").all() as
      Parameters<ModelProviderStore["decodeConnection"]>[0][]).map(row => this.decodeConnection(row));
  }

  listConnectionsPage(selection: ModelSelection, offset: number, limit: number, expectedListRevision?: number) {
    // Connections are soft-deleted. Both counters and the persistent selection revision only increase.
    const { totalConnectionCount, listRevision } = this.db.prepare(`SELECT count(*)-count(deleted_at) AS totalConnectionCount,
      count(*)+count(deleted_at)+? AS listRevision FROM m_connections`).get(selection.selectionRevision) as
      { totalConnectionCount: number; listRevision: number };
    requireSafe(expectedListRevision === undefined || listRevision === expectedListRevision, "MODEL_CONNECTION_CONFLICT");
    const rows = this.db.prepare(connections + " WHERE deleted_at IS NULL ORDER BY (id IS ?) DESC,created_at,id LIMIT ? OFFSET ?")
      .all(selection.connectionId, limit, offset) as Parameters<ModelProviderStore["decodeConnection"]>[0][];
    const end = offset + rows.length;
    return { connections: rows.map(row => this.decodeConnection(row)), totalConnectionCount, listRevision,
      nextConnectionOffset: end < totalConnectionCount ? end : null };
  }

  listModelsPage(connectionId: string, offset: number, limit: number): ModelCatalogPage {
    const { models, version } = this.requireConnection(connectionId);
    const page = models.slice(offset, offset + limit);
    const end = offset + page.length;
    return { connectionId, version, offset, nextOffset: end < models.length ? end : null,
      totalModelCount: models.length, models: page };
  }

  getConnection(id: string): ModelConnection | null {
    const row = this.db.prepare(connections + " WHERE id=?").get(id) as
      Parameters<ModelProviderStore["decodeConnection"]>[0] | undefined;
    return row ? this.decodeConnection(row) : null;
  }

  requireConnection(id: string): ModelConnection {
    const row = this.getConnection(id);
    requireSafe(row && row.deletedAt === null, "MODEL_CONNECTION_CONFLICT");
    return row;
  }

  requireConnectionVersion(id: string, expectedVersion: number): ModelConnection {
    const row = this.requireConnection(id);
    requireSafe(row.version === expectedVersion, "MODEL_CONNECTION_CONFLICT");
    return row;
  }

  getRevision(connectionId: string, routeRevision: number): StoredRevision | null {
    const row = this.db.prepare(`SELECT connection_id AS connectionId,route_revision AS routeRevision,
      preset_id AS presetId,protocol,base_url AS baseUrl,region,credential_revision AS credentialRevision,
      storage,created_at AS createdAt,endpoint_digest AS endpointDigest FROM m_connection_revisions
      WHERE connection_id=? AND route_revision=?`).get(connectionId, routeRevision) as StoredRevision | undefined;
    if (!row) return null;
    const { endpointDigest, ...revision } = row;
    try {
      const settings = checked(connectionRevisionSchema, revision);
      requireSafe(endpointDigest === endpointDigestForUrl(settings.baseUrl), "MODEL_PROVIDER_SCHEMA_INVALID");
      return { ...settings, endpointDigest };
    } catch { throw new Blocked("MODEL_PROVIDER_SCHEMA_INVALID"); }
  }

  getSelection(): ModelSelection {
    return checked(modelSelectionSchema, this.db.prepare(selectSelection + " WHERE id=1").get());
  }

  getModelDisplayName({ connectionId, routeRevision, modelId }: Extract<ModelSelection, { connectionId: string }>): string | null {
    const row = this.requireConnection(connectionId);
    const draftName = row.draftRevision === routeRevision ? row.models.find(model => model.modelId === modelId)?.displayName : null;
    return draftName
      ?? this.getDiscoveredModels(connectionId, routeRevision).find(model => model.modelId === modelId)?.displayName
      ?? row.models.find(model => model.source === "MANUAL" && model.modelId === modelId)?.displayName
      ?? null;
  }

  private writeRevision(id: string, revision: number, route: RouteSettings, credential: ModelCredentialRef | null, now: number) {
    this.db.prepare(`INSERT INTO m_connection_revisions
      (connection_id,route_revision,preset_id,protocol,base_url,region,credential_revision,storage,endpoint_digest,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, revision, route.presetId, route.protocol, route.baseUrl,
      route.region, credential?.credentialRevision ?? null, credential?.storage ?? "MEMORY", endpointDigestForUrl(route.baseUrl), now);
  }

  private registerCredential(ref: ModelCredentialRef, now: number) {
    validateModelCredentialRef(ref);
    this.db.prepare(`INSERT INTO m_credentials (credential_revision,connection_id,storage,created_at,cleanup_state)
      VALUES (?,?,?,?,'ACTIVE')`).run(ref.credentialRevision, ref.connectionId, ref.storage, now);
  }

  private insertConnection(id: string, name: string, route: RouteSettings, models: ModelCatalogEntry[],
    credential: ModelCredentialRef | null, now: number) {
    this.db.prepare(`INSERT INTO m_connections (id,name,preset_id,version,draft_revision,models_json,created_at,updated_at)
      VALUES (?,?,?,1,1,?,?,?)`).run(id, name, route.presetId, JSON.stringify(models), now, now);
    if (credential) {
      requireSafe(credential.connectionId === id, "INVALID_MODEL_CREDENTIAL_ID");
      this.registerCredential(credential, now);
    }
    this.writeRevision(id, 1, route, credential, now);
    return this.getConnection(id)!;
  }

  private updateDraft(row: ModelConnection, revision: number, route: RouteSettings, name: string, models: ModelCatalogEntry[],
    fetchedAt: number | null, now: number) {
    this.db.prepare(`UPDATE m_connections SET name=?,preset_id=?,version=version+1,draft_revision=?,
      models_json=?,models_fetched_at=?,updated_at=? WHERE id=?`)
      .run(name, route.presetId, revision, JSON.stringify(models), fetchedAt, now, row.id);
    return this.getConnection(row.id)!;
  }

  saveConnection(input: SaveConnection): ModelConnection {
    checked(modelProvidersCommandSchema, { ...input, command: "modelProviders", action: "save" }, "INVALID_MODEL_CONNECTION");
    const name = input.name.trim();
    const route = { ...input, baseUrl: normalizeBaseUrl(input.baseUrl) };
    const submitted = input.manualModels && [...new Map(input.manualModels.map(model => [model.modelId, {
      modelId: model.modelId, displayName: model.displayName ?? null, source: "MANUAL" as const,
    }])).values()];
    return this.db.transaction(() => {
      const row = input.connectionId ? this.requireConnectionVersion(input.connectionId, input.expectedVersion) : null;
      requireSafe(!this.db.prepare("SELECT id FROM m_connections WHERE deleted_at IS NULL AND name=? AND id!=?")
        .get(name, row?.id ?? ""), "MODEL_CONNECTION_CONFLICT");
      const now = this.now();
      if (!row) return this.insertConnection(randomUUID(), name, route, submitted ?? [], null, now);
      if (submitted && row.models.length > INLINE_MODEL_LIMIT) {
        requireSafe(input.manualModelsComplete, "MODEL_MANUAL_MODELS_TRUNCATED");
      }
      if (input.expectedSelectionRevision !== undefined) {
        requireSafe(this.getSelection().selectionRevision === input.expectedSelectionRevision, "MODEL_CONNECTION_CONFLICT");
      }
      const manual = submitted ?? row.models.filter(model => model.source === "MANUAL");
      const previous = this.getRevision(row.id, row.draftRevision)!;
      if (!sameRoute(route, previous)) {
        // A Key issued for a route must never silently move to any edited execution configuration.
        const next = row.draftRevision + 1;
        this.writeRevision(row.id, next, route, null, now);
        return this.updateDraft(row, next, route, name, manual, null, now);
      }
      const models = submitted ? projectModels(this.getDiscoveredModels(row.id, row.draftRevision), manual,
        this.selectedModel(row.id, row.draftRevision)) : row.models;
      return this.updateDraft(row, row.draftRevision, route, name, models, row.modelsFetchedAt, now);
    }).immediate();
  }

  setCredential(connectionId: string, expectedVersion: number, ref: ModelCredentialRef): ModelConnection {
    return this.db.transaction(() => {
      const row = this.requireConnectionVersion(connectionId, expectedVersion);
      requireSafe(ref.connectionId === connectionId, "INVALID_MODEL_CREDENTIAL_ID");
      const route = this.getRevision(row.id, row.draftRevision)!;
      const now = this.now();
      this.registerCredential(ref, now);
      this.writeRevision(row.id, row.draftRevision + 1, route, ref, now);
      return this.updateDraft(row, row.draftRevision + 1, route, row.name,
        row.models.filter(model => model.source === "MANUAL"), null, now);
    }).immediate();
  }

  private revokeConnectionKeys(id: string, now: number) {
    this.db.prepare(`UPDATE m_credentials SET revoked_at=?,cleanup_state='PENDING'
      WHERE connection_id=? AND revoked_at IS NULL`).run(now, id);
  }

  deleteKeys(connectionId: string, expectedVersion: number): ModelConnection {
    return this.db.transaction(() => {
      const row = this.requireConnectionVersion(connectionId, expectedVersion);
      const draft = this.getRevision(row.id, row.draftRevision)!;
      const selected = this.getSelection();
      const now = this.now();
      this.revokeConnectionKeys(row.id, now);
      let draftRevision = row.draftRevision + 1;
      const appliedRevision = draftRevision;
      if (selected.connectionId === row.id) {
        const applied = this.getRevision(row.id, selected.routeRevision)!;
        if (!sameRoute(draft, applied)) {
          this.writeRevision(row.id, appliedRevision, applied, null, now);
          draftRevision++;
        }
      }
      this.writeRevision(row.id, draftRevision, draft, null, now);
      if (selected.connectionId === row.id) {
        this.db.prepare("UPDATE m_selection SET route_revision=?,revision=revision+1 WHERE id=1").run(appliedRevision);
      }
      return this.updateDraft(row, draftRevision, draft, row.name,
        row.models.filter(model => model.source === "MANUAL"), null, now);
    }).immediate();
  }

  deleteConnection(connectionId: string, expectedVersion: number): void {
    this.db.transaction(() => {
      this.requireConnectionVersion(connectionId, expectedVersion);
      requireSafe(this.getSelection().connectionId !== connectionId, "MODEL_CONNECTION_CONFLICT");
      const now = this.now();
      this.revokeConnectionKeys(connectionId, now);
      this.db.prepare("UPDATE m_connections SET deleted_at=?,updated_at=?,version=version+1 WHERE id=?")
        .run(now, now, connectionId);
    }).immediate();
  }

  getCredential(credentialRevision: string): RegisteredModelCredential | null {
    return (this.db.prepare(`SELECT ${credentialColumns} FROM m_credentials c WHERE c.credential_revision=?`)
      .get(credentialRevision) as RegisteredModelCredential | undefined) ?? null;
  }

  isCredentialActive = (ref: ModelCredentialRef): boolean => {
    const registered = this.getCredential(ref.credentialRevision);
    return !!registered && registered.connectionId === ref.connectionId && registered.storage === ref.storage
      && registered.revokedAt === null;
  };

  listCleanableCredentials(): RegisteredModelCredential[] {
    return this.db.prepare(`SELECT ${credentialColumns} FROM m_credentials c WHERE ${unreferenced}`)
      .all() as RegisteredModelCredential[];
  }

  claimCredentialCleanup(ref: ModelCredentialRef): boolean {
    return this.db.prepare(`UPDATE m_credentials AS c SET revoked_at=coalesce(revoked_at,?),
      cleanup_state='PENDING',cleanup_error=NULL WHERE credential_revision=? AND connection_id=? AND storage=? AND ${unreferenced}`)
      .run(this.now(), ref.credentialRevision, ref.connectionId, ref.storage).changes === 1;
  }

  finishCredentialCleanup(ref: ModelCredentialRef, removed: boolean): void {
    this.db.prepare(`UPDATE m_credentials SET cleanup_state=?,cleanup_error=?
      WHERE credential_revision=? AND connection_id=? AND storage=? AND cleanup_state='PENDING'`)
      .run(removed ? "DONE" : "FAILED", removed ? null : "MODEL_CREDENTIAL_CLEANUP_FAILED",
        ref.credentialRevision, ref.connectionId, ref.storage);
  }

  getRevisionStatus(connectionId: string, routeRevision: number, selected = this.selectedModel(connectionId, routeRevision)): {
    catalogResult: ModelCatalogSummary | null; testResult: ModelTestResult | null;
  } {
    const catalog = this.db.prepare(`SELECT catalog_result_json FROM m_connection_revisions
      WHERE connection_id=? AND route_revision=?`).pluck().get(connectionId, routeRevision) as string | null | undefined;
    const test = this.db.prepare(`SELECT c.result_json FROM m_commands c JOIN m_call_routes r ON r.call_id=c.call_id
      WHERE r.connection_id=? AND r.route_revision=? AND r.purpose='PROVIDER_TEST'
      ORDER BY c.rowid DESC LIMIT 1`).pluck().get(connectionId, routeRevision) as string | undefined;
    return {
      catalogResult: catalog ? this.readCatalogSummary(catalog, connectionId, routeRevision, selected) : null,
      testResult: test ? decoded(modelTestResultSchema, test) : null,
    };
  }

  private readCatalogSummary(json: string, connectionId: string, routeRevision: number, selected: string | null): ModelCatalogSummary {
    const raw: unknown = JSON.parse(json);
    if (raw && typeof raw === "object" && "models" in raw) {
      const { models, ...fields } = checked(modelCatalogResultSchema, raw);
      return { ...fields, totalCount: models.length, truncated: catalogReachedLimit(fields),
        selectedModelInCatalog: selected && fields.status !== "FAILED" ? models.some(model => model.modelId === selected) : null };
    }
    const { retainedSelectedModelId, ...summary } = checked(storedCatalogSummarySchema, raw);
    const present = selected && summary.status !== "FAILED" ? selected !== retainedSelectedModelId &&
      !!this.db.prepare(`SELECT 1 FROM m_connection_revisions r, json_each(r.catalog_models_json) m
        WHERE r.connection_id=? AND r.route_revision=? AND json_extract(m.value,'$.modelId')=? LIMIT 1`)
        .get(connectionId, routeRevision, selected) : null;
    return { ...summary, truncated: catalogReachedLimit(summary), selectedModelInCatalog: present };
  }

  private getDiscoveredModels(connectionId: string, routeRevision: number): ModelCatalogEntry[] {
    const json = this.db.prepare("SELECT catalog_models_json FROM m_connection_revisions WHERE connection_id=? AND route_revision=?")
      .pluck().get(connectionId, routeRevision) as string | undefined;
    requireSafe(json, "MODEL_PROVIDER_SCHEMA_INVALID");
    return decoded(modelConnectionSchema.shape.models, json);
  }

  private selectedModel(connectionId: string, routeRevision: number): string | null {
    const selection = this.getSelection();
    return selection.connectionId === connectionId && selection.routeRevision === routeRevision ? selection.modelId : null;
  }

  recordCatalog(input: ModelCatalogResult): ModelCatalogSummary {
    const result = checked(modelCatalogResultSchema.strip(), input, "INVALID_MODEL_CATALOG_RESULT");
    return this.db.transaction(() => {
      const row = this.requireConnection(result.connectionId);
      requireSafe(this.getRevision(row.id, result.routeRevision), "MODEL_CONNECTION_CONFLICT");
      const selected = this.selectedModel(row.id, result.routeRevision);
      const { models: refreshed, ...fields } = result;
      const selectedIndex = refreshed.findIndex(model => model.modelId === selected);
      let discovered: ModelCatalogEntry[] | null = null;
      if (fields.status !== "FAILED") {
        const previous = this.getDiscoveredModels(row.id, result.routeRevision);
        discovered = mergeModelCatalog(previous, result, selected).models;
        const index = discovered.findIndex(model => model.modelId === selected);
        if (selectedIndex >= 0 && index >= 0) {
          const [entry] = discovered.splice(index, 1);
          discovered.splice(selectedIndex, 0, { ...entry!,
            displayName: entry!.displayName ?? previous.find(model => model.modelId === selected)?.displayName ?? null });
        }
      }
      const summary = { ...fields, totalCount: refreshed.length, truncated: catalogReachedLimit(fields) };
      this.db.prepare(`UPDATE m_connection_revisions SET catalog_result_json=?,catalog_models_json=coalesce(?,catalog_models_json)
        WHERE connection_id=? AND route_revision=?`).run(
        JSON.stringify({ ...summary, retainedSelectedModelId: selectedIndex < 0 ? selected : null }),
        discovered ? JSON.stringify(discovered) : null, row.id, result.routeRevision);
      if (row.draftRevision === result.routeRevision && discovered) {
        const models = projectModels(discovered, row.models.filter(model => model.source === "MANUAL"), selected);
        this.db.prepare("UPDATE m_connections SET models_json=?,models_fetched_at=?,version=version+1,updated_at=? WHERE id=?")
          .run(JSON.stringify(models), result.fetchedAt, this.now(), row.id);
      }
      return { ...summary, selectedModelInCatalog: selected && discovered ? selectedIndex >= 0 : null };
    }).immediate();
  }

  private lookupCommand(command: CommandInput): { callId: string | null; json: string } | null {
    const row = this.db.prepare("SELECT kind,params_digest AS digest,call_id AS callId,result_json AS json FROM m_commands WHERE command_id=?")
      .get(command.input.commandId) as { kind: CommandKind; digest: string; callId: string | null; json: string } | undefined;
    if (!row) return null;
    requireSafe(row.kind === command.kind && row.digest === this.commandDigest(command), "MODEL_COMMAND_CONFLICT");
    return row;
  }

  private commandDigest(command: CommandInput): string {
    const { connectionId, routeRevision, modelId } = command.input;
    return digest([connectionId, routeRevision, modelId, command.kind === "APPLY"
      ? command.input.expectedSelectionRevision : MODEL_PROVIDER_TEST_VERSION]);
  }

  getCommand(command: { kind: "APPLY"; input: ApplyModelSelection }): { result: ModelSelection; callId: null } | null;
  getCommand(command: { kind: "TEST"; input: RouteCommand }): { result: ModelTestResult; callId: string } | null;
  getCommand(command: CommandInput) {
    const row = this.lookupCommand(command);
    if (!row) return null;
    return command.kind === "APPLY"
      ? { result: decoded(modelSelectionSchema, row.json), callId: null }
      : { result: decoded(modelTestResultSchema, row.json), callId: row.callId };
  }

  private validateCommand(command: CommandInput) {
    checked(modelProvidersCommandSchema, { ...command.input, command: "modelProviders",
      action: command.kind === "APPLY" ? "apply" : "test", confirmed: true }, "INVALID_MODEL_COMMAND");
  }

  private requireKeyedRoute(input: RouteCommand): StoredRevision & { credentialRevision: string } {
    this.requireConnection(input.connectionId);
    const route = this.getRevision(input.connectionId, input.routeRevision);
    requireSafe(route, "MODEL_CONNECTION_CONFLICT");
    const credentialRevision = route.credentialRevision;
    requireSafe(credentialRevision && this.isCredentialActive({ ...route, credentialRevision }), "MODEL_KEY_REQUIRED");
    return { ...route, credentialRevision };
  }

  private insertCommand(command: CommandInput, state: ModelTestResult["status"], callId: string | null, result: unknown, now: number) {
    this.db.prepare("INSERT INTO m_commands VALUES (?,?,?,?,?,?,?,?)")
      .run(command.input.commandId, command.kind, this.commandDigest(command), state, callId, JSON.stringify(result), now, now);
  }

  // The hook runs after the selection write, on this connection, before the transaction commits.
  apply(input: ApplyModelSelection, onSwitch?: (previous: ModelSelection, next: ModelSelection, route: StoredRevision) => undefined): ModelSelection {
    const command = { kind: "APPLY", input } as const;
    return this.db.transaction(() => {
      const existing = this.getCommand(command);
      if (existing) return existing.result;
      this.validateCommand(command);
      const previous = this.getSelection();
      requireSafe(previous.selectionRevision === input.expectedSelectionRevision, "MODEL_CONNECTION_CONFLICT");
      const route = this.requireKeyedRoute(input);
      const { connectionId, routeRevision, modelId } = input;
      const same = previous.connectionId === connectionId && previous.routeRevision === routeRevision && previous.modelId === modelId;
      const next = { connectionId, routeRevision, modelId, selectionRevision: previous.selectionRevision + Number(!same) };
      if (!same) {
        requireSafe(Object.prototype.toString.call(onSwitch) !== "[object AsyncFunction]", "MODEL_PROVIDER_TRANSACTION_HOOK_ASYNC");
        this.db.prepare("UPDATE m_selection SET connection_id=?,route_revision=?,model_id=?,revision=? WHERE id=1")
          .run(connectionId, routeRevision, modelId, next.selectionRevision);
        requireSafe(onSwitch?.(previous, next, route) === undefined, "MODEL_PROVIDER_TRANSACTION_HOOK_ASYNC");
      }
      this.insertCommand(command, "SUCCEEDED", null, next, this.now());
      return next;
    }).immediate();
  }

  // Reserve budget and recheck the caller's authority within this hook. Replay bypasses it.
  startTest(input: RouteCommand, reserve: (callId: string, snapshot: TestSnapshot) => undefined): TestReservation {
    const command = { kind: "TEST", input } as const;
    return this.db.transaction(() => {
      const existing = this.getCommand(command);
      if (existing) return { ...existing, snapshot: null };
      this.validateCommand(command);
      requireSafe(Object.prototype.toString.call(reserve) !== "[object AsyncFunction]", "MODEL_PROVIDER_TRANSACTION_HOOK_ASYNC");
      const route = this.requireKeyedRoute(input);
      const { commandId, connectionId, routeRevision, modelId } = input;
      const { presetId, protocol, endpointDigest, credentialRevision } = route;
      const snapshot = {
        commandId, connectionId, routeRevision, modelId, presetId, protocol, endpointDigest, credentialRevision,
        purpose: "PROVIDER_TEST", selectionRevision: null, grantVersion: null, testVersion: MODEL_PROVIDER_TEST_VERSION,
      } as const;
      const callId = randomUUID();
      requireSafe(reserve(callId, snapshot) === undefined, "MODEL_PROVIDER_TRANSACTION_HOOK_ASYNC");
      this.db.prepare("INSERT INTO model_calls VALUES (?,?,'STARTED',NULL,NULL,NULL,NULL)").run(callId, modelId);
      this.insertCallRoute(callId, snapshot);
      const result = { commandId, connectionId, routeRevision, modelId, status: "STARTED",
        reportedModelId: null, elapsedMs: null, usage: null, reason: null } as const;
      this.insertCommand(command, "STARTED", callId, result, this.now());
      return { result, callId, snapshot };
    }).immediate();
  }

  finishTest(input: ModelTestResult): ModelTestResult {
    const result = checked(modelTestResultSchema, input, "INVALID_MODEL_TEST_RESULT");
    requireSafe(result.status !== "STARTED", "INVALID_MODEL_TEST_RESULT");
    return this.db.transaction(() => {
      const command = this.getCommand({ kind: "TEST", input: result });
      requireSafe(command, "MODEL_COMMAND_CONFLICT");
      if (command.result.status !== "STARTED") return command.result;
      const route = this.getCallRoute(command.callId)!;
      const ref = this.getCredential(route.credentialRevision)!;
      const completed: ModelTestResult = this.isCredentialActive(ref) ? result : {
        ...result, status: "INTERRUPTED", reason: "MODEL_ROUTE_CHANGED",
      };
      requireSafe(this.updateCallRoute(command.callId, {
        outcome: completed.status as Exclude<ModelCallOutcome, "STARTED">, reportedModel: completed.reportedModelId,
        errorCode: completed.reason, usageDetails: completed.usage,
      }), "MODEL_PROVIDER_SCHEMA_INVALID");
      const status = completed.status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED";
      this.db.prepare("UPDATE model_calls SET status=?,input_tokens=?,output_tokens=?,elapsed_ms=? WHERE id=?")
        .run(status, completed.usage?.inputTokens ?? null, completed.usage?.outputTokens ?? null, completed.elapsedMs, command.callId);
      this.db.prepare("UPDATE m_commands SET state=?,result_json=?,updated_at=? WHERE command_id=?")
        .run(completed.status, JSON.stringify(completed), this.now(), result.commandId);
      return completed;
    }).immediate();
  }

  interruptTests(): number {
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT result_json FROM m_commands WHERE kind='TEST' AND state='STARTED'").pluck().all() as string[];
      for (const json of rows) this.finishTest({ ...decoded(modelTestResultSchema, json), status: "INTERRUPTED" });
      return rows.length;
    }).immediate();
  }

  interruptBusinessCalls(): void {
    this.db.transaction(() => {
      const started = "outcome='STARTED' AND purpose<>'PROVIDER_TEST'";
      this.db.prepare(`UPDATE model_calls SET status='FAILED' WHERE id IN (SELECT call_id FROM m_call_routes WHERE ${started})`).run();
      this.db.prepare(`UPDATE m_call_routes SET outcome='INTERRUPTED',error_code='MODEL_CANCELLED' WHERE ${started}`).run();
    }).immediate();
  }

  recordCallRoute(callId: string, input: BusinessSnapshot): void {
    const snapshot = checked(modelRouteSnapshotSchema, input, "INVALID_MODEL_ROUTE_SNAPSHOT");
    this.db.transaction(() => {
      const selection = this.getSelection();
      requireSafe(snapshot.purpose !== "PROVIDER_TEST" && selection.connectionId === snapshot.connectionId
        && selection.routeRevision === snapshot.routeRevision && selection.selectionRevision === snapshot.selectionRevision
        && selection.modelId === snapshot.modelId, "MODEL_ROUTE_CHANGED");
      const route = this.getRevision(snapshot.connectionId, snapshot.routeRevision);
      requireSafe(route?.presetId === snapshot.presetId && this.isCredentialActive({
        connectionId: snapshot.connectionId, credentialRevision: snapshot.credentialRevision, storage: route.storage,
      }), "MODEL_ROUTE_CHANGED");
      requireSafe(this.db.prepare("SELECT model FROM model_calls WHERE id=?").pluck().get(callId) === snapshot.modelId,
        "INVALID_MODEL_ROUTE_SNAPSHOT");
      this.insertCallRoute(callId, snapshot);
    }).immediate();
  }

  private insertCallRoute(callId: string, snapshot: ModelRouteSnapshot): void {
    this.db.prepare(`INSERT INTO m_call_routes
      (call_id,connection_id,route_revision,selection_revision,credential_revision,protocol,endpoint_digest,
       requested_model,grant_version,purpose,outcome,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'STARTED',?)`)
      .run(callId, snapshot.connectionId, snapshot.routeRevision, snapshot.selectionRevision, snapshot.credentialRevision,
        snapshot.protocol, snapshot.endpointDigest, snapshot.modelId, snapshot.grantVersion, snapshot.purpose, this.now());
  }

  getCallRoute(callId: string): StoredModelCallRoute | null {
    const row = this.db.prepare(`SELECT call_id AS callId,connection_id AS connectionId,route_revision AS routeRevision,
      selection_revision AS selectionRevision,credential_revision AS credentialRevision,protocol,endpoint_digest AS endpointDigest,
      requested_model AS requestedModel,reported_model AS reportedModel,grant_version AS grantVersion,purpose,outcome,
      error_code AS errorCode,usage_details_json AS usageJson,created_at AS createdAt FROM m_call_routes WHERE call_id=?`)
      .get(callId) as (Omit<StoredModelCallRoute, "usageDetails"> & { usageJson: string | null }) | undefined;
    if (!row) return null;
    const { usageJson, ...route } = row;
    return { ...route, usageDetails: usageJson ? decoded(modelUsageDetailsSchema, usageJson) : null };
  }

  finishCallRoute(callId: string, result: CallCompletion): boolean {
    requireSafe(this.getCallRoute(callId)?.purpose !== "PROVIDER_TEST", "INVALID_MODEL_CALL_RESULT");
    return this.updateCallRoute(callId, result);
  }

  discardUnpublishedCall(callId: string, reason: ModelCallErrorCode): void {
    this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE m_call_routes SET outcome='DISCARDED',error_code=?
        WHERE call_id=? AND outcome='SUCCEEDED' AND purpose<>'PROVIDER_TEST'
        AND NOT EXISTS (SELECT 1 FROM m_generation_bindings WHERE call_id=?)`).run(reason, callId, callId).changes;
      if (changed) this.db.prepare("UPDATE model_calls SET status='FAILED' WHERE id=?").run(callId);
    }).immediate();
  }

  private updateCallRoute(callId: string, result: CallCompletion): boolean {
    if (result.reportedModel !== null) checked(modelIdSchema, result.reportedModel, "INVALID_MODEL_CALL_RESULT");
    if (result.errorCode !== null) checked(modelCallErrorCodeSchema, result.errorCode, "INVALID_MODEL_CALL_RESULT");
    const usage = result.usageDetails === null ? null
      : JSON.stringify(checked(modelUsageDetailsSchema, result.usageDetails, "INVALID_MODEL_CALL_RESULT"));
    return this.db.prepare(`UPDATE m_call_routes SET outcome=?,reported_model=?,error_code=?,usage_details_json=?
      WHERE call_id=? AND outcome='STARTED'`).run(result.outcome, result.reportedModel, result.errorCode, usage, callId).changes === 1;
  }

  getGenerationCallId(owner: GenerationOwner): string | null {
    return (this.db.prepare("SELECT call_id FROM m_generation_bindings WHERE owner_kind=? AND owner_id=? AND owner_version=?")
      .pluck().get(owner.ownerKind, owner.ownerId, owner.ownerVersion) as string | undefined) ?? null;
  }

  bindGeneration(owner: GenerationOwner, callId: string): void {
    const route = this.getCallRoute(callId);
    requireSafe(route?.purpose === "REPLY_GENERATION" && route.outcome === "SUCCEEDED", "INVALID_MODEL_GENERATION_SOURCE");
    this.db.prepare("INSERT INTO m_generation_bindings VALUES (?,?,?,?)")
      .run(owner.ownerKind, owner.ownerId, owner.ownerVersion, callId);
  }

  copyGenerationBinding(from: GenerationOwner, to: GenerationOwner): boolean {
    const callId = this.getGenerationCallId(from);
    if (!callId) return false;
    this.bindGeneration(to, callId);
    return true;
  }

  static initialize(db: Database.Database, seed?: LegacyModelSeed): ModelProviderStore {
    return db.transaction(() => {
      requireSafe(inspectModelProviderSchema(db) === "ABSENT", "MODEL_PROVIDER_SCHEMA_INVALID");
      db.exec(sql);
      const store = new ModelProviderStore(db);
      if (seed) {
        const modelId = checked(modelIdSchema, seed.modelId, "INVALID_LEGACY_MODEL_SETTINGS");
        store.insertConnection(seed.connectionId, "DeepSeek", {
          presetId: "deepseek", protocol: "OPENAI_CHAT", baseUrl: "https://api.deepseek.com", region: null,
        }, [{ modelId, displayName: null, source: "MANUAL" }], seed.credential, store.now());
        db.prepare("UPDATE m_selection SET connection_id=?,route_revision=1,model_id=?,revision=1 WHERE id=1")
          .run(seed.connectionId, modelId);
        store.getSelection();
      }
      return store;
    }).immediate();
  }
}

export const initializeModelProviderSchema = ModelProviderStore.initialize;
