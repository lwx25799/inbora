import type Database from 'better-sqlite3';
import type { AccountId } from '../../contracts/account.js';
import type { Channel } from '../../core/contracts.js';
import type { RhythmConfig, RhythmPreset, RhythmProfile } from './types.js';

export type RhythmScope = 'ALL' | Channel;

export const RHYTHM_PRESETS: Readonly<Record<Exclude<RhythmProfile, 'off'>, RhythmPreset>> = {
  /** 保守档：更长动作间隔、更低突发窗口上限、撞限后较长冷却 */
  calm: {
    minIntervalMs: 8_000,
    maxIntervalMs: 15_000,
    burstWindowMs: 5 * 60_000,
    burstMaxActions: 5,
    cooloffMs: 3 * 60_000,
  },
  /** 自然档：生产推荐默认档 */
  natural: {
    minIntervalMs: 3_000,
    maxIntervalMs: 8_000,
    burstWindowMs: 5 * 60_000,
    burstMaxActions: 12,
    cooloffMs: 90_000,
  },
  /** 活跃档：高频客服时段使用，仍保有突发上限与撞限冷却 */
  active: {
    minIntervalMs: 1_500,
    maxIntervalMs: 4_000,
    burstWindowMs: 5 * 60_000,
    burstMaxActions: 25,
    cooloffMs: 45_000,
  },
};

export interface RhythmDecision {
  allowed: boolean;
  reasonCode:
    | 'RHYTHM_OFF'
    | 'RHYTHM_ALLOWED'
    | 'RHYTHM_MIN_INTERVAL_WAIT'
    | 'RHYTHM_BURST_LIMIT_REACHED'
    | 'RHYTHM_COOLOFF_ACTIVE';
  profile: RhythmProfile;
  scope: RhythmScope;
  retryAfterMs: number;
  nextAllowedAt: number;
  cooloffUntil: number;
  windowCount: number;
  burstMaxActions: number;
  cooloffTriggered: boolean;
}

export interface RhythmStateSnapshot {
  accountId: AccountId;
  scope: RhythmScope;
  profile: RhythmProfile;
  lastActionAt: number;
  nextAllowedAt: number;
  cooloffUntil: number;
  windowTimestamps: number[];
  totalActions: number;
  cooloffHits: number;
  updatedAt: number;
}

