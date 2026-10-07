import { z } from 'zod';

export const SUPPORTED_DICE_EMOJIS = ['🎲', '🎯', '🏀', '⚽', '🎰', '🎳'] as const;
export type DiceEmoji = typeof SUPPORTED_DICE_EMOJIS[number];

export const DICE_EMOJI_MAX_VALUE: Record<DiceEmoji, number> = {
  '🎲': 6, '🎯': 6, '🏀': 5, '⚽': 5, '🎰': 64, '🎳': 6
};

export const choiceGoto = z.union([
  z.literal('next'),
  z.object({ roundIdx: z.number().int().min(0), stepIdx: z.number().int().min(0) })
]);
export type ChoiceGoto = z.infer<typeof choiceGoto>;

export const choiceOption = z.object({
  text: z.string().min(1).max(80),
  goto: choiceGoto
});
export type ChoiceOption = z.infer<typeof choiceOption>;

export const step = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('roll'),
    label: z.string().min(1).max(200),
    emoji: z.enum(SUPPORTED_DICE_EMOJIS).optional(),
    assignment: z.enum(['next_player', 'self', 'any']).default('next_player')
  }),
  z.object({
    type: z.literal('text'),
    label: z.string().min(1).max(200),
    prompt: z.string().min(1).max(1000).optional(),
    mode: z.enum(['manual', 'auto']).default('manual')
  }),
  z.object({
    type: z.literal('punish'),
    label: z.string().min(1).max(200),
    ladder: z.array(z.object({ at: z.number().int().min(1).max(1000), text: z.string().min(1).max(500) })).default([]),
    defaultText: z.string().min(1).max(500)
  }),
  z.object({
    type: z.literal('choice'),
    label: z.string().min(1).max(200),
    prompt: z.string().max(500).optional(),
    options: z.array(choiceOption).min(2).max(6)
  })
]);
export type Step = z.infer<typeof step>;

export const round = z.object({
  name: z.string().min(1).max(80),
  loop: z.boolean().default(false),
  maxLoops: z.number().int().min(1).max(100).optional(),
  defaultEmoji: z.enum(SUPPORTED_DICE_EMOJIS).optional(),
  steps: z.array(step).min(1).max(40)
});
export type Round = z.infer<typeof round>;

export const CURRENT_RULE_SCHEMA_VERSION = '1.5.0';

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

export type GamePhase =
  | { kind: 'signup' }
  | { kind: 'roll'; stepIdx: number; expectedPlayerId: number | null; roundIdx: number; emoji: DiceEmoji }
  | { kind: 'text'; stepIdx: number; roundIdx: number; text: string }
  | { kind: 'punish'; stepIdx: number; roundIdx: number; text: string; hitCount: number }
  | { kind: 'choice'; stepIdx: number; roundIdx: number; options: ChoiceOption[]; pickedBy: number | null };

export type GameState = {
  phase: GamePhase;
  stepHitCounts: Record<string, number>;
  loopCounters: Record<string, number>;
  lastRollerId?: number;
  lastDice?: { userId: number; value: number; at: number; emoji: DiceEmoji };
  lastMessage?: string;
  pendingRoll?: { userId: number; value: number; chatId: number; waitingMsgId: number; emoji: DiceEmoji };
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
  | 'roll' | 'text' | 'punish' | 'choice'
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
