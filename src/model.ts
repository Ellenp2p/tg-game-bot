import { z } from 'zod';

export const SUPPORTED_DICE_EMOJIS = ['🎲', '🎯', '🏀', '⚽', '🎰', '🎳'] as const;
export type DiceEmoji = typeof SUPPORTED_DICE_EMOJIS[number];

export const DICE_EMOJI_MAX_VALUE: Record<DiceEmoji, number> = {
  '🎲': 6, '🎯': 6, '🏀': 5, '⚽': 5, '🎰': 64, '🎳': 6
};

export const choiceGoto = z.union([
  z.literal('next'),
  z.literal('end'),
  z.object({ roundIdx: z.number().int().min(0), stepIdx: z.number().int().min(0) })
]);
export type ChoiceGoto = z.infer<typeof choiceGoto>;

export const choiceOption = z.object({
  text: z.string().min(1).max(80),
  goto: choiceGoto
});
export type ChoiceOption = z.infer<typeof choiceOption>;

/** 结果槽名：小写字母开头，可含数字/下划线，最长 20 */
export const slotName = z.string().regex(/^[a-z][a-z0-9_]{0,19}$/, '结果槽名需匹配 [a-z][a-z0-9_]{0,19}');

/** 比较运算符 */
export const compareOp = z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'ne']);
export type CompareOp = z.infer<typeof compareOp>;

/** branch 的条件词表 */
export const branchCondition = z.discriminatedUnion('check', [
  z.object({ slot: slotName.optional(), check: z.literal('tie') }),
  z.object({ slot: slotName.optional(), check: z.literal('unique') }),
  z.object({ slot: slotName.optional(), check: z.literal('any'), value: z.number().int() }),
  z.object({ slot: slotName.optional(), check: z.literal('all'), value: z.number().int() }),
  z.object({
    slot: slotName.optional(), check: z.literal('rank'),
    pick: z.number().int().refine(n => n !== 0, { message: 'pick 不能为 0' }),
    op: compareOp, value: z.number()
  }),
  z.object({ slot: slotName.optional(), check: z.literal('sum'), op: compareOp, value: z.number() }),
  z.object({ slot: slotName.optional(), check: z.literal('count'), op: compareOp, value: z.number() }),
  // 最近一次单掷 roll 的点数（state.lastDice.value）
  z.object({ check: z.literal('dice'), op: compareOp, value: z.number() })
]);
export type BranchCondition = z.infer<typeof branchCondition>;

/** 条件字符串糖：'tie' / 'unique' */
export const branchConditionInput = z.union([
  z.enum(['tie', 'unique']),
  branchCondition
]);
export type BranchConditionInput = z.infer<typeof branchConditionInput>;

export const branchCase = z.object({
  if: branchConditionInput,
  goto: choiceGoto
});
export type BranchCase = z.infer<typeof branchCase>;

/**
 * roll 的抽签配置：掷完骰子后按点数落到 1..count 号，再 goto 到 targets[bucket-1]。
 * uniform: 'equal' 等距分段（偏差 ≤ 1/上限）；'exact' 拒绝重掷（超出整数倍范围就重抽）。
 */
export const drawConfig = z.object({
  count: z.number().int().min(2).max(64),
  targets: z.array(choiceGoto).min(2).max(64),
  store: slotName.optional(),
  uniform: z.enum(['equal', 'exact']).default('equal')
}).refine(d => d.targets.length === d.count, {
  message: 'draw.targets 长度必须等于 draw.count',
  path: ['targets']
});
export type DrawConfig = z.infer<typeof drawConfig>;