interface RhythmRow {
  account_id: string;
  channel: string;
  profile: string;
  last_action_at: number;
  next_allowed_at: number;
  cooloff_until: number;
  window_timestamps_json: string;
  recorded_intents_json?: string;
  total_actions: number;
  cooloff_hits: number;
  updated_at: number;
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS rhythm_account_state (
  account_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  profile TEXT NOT NULL,
  last_action_at INTEGER NOT NULL DEFAULT 0,
  next_allowed_at INTEGER NOT NULL DEFAULT 0,
  cooloff_until INTEGER NOT NULL DEFAULT 0,
  window_timestamps_json TEXT NOT NULL DEFAULT '[]',
  recorded_intents_json TEXT NOT NULL DEFAULT '[]',
  total_actions INTEGER NOT NULL DEFAULT 0,
  cooloff_hits INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, channel)
)`;

function hasRhythmTable(db: Database.Database): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rhythm_account_state'").get(),
  );
}

function ensureRhythmTable(db: Database.Database): void {
  db.exec(CREATE_TABLE_SQL);
  const cols = db.prepare("SELECT name FROM pragma_table_info('rhythm_account_state')").pluck().all() as string[];
  if (!cols.includes('recorded_intents_json')) {
    db.exec("ALTER TABLE rhythm_account_state ADD COLUMN recorded_intents_json TEXT NOT NULL DEFAULT '[]'");
  }
}

function parseRecordedIntents(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string' && value.length > 0);
  } catch {
    return [];
  }
}

export function resolveRhythmPreset(config: RhythmConfig): RhythmPreset | null {
  if (config.profile === 'off') return null;
  const base = RHYTHM_PRESETS[config.profile];
  const minIntervalMs = Math.max(0, Math.trunc(config.overrides?.minIntervalMs ?? base.minIntervalMs));
  const maxIntervalMs = Math.max(minIntervalMs, Math.trunc(config.overrides?.maxIntervalMs ?? base.maxIntervalMs));
  const burstWindowMs = Math.max(1_000, Math.trunc(config.overrides?.burstWindowMs ?? base.burstWindowMs));
  const burstMaxActions = Math.max(1, Math.trunc(config.overrides?.burstMaxActions ?? base.burstMaxActions));
  const cooloffMs = Math.max(1_000, Math.trunc(config.overrides?.cooloffMs ?? base.cooloffMs));
  return { minIntervalMs, maxIntervalMs, burstWindowMs, burstMaxActions, cooloffMs };
}

function parseWindowTimestamps(raw: string): number[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  } catch {
    return [];
  }
}

function pruneWindow(timestamps: number[], now: number, windowMs: number): number[] {
  const cutoff = now - windowMs;
  return timestamps.filter((ts) => ts > cutoff && ts <= now + 60_000);
}

function computeNextIntervalMs(preset: RhythmPreset, rng: () => number): number {
  const span = preset.maxIntervalMs - preset.minIntervalMs;
  if (span <= 0) return preset.minIntervalMs;
  const raw = rng();
  const unit = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.9999999999) : 0.5;
  return preset.minIntervalMs + Math.floor(unit * (span + 1));
}

function isValidProfile(value: string): value is RhythmProfile {
  return value === 'off' || value === 'calm' || value === 'natural' || value === 'active';
}

/**
 * SQLite 落盘持久化三档写动作节流阀（纯调度节流，绝不涉及任何指纹/轨迹模拟）。
 * 惰性建表 rhythm_account_state，不改动 automation_schema 版本号。
 * 所有状态读取均直接来自 SQLite，进程重启后冷却期与突发窗口计数完整保留。
 */
export class PersistentRhythmGate {
  private readonly now: () => number;
  private readonly rng: () => number;

  constructor(
    private readonly db: Database.Database,
    options: { now?: () => number; rng?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.rng = options.rng ?? Math.random;
  }

  /** 读取账号已持久化的节流档位；若从未配置返回 null（避免阻断未配置节流的既有测试） */
  getStoredProfile(accountId: AccountId, scope: RhythmScope = 'ALL'): RhythmProfile | null {
    if (!hasRhythmTable(this.db)) return null;
    const row = this.db
      .prepare('SELECT profile FROM rhythm_account_state WHERE account_id=? AND channel=?')
      .get(accountId, scope) as { profile: string } | undefined;
    if (!row || !isValidProfile(row.profile)) return null;
    return row.profile;
  }

  /** 显式持久化设置账号节流档位（例如生产开启 natural / calm / active 或测试关闭 off） */
  setAccountProfile(accountId: AccountId, profile: RhythmProfile, scope: RhythmScope = 'ALL'): void {
    const now = this.now();
    this.db
      .transaction(() => {
        ensureRhythmTable(this.db);
        this.db
          .prepare(
            `INSERT INTO rhythm_account_state (account_id, channel, profile, last_action_at, next_allowed_at, cooloff_until, window_timestamps_json, total_actions, cooloff_hits, updated_at)
             VALUES (?, ?, ?, 0, 0, 0, '[]', 0, 0, ?)
             ON CONFLICT(account_id, channel) DO UPDATE SET profile=excluded.profile, updated_at=excluded.updated_at`,
          )
          .run(accountId, scope, profile, now);
      })
      .immediate();
  }

  /** 只读检查节流状态（适用于 dryRun 与预检，绝不建表或写入 SQLite） */
  check(accountId: AccountId, config: RhythmConfig): RhythmDecision {
    const scope = config.scope ?? 'ALL';
    const now = this.now();
    const preset = resolveRhythmPreset(config);
    if (!preset) {
      return {
        allowed: true,
        reasonCode: 'RHYTHM_OFF',
        profile: 'off',
        scope,
        retryAfterMs: 0,
        nextAllowedAt: now,
        cooloffUntil: 0,
        windowCount: 0,
        burstMaxActions: 0,
        cooloffTriggered: false,
      };
    }
    const row = this.readRowReadOnly(accountId, scope);
    return this.evaluateRow(row, config.profile, scope, preset, now);
  }

  /**
   * 在线评估节流阀：若已达滑动窗口突发上限，则在 SQLite 事务中原子写入冷却截止时间（cooloff_until），
   * 确保进程重启后冷却依然生效。
   */
  evaluateOrTriggerCooloff(accountId: AccountId, config: RhythmConfig): RhythmDecision {
    const scope = config.scope ?? 'ALL';
    const preset = resolveRhythmPreset(config);
    const now = this.now();
    if (!preset) {
      return {
        allowed: true,
        reasonCode: 'RHYTHM_OFF',
        profile: 'off',
        scope,
        retryAfterMs: 0,
        nextAllowedAt: now,
        cooloffUntil: 0,
        windowCount: 0,
        burstMaxActions: 0,
        cooloffTriggered: false,
      };
    }

    return this.db
      .transaction(() => {
        // 先补记本账号窗口内因崩溃可能漏记的已落盘 send_intents（仅查本 account_id，不跨账号串扰）
        this.reconcileAccountIntentsInTx(accountId, scope, config.profile, preset, now);
        const row = this.readRowReadOnly(accountId, scope);
        const decision = this.evaluateRow(row, config.profile, scope, preset, now);
        if (decision.reasonCode === 'RHYTHM_BURST_LIMIT_REACHED') {
          ensureRhythmTable(this.db);
          const cooloffUntil = now + preset.cooloffMs;
          const activeWindow = pruneWindow(
            row ? parseWindowTimestamps(row.window_timestamps_json) : [],
            now,
            preset.burstWindowMs,
          );
          const recordedIntents = parseRecordedIntents(row?.recorded_intents_json);
          const nextAllowedAt = Math.max(row?.next_allowed_at ?? 0, cooloffUntil);
          this.db
            .prepare(
              `INSERT INTO rhythm_account_state (account_id, channel, profile, last_action_at, next_allowed_at, cooloff_until, window_timestamps_json, recorded_intents_json, total_actions, cooloff_hits, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
               ON CONFLICT(account_id, channel) DO UPDATE SET
                 profile=excluded.profile,
                 next_allowed_at=excluded.next_allowed_at,
                 cooloff_until=excluded.cooloff_until,
                 window_timestamps_json=excluded.window_timestamps_json,
                 recorded_intents_json=excluded.recorded_intents_json,
                 cooloff_hits=rhythm_account_state.cooloff_hits + 1,
                 updated_at=excluded.updated_at`,
            )
            .run(
              accountId,
              scope,
              config.profile,
              row?.last_action_at ?? 0,
              nextAllowedAt,
              cooloffUntil,
              JSON.stringify(activeWindow),
              JSON.stringify(recordedIntents),
              row?.total_actions ?? 0,
              now,
            );
          return {
            ...decision,
            cooloffUntil,
            nextAllowedAt,
            retryAfterMs: cooloffUntil - now,
            cooloffTriggered: true,
          };
        }
        return decision;
      })
      .immediate();
  }

  /**
   * 记录一笔真实写动作并持久化最新窗口计数与随机最小间隔。
   * 当传入 intentId 时严格按本账号 + intentId 幂等去重，重复调用不会重复计数。
   * 当 profile === 'off' 时不建表也不写库。
   */
  recordAction(
    accountId: AccountId,
    config: RhythmConfig,
    options: { intentId?: string; actionAtMs?: number } = {},
  ): RhythmStateSnapshot | null {
    const scope = config.scope ?? 'ALL';
    const preset = resolveRhythmPreset(config);
    if (!preset) return null;

    const now = options.actionAtMs ?? this.now();
    return this.db
      .transaction(() => {
        ensureRhythmTable(this.db);
        const row = this.readRowReadOnly(accountId, scope);
        const recordedIntents = parseRecordedIntents(row?.recorded_intents_json);
        if (options.intentId && recordedIntents.includes(options.intentId)) {
          return this.rowToSnapshot(row!, config.profile);
        }
        const pruned = pruneWindow(
          row ? parseWindowTimestamps(row.window_timestamps_json) : [],
          now,
          preset.burstWindowMs,
        );
        pruned.push(now);
        if (options.intentId) {
          recordedIntents.push(options.intentId);
        }
        const boundedIntents = recordedIntents.slice(-Math.max(50, preset.burstMaxActions * 4));
        const intervalMs = computeNextIntervalMs(preset, this.rng);
        let cooloffUntil = row && row.cooloff_until > now ? row.cooloff_until : 0;
        let cooloffHits = row?.cooloff_hits ?? 0;
        // 达到突发上限时同步持久化冷却期，进程重启后仍立即生效
        if (pruned.length >= preset.burstMaxActions) {
          cooloffUntil = Math.max(cooloffUntil, now + preset.cooloffMs);
          cooloffHits += 1;
        }
        const nextAllowedAt = Math.max(row?.next_allowed_at ?? 0, now + intervalMs, cooloffUntil);
        const totalActions = (row?.total_actions ?? 0) + 1;
        const lastActionAt = Math.max(row?.last_action_at ?? 0, now);

        this.db
          .prepare(
            `INSERT INTO rhythm_account_state (account_id, channel, profile, last_action_at, next_allowed_at, cooloff_until, window_timestamps_json, recorded_intents_json, total_actions, cooloff_hits, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id, channel) DO UPDATE SET
               profile=excluded.profile,
               last_action_at=excluded.last_action_at,
               next_allowed_at=excluded.next_allowed_at,
               cooloff_until=excluded.cooloff_until,
               window_timestamps_json=excluded.window_timestamps_json,
               recorded_intents_json=excluded.recorded_intents_json,
               total_actions=excluded.total_actions,
               cooloff_hits=excluded.cooloff_hits,
               updated_at=excluded.updated_at`,
          )
          .run(
            accountId,
            scope,
            config.profile,
            lastActionAt,
            nextAllowedAt,
            cooloffUntil,
            JSON.stringify(pruned),
            JSON.stringify(boundedIntents),
            totalActions,
            cooloffHits,
            now,
          );

        return {
          accountId,
          scope,
          profile: config.profile,
          lastActionAt,
          nextAllowedAt,
          cooloffUntil,
          windowTimestamps: pruned,
          totalActions,
          cooloffHits,
          updatedAt: now,
        };
      })
      .immediate();
  }

  private rowToSnapshot(row: RhythmRow, fallbackProfile: RhythmProfile): RhythmStateSnapshot {
    const profile: RhythmProfile = isValidProfile(row.profile) ? row.profile : fallbackProfile;
    return {
      accountId: row.account_id as AccountId,
      scope: row.channel as RhythmScope,
      profile,
      lastActionAt: row.last_action_at,
      nextAllowedAt: row.next_allowed_at,
      cooloffUntil: row.cooloff_until,
      windowTimestamps: parseWindowTimestamps(row.window_timestamps_json),
      totalActions: row.total_actions,
      cooloffHits: row.cooloff_hits,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 仅同步当前 accountId 在突发窗口内已提交但因崩溃尚未记入的自动策略意图，
   * 杜绝全库 send_intents 跨账号串扰并封堵意图落盘后崩溃漏记窗口。
   */
  private reconcileAccountIntentsInTx(
    accountId: AccountId,
    scope: RhythmScope,
    profile: RhythmProfile,
    preset: RhythmPreset,
    now: number,
  ): void {
    const hasIntents = Boolean(
      this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='send_intents'").get(),
    );
    const hasPolicyCommands = Boolean(
      this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='policy_commands'").get(),
    );
    if (!hasIntents || !hasPolicyCommands) return;

    const row = this.readRowReadOnly(accountId, scope);
    const recordedSet = new Set(parseRecordedIntents(row?.recorded_intents_json));
    const cutoffMs = now - preset.burstWindowMs;
    const channelFilter = scope === 'ALL' ? '' : 'AND e.channel=?';
    const args: unknown[] = scope === 'ALL' ? [accountId] : [accountId, scope];

    const recentIntents = this.db
      .prepare(
        `SELECT i.id, i.attempt_started_at FROM send_intents i
         JOIN inbound_events e ON e.id=i.event_id
         JOIN manual_send_commands c ON c.intent_id=i.id
         JOIN policy_commands p ON p.command_id=c.command_id
         WHERE e.account_id=? ${channelFilter}
         ORDER BY i.rowid DESC
         LIMIT ?`,
      )
      .all(...args, Math.max(20, preset.burstMaxActions * 2)) as { id: string; attempt_started_at: string }[];

    const missing = recentIntents
      .map((item) => ({ id: item.id, ts: Date.parse(item.attempt_started_at) }))
      .filter((item) => !recordedSet.has(item.id) && Number.isFinite(item.ts) && item.ts > cutoffMs && item.ts <= now + 60_000)
      .sort((a, b) => a.ts - b.ts);

    if (!missing.length) return;

    ensureRhythmTable(this.db);
    const pruned = pruneWindow(
      row ? parseWindowTimestamps(row.window_timestamps_json) : [],
      now,
      preset.burstWindowMs,
    );
    const recordedIntents = parseRecordedIntents(row?.recorded_intents_json);
    let lastActionAt = row?.last_action_at ?? 0;
    let nextAllowedAt = row?.next_allowed_at ?? 0;
    let cooloffUntil = row && row.cooloff_until > now ? row.cooloff_until : 0;
    let cooloffHits = row?.cooloff_hits ?? 0;
    let totalActions = row?.total_actions ?? 0;

    for (const item of missing) {
      pruned.push(item.ts);
      recordedIntents.push(item.id);
      totalActions += 1;
      lastActionAt = Math.max(lastActionAt, item.ts);
      const intervalMs = computeNextIntervalMs(preset, this.rng);
      if (pruned.length >= preset.burstMaxActions) {
        cooloffUntil = Math.max(cooloffUntil, item.ts + preset.cooloffMs);
        cooloffHits += 1;
      }
      nextAllowedAt = Math.max(nextAllowedAt, item.ts + intervalMs, cooloffUntil);
    }

    const boundedIntents = recordedIntents.slice(-Math.max(50, preset.burstMaxActions * 4));
    this.db
      .prepare(
        `INSERT INTO rhythm_account_state (account_id, channel, profile, last_action_at, next_allowed_at, cooloff_until, window_timestamps_json, recorded_intents_json, total_actions, cooloff_hits, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, channel) DO UPDATE SET
           profile=excluded.profile,
           last_action_at=excluded.last_action_at,
           next_allowed_at=excluded.next_allowed_at,
           cooloff_until=excluded.cooloff_until,
           window_timestamps_json=excluded.window_timestamps_json,
           recorded_intents_json=excluded.recorded_intents_json,
           total_actions=excluded.total_actions,
           cooloff_hits=excluded.cooloff_hits,
           updated_at=excluded.updated_at`,
      )
      .run(
        accountId,
        scope,
        profile,
        lastActionAt,
        nextAllowedAt,
        cooloffUntil,
        JSON.stringify(pruned),
        JSON.stringify(boundedIntents),
        totalActions,
        cooloffHits,
        now,
      );
  }

  /** 只读查询当前账号节流状态快照（表不存在则返回 null） */
  inspectState(accountId: AccountId, scope: RhythmScope = 'ALL'): RhythmStateSnapshot | null {
    const row = this.readRowReadOnly(accountId, scope);
    if (!row) return null;
    const profile: RhythmProfile = isValidProfile(row.profile) ? row.profile : 'natural';
    return {
      accountId: row.account_id as AccountId,
      scope: row.channel as RhythmScope,
      profile,
      lastActionAt: row.last_action_at,
      nextAllowedAt: row.next_allowed_at,
      cooloffUntil: row.cooloff_until,
      windowTimestamps: parseWindowTimestamps(row.window_timestamps_json),
      totalActions: row.total_actions,
      cooloffHits: row.cooloff_hits,
      updatedAt: row.updated_at,
    };
  }

  private readRowReadOnly(accountId: AccountId, scope: RhythmScope): RhythmRow | undefined {
    if (!hasRhythmTable(this.db)) return undefined;
    return this.db
      .prepare('SELECT * FROM rhythm_account_state WHERE account_id=? AND channel=?')
      .get(accountId, scope) as RhythmRow | undefined;
  }

  private evaluateRow(
    row: RhythmRow | undefined,
    profile: RhythmProfile,
    scope: RhythmScope,
    preset: RhythmPreset,
    now: number,
  ): RhythmDecision {
    const activeWindow = pruneWindow(
      row ? parseWindowTimestamps(row.window_timestamps_json) : [],
      now,
      preset.burstWindowMs,
    );
    const cooloffUntil = row?.cooloff_until ?? 0;
    const nextAllowedAt = row?.next_allowed_at ?? 0;

    if (cooloffUntil > now) {
      return {
        allowed: false,
        reasonCode: 'RHYTHM_COOLOFF_ACTIVE',
        profile,
        scope,
        retryAfterMs: cooloffUntil - now,
        nextAllowedAt: Math.max(nextAllowedAt, cooloffUntil),
        cooloffUntil,
        windowCount: activeWindow.length,
        burstMaxActions: preset.burstMaxActions,
        cooloffTriggered: false,
      };
    }

    if (activeWindow.length >= preset.burstMaxActions) {
      return {
        allowed: false,
        reasonCode: 'RHYTHM_BURST_LIMIT_REACHED',
        profile,
        scope,
        retryAfterMs: preset.cooloffMs,
        nextAllowedAt: now + preset.cooloffMs,
        cooloffUntil: now + preset.cooloffMs,
        windowCount: activeWindow.length,
        burstMaxActions: preset.burstMaxActions,
        cooloffTriggered: false,
      };
    }

    if (nextAllowedAt > now) {
      return {
        allowed: false,
        reasonCode: 'RHYTHM_MIN_INTERVAL_WAIT',
        profile,
        scope,
        retryAfterMs: nextAllowedAt - now,
        nextAllowedAt,
        cooloffUntil: 0,
        windowCount: activeWindow.length,
        burstMaxActions: preset.burstMaxActions,
        cooloffTriggered: false,
      };
    }

    return {
      allowed: true,
      reasonCode: 'RHYTHM_ALLOWED',
      profile,
      scope,
      retryAfterMs: 0,
      nextAllowedAt: now,
      cooloffUntil: 0,
      windowCount: activeWindow.length,
      burstMaxActions: preset.burstMaxActions,
      cooloffTriggered: false,
    };
  }
}
