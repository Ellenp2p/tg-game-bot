import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  RuleRecord, GameRecord, GamePlayer, GameEventRecord, GameEventType,
  UserRecord, RuleDefinition, GameState, UserId
} from '@tg-game/engine';

export function id8(): string {
  return randomBytes(4).toString('hex');
}

export class Db {
  private conn: Database.Database;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.conn = new Database(file);
    this.conn.pragma('journal_mode = WAL');
    this.conn.pragma('foreign_keys = ON');
    this.init();
    this.migrate();
  }
  private migrate(): void {
    const cols = this.conn.prepare("PRAGMA table_info(games)").all() as Array<{ name: string }>;
    const have = new Set(cols.map(c => c.name));
    if (!have.has('signup_msg_id')) {
      this.conn.exec('ALTER TABLE games ADD COLUMN signup_msg_id INTEGER');
      this.conn.exec('CREATE INDEX IF NOT EXISTS idx_games_signup_msg ON games(signup_msg_id)');
    }
  }
  private init(): void {
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_rules (
        rule_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        definition TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_user_rules_user ON user_rules(user_id);

      CREATE TABLE IF NOT EXISTS games (
        game_id TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        rule_id TEXT NOT NULL,
        starter_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        state TEXT NOT NULL,
        round_idx INTEGER NOT NULL,
        step_idx INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        ended_at INTEGER,
        signup_msg_id INTEGER,
        FOREIGN KEY (rule_id) REFERENCES user_rules(rule_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_games_chat_active ON games(chat_id, status);

      CREATE TABLE IF NOT EXISTS game_players (
        game_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (game_id, user_id),
        FOREIGN KEY (game_id) REFERENCES games(game_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS game_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (game_id) REFERENCES games(game_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_events_game ON game_events(game_id, event_id);
    `);
  }

  touchUser(userId: UserId): UserRecord {
    const now = Date.now();
    const row = this.conn.prepare('SELECT * FROM users WHERE user_id = ?').get(userId) as
      { user_id: number | string; created_at: number } | undefined;
    if (row) {
      this.conn.prepare('UPDATE users SET last_seen_at = ? WHERE user_id = ?').run(now, userId);
      return { userId: String(row.user_id), createdAt: row.created_at, lastSeenAt: now };
    }
    this.conn.prepare('INSERT INTO users (user_id, created_at, last_seen_at) VALUES (?, ?, ?)').run(userId, now, now);
    return { userId, createdAt: now, lastSeenAt: now };
  }

  getUser(userId: UserId): UserRecord | undefined {
    const row = this.conn.prepare('SELECT * FROM users WHERE user_id = ?').get(userId) as
      { user_id: number | string; created_at: number; last_seen_at: number } | undefined;
    return row ? { userId: String(row.user_id), createdAt: row.created_at, lastSeenAt: row.last_seen_at } : undefined;
  }

  listRules(userId: UserId): RuleRecord[] {
    const rows = this.conn.prepare(`
      SELECT rule_id, user_id, name, definition, created_at, updated_at
      FROM user_rules WHERE user_id = ? ORDER BY created_at DESC
    `).all(userId) as Array<{
      rule_id: string; user_id: number | string; name: string; definition: string;
      created_at: number; updated_at: number;
    }>;
    return rows.map(r => ({
      ruleId: r.rule_id,
      userId: String(r.user_id),
      name: r.name,
      definition: JSON.parse(r.definition) as RuleDefinition,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));
  }

  getRule(ruleId: string): RuleRecord | undefined {
    return this.getRuleByUser(ruleId, undefined);
  }

  getRuleByUser(ruleId: string, userId: UserId | undefined): RuleRecord | undefined {
    const row = (userId !== undefined
      ? this.conn.prepare('SELECT * FROM user_rules WHERE rule_id = ? AND user_id = ?').get(ruleId, userId)
      : this.conn.prepare('SELECT * FROM user_rules WHERE rule_id = ?').get(ruleId)) as
      { rule_id: string; user_id: number | string; name: string; definition: string; created_at: number; updated_at: number } | undefined;
    if (!row) return undefined;
    return {
      ruleId: row.rule_id, userId: String(row.user_id), name: row.name,
      definition: JSON.parse(row.definition) as RuleDefinition,
      createdAt: row.created_at, updatedAt: row.updated_at
    };
  }

  createRule(userId: UserId, name: string, definition: RuleDefinition): RuleRecord {
    const now = Date.now();
    const ruleId = id8();
    this.conn.prepare(`
      INSERT INTO user_rules (rule_id, user_id, name, definition, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(ruleId, userId, name, JSON.stringify(definition), now, now);
    return { ruleId, userId, name, definition, createdAt: now, updatedAt: now };
  }

  updateRule(ruleId: string, userId: UserId, name: string, definition: RuleDefinition): RuleRecord | undefined {
    const now = Date.now();
    const result = this.conn.prepare(`
      UPDATE user_rules SET name = ?, definition = ?, updated_at = ?
      WHERE rule_id = ? AND user_id = ?
    `).run(name, JSON.stringify(definition), now, ruleId, userId);
    if (result.changes === 0) return undefined;
    return this.getRuleByUser(ruleId, userId);
  }

  deleteRule(ruleId: string, userId: UserId): boolean {
    const result = this.conn.prepare('DELETE FROM user_rules WHERE rule_id = ? AND user_id = ?').run(ruleId, userId);
    return result.changes > 0;
  }

  createGame(chatId: number, ruleId: string, starterId: UserId): GameRecord {
    const now = Date.now();
    const gameId = id8();
    const initialState: GameState = {
      phase: { kind: 'signup' },
      stepHitCounts: {},
      loopCounters: {}
    };
    this.conn.prepare(`
      INSERT INTO games (game_id, chat_id, rule_id, starter_id, status, state, round_idx, step_idx, created_at, ended_at, signup_msg_id)
      VALUES (?, ?, ?, ?, 'signup', ?, 0, 0, ?, NULL, NULL)
    `).run(gameId, chatId, ruleId, starterId, JSON.stringify(initialState), now);
    this.recordEvent(gameId, starterId, 'create', {});
    return this.getGame(gameId)!;
  }

  getGame(gameId: string): GameRecord | undefined {
    const row = this.conn.prepare('SELECT * FROM games WHERE game_id = ?').get(gameId) as
      { game_id: string; chat_id: number; rule_id: string; starter_id: number | string; status: string;
        state: string; round_idx: number; step_idx: number; created_at: number; ended_at: number | null;
        signup_msg_id: number | null } | undefined;
    if (!row) return undefined;
    return this.parseGame(row);
  }

  getActiveGameByChat(chatId: number): GameRecord | undefined {
    const row = this.conn.prepare(`
      SELECT * FROM games WHERE chat_id = ? AND status != 'ended'
      ORDER BY created_at DESC LIMIT 1
    `).get(chatId) as
      { game_id: string; chat_id: number; rule_id: string; starter_id: number | string; status: string;
        state: string; round_idx: number; step_idx: number; created_at: number; ended_at: number | null;
        signup_msg_id: number | null } | undefined;
    return row ? this.parseGame(row) : undefined;
  }

  listGamesByChat(chatId: number): GameRecord[] {
    const rows = this.conn.prepare(`
      SELECT * FROM games WHERE chat_id = ? ORDER BY created_at DESC LIMIT 10
    `).all(chatId) as Array<{
      game_id: string; chat_id: number; rule_id: string; starter_id: number | string; status: string;
      state: string; round_idx: number; step_idx: number; created_at: number; ended_at: number | null;
      signup_msg_id: number | null;
    }>;
    return rows.map(r => this.parseGame(r));
  }

  private parseGame(row: {
    game_id: string; chat_id: number; rule_id: string; starter_id: number | string; status: string;
    state: string; round_idx: number; step_idx: number; created_at: number; ended_at: number | null;
    signup_msg_id: number | null;
  }): GameRecord {
    return {
      gameId: row.game_id,
      chatId: row.chat_id,
      ruleId: row.rule_id,
      starterId: String(row.starter_id),
      status: row.status as GameRecord['status'],
      state: JSON.parse(row.state) as GameState,
      roundIdx: row.round_idx,
      stepIdx: row.step_idx,
      createdAt: row.created_at,
      endedAt: row.ended_at,
      signupMsgId: row.signup_msg_id
    };
  }

  updateGame(game: GameRecord): void {
    this.conn.prepare(`
      UPDATE games SET status = ?, state = ?, round_idx = ?, step_idx = ?, ended_at = ?, signup_msg_id = ?
      WHERE game_id = ?
    `).run(game.status, JSON.stringify(game.state), game.roundIdx, game.stepIdx, game.endedAt, game.signupMsgId, game.gameId);
  }

  setSignupMsgId(gameId: string, msgId: number): void {
    this.conn.prepare('UPDATE games SET signup_msg_id = ? WHERE game_id = ?').run(msgId, gameId);
  }

  listPlayers(gameId: string): GamePlayer[] {
    const rows = this.conn.prepare(`
      SELECT user_id, joined_at FROM game_players WHERE game_id = ? ORDER BY joined_at ASC
    `).all(gameId) as Array<{ user_id: number | string; joined_at: number }>;
    return rows.map(r => ({ userId: String(r.user_id), joinedAt: r.joined_at }));
  }

  addPlayer(gameId: string, userId: UserId): boolean {
    try {
      this.conn.prepare('INSERT INTO game_players (game_id, user_id, joined_at) VALUES (?, ?, ?)')
        .run(gameId, userId, Date.now());
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return false;
      throw e;
    }
  }

  removePlayer(gameId: string, userId: UserId): boolean {
    const r = this.conn.prepare('DELETE FROM game_players WHERE game_id = ? AND user_id = ?').run(gameId, userId);
    return r.changes > 0;
  }

  recordEvent(gameId: string, userId: UserId, type: GameEventType, payload: Record<string, unknown>): GameEventRecord {
    const now = Date.now();
    const info = this.conn.prepare(`
      INSERT INTO game_events (game_id, user_id, type, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(gameId, userId, type, JSON.stringify(payload), now);
    return {
      eventId: Number(info.lastInsertRowid), gameId, userId, type, payload, createdAt: now
    };
  }

  listEvents(gameId: string): GameEventRecord[] {
    const rows = this.conn.prepare(`
      SELECT event_id, game_id, user_id, type, payload, created_at
      FROM game_events WHERE game_id = ? ORDER BY event_id ASC
    `).all(gameId) as Array<{
      event_id: number; game_id: string; user_id: number | string; type: string; payload: string; created_at: number;
    }>;
    return rows.map(r => ({
      eventId: r.event_id, gameId: r.game_id, userId: String(r.user_id),
      type: r.type as GameEventType, payload: JSON.parse(r.payload) as Record<string, unknown>,
      createdAt: r.created_at
    }));
  }

  lastEvent(gameId: string): GameEventRecord | undefined {
    return this.listEvents(gameId).at(-1);
  }

  close(): void { this.conn.close(); }
}