export const step = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('roll'),
    label: z.string().min(1).max(200),
    emoji: z.enum(SUPPORTED_DICE_EMOJIS).optional(),
    assignment: z.enum(['next_player', 'self', 'any', 'winner', 'loser', 'actor']).default('next_player'),
    actorSlot: slotName.optional(),
    draw: drawConfig.optional()
  }),
  z.object({
    type: z.literal('text'),
    label: z.string().min(1).max(200),
    prompt: z.string().min(1).max(1000).optional(),
    mode: z.enum(['manual', 'auto']).default('manual'),
    showActor: z.boolean().default(false),
    next: choiceGoto.optional()
  }),
  z.object({
    type: z.literal('punish'),
    label: z.string().min(1).max(200),
    ladder: z.array(z.object({ at: z.number().int().min(1).max(1000), text: z.string().min(1).max(500) })).default([]),
    defaultText: z.string().min(1).max(500),
    showActor: z.boolean().default(false),
    next: choiceGoto.optional()
  }),
  z.object({
    type: z.literal('choice'),
    label: z.string().min(1).max(200),
    prompt: z.string().max(500).optional(),
    options: z.array(choiceOption).min(2).max(6),
    chooser: z.enum(['last_roller', 'winner', 'loser', 'actor', 'any']).default('last_roller'),
    chooserSlot: slotName.optional()
  }),
  z.object({
    type: z.literal('showdown'),
    label: z.string().min(1).max(200),
    emoji: z.enum(SUPPORTED_DICE_EMOJIS).optional(),
    order: z.enum(['high', 'low', 'none']).default('high'),
    tie: z.enum(['keep', 'first', 'reroll']).default('keep'),
    as: slotName.optional(),
    accumulate: z.boolean().default(false),
    actor: z.enum(['winner', 'loser', 'none']).default('none')
  }),
  z.object({
    type: z.literal('branch'),
    label: z.string().min(1).max(200),
    cases: z.array(branchCase).min(1).max(64),
    default: choiceGoto.default('next'),
    maxHits: z.number().int().min(1).max(200).default(50)
  })
]);
export type Step = z.infer<typeof step>;
export type ShowdownStep = Extract<Step, { type: 'showdown' }>;
export type BranchStep = Extract<Step, { type: 'branch' }>;
export type RollStep = Extract<Step, { type: 'roll' }>;

export const round = z.object({
  name: z.string().min(1).max(80),
  loop: z.boolean().default(false),
  maxLoops: z.number().int().min(1).max(100).optional(),
  defaultEmoji: z.enum(SUPPORTED_DICE_EMOJIS).optional(),
  steps: z.array(step).min(1).max(80)
});
export type Round = z.infer<typeof round>;

export const CURRENT_RULE_SCHEMA_VERSION = '1.8.0';

export const ruleDefinition = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/).default(CURRENT_RULE_SCHEMA_VERSION),
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  minPlayers: z.number().int().min(1).max(100).default(2),
  maxPlayers: z.number().int().min(1).max(100).default(8),
  defaultEmoji: z.enum(SUPPORTED_DICE_EMOJIS).optional(),
  rounds: z.array(round).min(1).max(20)
}).refine(d => d.minPlayers <= d.maxPlayers, {
  message: 'minPlayers 必须 ≤ maxPlayers',
  path: ['minPlayers']
});
export type RuleDefinition = z.infer<typeof ruleDefinition>;

export function resolveRollEmoji(def: RuleDefinition, round: Round, step: Extract<Step, { type: 'roll' }>): DiceEmoji {
  return step.emoji ?? round.defaultEmoji ?? def.defaultEmoji ?? '🎲';
}

export function resolveShowdownEmoji(def: RuleDefinition, round: Round, step: ShowdownStep): DiceEmoji {
  return step.emoji ?? round.defaultEmoji ?? def.defaultEmoji ?? '🎲';
}

export type SlotSymbol = 'bar' | 'berries' | 'lemon' | 'seven';
export const SLOT_SYMBOLS: readonly SlotSymbol[] = ['bar', 'berries', 'lemon', 'seven'];
export const SLOT_SYMBOL_LABEL: Record<SlotSymbol, string> = {
  bar: 'BAR',
  berries: '🍓',
  lemon: '🍋',
  seven: '7'
};

export type SlotDecoded = {
  r1: SlotSymbol;
  r2: SlotSymbol;
  r3: SlotSymbol;
  jackpot: boolean;
};

