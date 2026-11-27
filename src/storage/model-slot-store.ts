import type Database from "better-sqlite3";
import { validateModelProvider } from "../ai/provider-factory.js";
import {
  modelProvidersCommandSchema,
  modelSlotRouteSchema,
  OPTIONAL_MODEL_SLOTS,
  publicModelSlotsSchema,
  type ModelSlotRoute,
  type OptionalModelSlot,
  type PublicModelSlots,
} from "../contracts/model-providers.js";
import { Blocked, requireSafe } from "../core/contracts.js";
import type { ModelProviderStore } from "./model-provider-store.js";

const SLOT_TABLE = "model_slot_routes";

const CREATE_SLOT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS model_slot_routes (
  slot TEXT PRIMARY KEY CHECK(slot IN ('vision','utility','embedding')),
  connection_id TEXT,
  route_revision INTEGER,
  model_id TEXT,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;`;

interface SlotRow {
  slot: OptionalModelSlot;
  connection_id: string | null;
  route_revision: number | null;
  model_id: string | null;
  revision: number;
  updated_at: number;
}

export interface SetModelSlotInput {
  commandId: string;
  slot: OptionalModelSlot;
  connectionId: string | null;
  routeRevision: number | null;
  modelId: string | null;
  confirmed: true;
}

/** Progressive 4-slot route store backed by lazy non-`m_` table `model_slot_routes`. */
export class ModelSlotStore {
  constructor(
    private readonly models: ModelProviderStore,
    private readonly now: () => number = Date.now,
  ) {}

  private get db(): Database.Database {
    return this.models.db;
  }

  private hasTable(): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?").get(SLOT_TABLE),
    );
  }

  private readPrimary(): PublicModelSlots["primary"] {
    const selection = this.models.getSelection();
    if (selection.connectionId === null) return selection;
    const modelDisplayName = this.models.getModelDisplayName(selection);
    return modelDisplayName ? { ...selection, modelDisplayName } : selection;
  }

  /** Pure read-only slot snapshot; never creates `model_slot_routes` when absent. */
  getSlots(): PublicModelSlots {
    const slots: PublicModelSlots = {
      primary: this.readPrimary(),
      vision: null,
      utility: null,
      embedding: null,
    };
    if (!this.hasTable()) return slots;

    const rows = this.db
      .prepare("SELECT slot, connection_id, route_revision, model_id, revision, updated_at FROM model_slot_routes")
      .all() as SlotRow[];
    for (const row of rows) {
      if (!OPTIONAL_MODEL_SLOTS.includes(row.slot)) continue;
      if (row.connection_id === null || row.route_revision === null || row.model_id === null) {
        slots[row.slot] = null;
        continue;
      }
      const parsed = modelSlotRouteSchema.safeParse({
        slot: row.slot,
        connectionId: row.connection_id,
        routeRevision: row.route_revision,
        modelId: row.model_id,
        revision: row.revision,
        updatedAt: row.updated_at,
      });
      if (parsed.success) {
        slots[row.slot] = parsed.data;
      }
    }
    return publicModelSlotsSchema.parse(slots);
  }

  getSlot(slot: OptionalModelSlot): ModelSlotRoute | null {
    return this.getSlots()[slot];
  }

  /** Bind or clear an optional slot (`vision`, `utility`, or `embedding`). */
  setSlot(input: SetModelSlotInput): PublicModelSlots {
    const parsed = modelProvidersCommandSchema.safeParse({
      ...input,
      command: "modelProviders",
      action: "setSlot",
    });
    if (!parsed.success || parsed.data.action !== "setSlot") {
      throw new Blocked("MODEL_SLOT_INVALID");
    }

    return this.db.transaction(() => {
      this.db.exec(CREATE_SLOT_TABLE_SQL);
      const existing = this.db
        .prepare("SELECT revision FROM model_slot_routes WHERE slot=?")
        .get(input.slot) as { revision: number } | undefined;

      if (input.connectionId !== null) {
        this.models.requireConnection(input.connectionId);
        const route = this.models.getRevision(input.connectionId, input.routeRevision!);
        requireSafe(route, "MODEL_CONNECTION_CONFLICT");
        requireSafe(
          route.credentialRevision && this.models.isCredentialActive({ ...route, credentialRevision: route.credentialRevision }),
          "MODEL_KEY_REQUIRED",
        );
        validateModelProvider({ ...route, modelId: input.modelId! }, route.baseUrl);
      }

      const nextRevision = (existing?.revision ?? 0) + 1;
      const updatedAt = this.now();
      this.db
        .prepare(
          `INSERT INTO model_slot_routes (slot, connection_id, route_revision, model_id, revision, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(slot) DO UPDATE SET
             connection_id=excluded.connection_id,
             route_revision=excluded.route_revision,
             model_id=excluded.model_id,
             revision=excluded.revision,
             updated_at=excluded.updated_at`,
        )
        .run(input.slot, input.connectionId, input.routeRevision, input.modelId, nextRevision, updatedAt);

      return this.getSlots();
    }).immediate();
  }
}
