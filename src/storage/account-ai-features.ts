import type Database from "better-sqlite3";
import {
  accountAiFeaturesSchema,
  DEFAULT_ACCOUNT_AI_FEATURES,
  type AccountAiFeatures,
} from "../contracts/ai-runtime.js";
import { Blocked } from "../core/contracts.js";

const TABLE = "account_ai_features";

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS account_ai_features (
  account_id TEXT PRIMARY KEY,
  features_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;`;

function cloneDefaults(): AccountAiFeatures {
  return {
    visionEnabled: DEFAULT_ACCOUNT_AI_FEATURES.visionEnabled,
    mediaReplyEnabled: DEFAULT_ACCOUNT_AI_FEATURES.mediaReplyEnabled,
    enabledBusinessTools: [],
    toolEndpoints: {},
    syncCustomerAvatars: DEFAULT_ACCOUNT_AI_FEATURES.syncCustomerAvatars,
  };
}

function normalizeFeatures(input: AccountAiFeatures): AccountAiFeatures {
  const toolEndpoints: AccountAiFeatures["toolEndpoints"] = {};
  for (const [key, value] of Object.entries(input.toolEndpoints)) {
    if (typeof value === "string" && value.length > 0) {
      toolEndpoints[key as keyof AccountAiFeatures["toolEndpoints"]] = value;
    }
  }
  return {
    visionEnabled: input.visionEnabled,
    mediaReplyEnabled: input.mediaReplyEnabled,
    enabledBusinessTools: [...new Set(input.enabledBusinessTools)],
    toolEndpoints,
    syncCustomerAvatars: input.syncCustomerAvatars,
  };
}

/** Per-account AI capability flags stored lazily in `account_ai_features`. */
export class AccountAiFeaturesStore {
  constructor(
    private readonly db: Database.Database,
    private readonly accountId: string,
    private readonly now: () => number = Date.now,
  ) {}

  private hasTable(): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?").get(TABLE),
    );
  }

  /** Pure read-only load; returns safe all-disabled defaults when table or row is absent. */
  get(): AccountAiFeatures {
    if (!this.hasTable()) return cloneDefaults();
    const row = this.db
      .prepare("SELECT features_json FROM account_ai_features WHERE account_id=?")
      .get(this.accountId) as { features_json: string } | undefined;
    if (!row) return cloneDefaults();
    try {
      const parsed = accountAiFeaturesSchema.safeParse(JSON.parse(row.features_json));
      return parsed.success ? normalizeFeatures(parsed.data) : cloneDefaults();
    } catch {
      return cloneDefaults();
    }
  }

  save(input: AccountAiFeatures): AccountAiFeatures {
    const parsed = accountAiFeaturesSchema.safeParse(input);
    if (!parsed.success) {
      throw new Blocked("INVALID_ACCOUNT_AI_FEATURES");
    }
    const normalized = normalizeFeatures(parsed.data);
    const updatedAt = this.now();
    this.db.transaction(() => {
      this.db.exec(CREATE_TABLE_SQL);
      this.db
        .prepare(
          `INSERT INTO account_ai_features (account_id, features_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
             features_json=excluded.features_json,
             updated_at=excluded.updated_at`,
        )
        .run(this.accountId, JSON.stringify(normalized), updatedAt);
    }).immediate();
    return normalized;
  }

  /** Atomically patches only `syncCustomerAvatars`, preserving all other account AI flags. */
  setSyncCustomerAvatars(enabled: boolean): AccountAiFeatures {
    const updatedAt = this.now();
    let saved = cloneDefaults();
    this.db.transaction(() => {
      this.db.exec(CREATE_TABLE_SQL);
      const row = this.db
        .prepare("SELECT features_json FROM account_ai_features WHERE account_id=?")
        .get(this.accountId) as { features_json: string } | undefined;
      let current = cloneDefaults();
      if (row) {
        try {
          const parsed = accountAiFeaturesSchema.safeParse(JSON.parse(row.features_json));
          if (parsed.success) current = normalizeFeatures(parsed.data);
        } catch {
          current = cloneDefaults();
        }
      }
      saved = { ...current, syncCustomerAvatars: Boolean(enabled) };
      this.db
        .prepare(
          `INSERT INTO account_ai_features (account_id, features_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
             features_json=excluded.features_json,
             updated_at=excluded.updated_at`,
        )
        .run(this.accountId, JSON.stringify(saved), updatedAt);
    }).immediate();
    return saved;
  }
}