export function decodeSlotValue(value: number): SlotDecoded {
  const v = Math.max(1, Math.min(64, Math.floor(value)));
  const r1 = SLOT_SYMBOLS[Math.floor((v - 1) / 16)] ?? 'bar';
  const r2 = SLOT_SYMBOLS[Math.floor(((v - 1) % 16) / 4)] ?? 'bar';
  const r3 = SLOT_SYMBOLS[(v - 1) % 4] ?? 'bar';
  return { r1, r2, r3, jackpot: r1 === r2 && r2 === r3 };
}

export function isJackpot(value: number): boolean {
  return value === 1 || value === 22 || value === 43 || value === 64;
}

export type RuleRecord = {
  ruleId: string;
  userId: number;
  name: string;
  definition: RuleDefinition;
  createdAt: number;
  updatedAt: number;
};

export type GameStatus = 'signup' | 'in_progress' | 'ended';

export type GamePlayer = {
  userId: number;
  joinedAt: number;
};

/** showdown 单次收集记录 */
export type ShowdownRoll = { userId: number; value: number; at: number };

export type ShowdownOrder = 'high' | 'low' | 'none';
export type ShowdownTie = 'keep' | 'first' | 'reroll';

/** showdown 结算结果（存在命名结果槽里） */
export type ShowdownResult = {
  order: ShowdownOrder;
  /** userId -> 本次值（accumulate 时为累计总分） */
  totals: Record<string, number>;
  /** 按 order 排好序的排名 */
  ranking: { userId: number; value: number }[];
  winners: number[];
  losers: number[];
  sum: number;
  max: number;
  min: number;
};

/** 尚未揭晓的骰子（按 userId 索引，支持多人并发） */
export type PendingRoll = {
  userId: number;
  value: number;
  chatId: number;
  waitingMsgId: number;
  emoji: DiceEmoji;
  kind: 'roll' | 'showdown';
  roundIdx: number;
  stepIdx: number;
};

export type GamePhase =
  | { kind: 'signup' }
  | { kind: 'roll'; stepIdx: number; expectedPlayerId: number | null; roundIdx: number; emoji: DiceEmoji }
  | { kind: 'text'; stepIdx: number; roundIdx: number; text: string }
  | { kind: 'punish'; stepIdx: number; roundIdx: number; text: string; hitCount: number }
  | { kind: 'choice'; stepIdx: number; roundIdx: number; options: ChoiceOption[]; pickedBy: number | null }
  | {
      kind: 'showdown'; stepIdx: number; roundIdx: number;
      emoji: DiceEmoji; order: ShowdownOrder; tie: ShowdownTie; slot: string; rolls: ShowdownRoll[];
    };

export type GameState = {
  phase: GamePhase;
  stepHitCounts: Record<string, number>;
  loopCounters: Record<string, number>;
  lastRollerId?: number;
  lastDice?: { userId: number; value: number; at: number; emoji: DiceEmoji };
  lastMessage?: string;
  /** 未揭晓的骰子，按 userId -> pending */
  pendingRolls?: Record<string, PendingRoll>;
  /** 命名结果槽 */
  results?: Record<string, ShowdownResult>;
  /** 最近一次写入的结果槽名 */
  lastResultSlot?: string;
  /** 当前主角 */
  activeActorId?: number;
  /** showdown 看板消息 id（编辑同一条，避免刷屏） */
  showdownBoardMsgId?: number;
  /** roll.draw 命中的编号（命名槽） */
  draws?: Record<string, number>;
  /** 最近一次 roll.draw 命中的编号 */
  lastDraw?: number;
};

export type GameRecord = {
  gameId: string;
  chatId: number;
  ruleId: string;
  starterId: number;
  status: GameStatus;
  state: GameState;
  roundIdx: number;
  stepIdx: number;
  createdAt: number;
  endedAt: number | null;
  signupMsgId: number | null;
};

export type GameEventType =
  | 'create' | 'join' | 'leave' | 'begin'
  | 'roll' | 'showdown' | 'text' | 'punish' | 'choice' | 'branch'
  | 'next' | 'undo' | 'skip' | 'end' | 'replace';

export type GameEventRecord = {
  eventId: number;
  gameId: string;
  userId: number;
  type: GameEventType;
  payload: Record<string, unknown>;
  createdAt: number;
};

export type UserRecord = {
  userId: number;
  createdAt: number;
  lastSeenAt: number;
};
