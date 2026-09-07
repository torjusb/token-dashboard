import type { UsageEvent } from '../shared/types.ts';

export type Rate = {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
};

const perMTok = (usd: number): number => usd / 1_000_000;

function rateFor(input: number, output: number): Rate {
  return {
    input: perMTok(input),
    output: perMTok(output),
    cacheWrite5m: perMTok(input * 1.25),
    cacheWrite1h: perMTok(input * 2),
    cacheRead: perMTok(input * 0.1),
  };
}

/**
 * $/MTok from the claude-api skill's pricing table (cached 2026-06-24).
 * Cache multipliers (write 1.25x/2x, read 0.1x of input) are the skill's documented
 * ratios, not model-specific rates - none of these models publish a different one.
 * Opus 5 and Opus 4.8 explicitly price their 1M-token context at standard rates with
 * no long-context premium tier, so none is applied here.
 *
 * Confirmed against ground truth, not just the docs. `cost-state` lines carry
 * `modelUsage[model]` with both the token counts and Claude Code's own `costUSD`. Re-pricing
 * those counts with this table reproduces `costUSD` to floating point (worst relative error
 * 5.4e-14 over the 107 model-rows whose cache writes are all one TTL, so the lumped
 * `cacheCreationInputTokens` is unambiguous) - including a 9-request session in which every
 * request carried more than 200k input-side tokens. There is no long-context premium and no
 * threshold: `claude-opus-5[1m]`, the name `cost-state` uses for the 1M-context variant,
 * prices identically to plain `claude-opus-5`. Do not add a premium tier here.
 *
 * The validator's residual COST gap is therefore not a pricing error. It is requests that
 * Claude Code billed and counted in `modelUsage` but never wrote to any transcript line
 * (`type:"assistant"` or otherwise), so no `UsageEvent` exists to price.
 */
export const PRICING: Record<string, Rate> = {
  'claude-fable-5': rateFor(10, 50),
  'claude-opus-5': rateFor(5, 25),
  'claude-opus-4-8': rateFor(5, 25),
  'claude-sonnet-5': rateFor(2, 10),
  'claude-haiku-4-5': rateFor(1, 5),
};

const SYNTHETIC_MODEL = '<synthetic>';

const prefixes = Object.keys(PRICING).sort((a, b) => b.length - a.length);

function rateForModel(model: string): Rate | null {
  for (const prefix of prefixes) {
    if (model.startsWith(prefix)) return PRICING[prefix]!;
  }
  return null;
}

export function isPricedModel(model: string): boolean {
  return model === SYNTHETIC_MODEL || rateForModel(model) !== null;
}

const unknownModelIds = new Set<string>();

function priceEvent(e: Omit<UsageEvent, 'cost'>, cacheReadRate: (rate: Rate) => number): number {
  if (e.model === SYNTHETIC_MODEL) return 0;

  const rate = rateForModel(e.model);
  if (!rate) {
    unknownModelIds.add(e.model);
    return 0;
  }

  return (
    e.input * rate.input +
    e.output * rate.output +
    e.cacheRead * cacheReadRate(rate) +
    e.cacheWrite5m * rate.cacheWrite5m +
    e.cacheWrite1h * rate.cacheWrite1h +
    e.webSearch * WEB_SEARCH_USD
  );
}

/**
 * Server-side tool use is billed per call on top of tokens, and it is model-independent.
 * Confirmed against ground truth: six `cost-state` rows priced short by exactly $0.01 per
 * `webSearchRequests`, matching 1, 2, 3, 3, 9 and 3 searches to the cent. Web fetch carries
 * no separate charge in that data, so it stays unpriced rather than guessed.
 */
export const WEB_SEARCH_USD = 0.01;

export function costOf(e: Omit<UsageEvent, 'cost'>): number {
  return priceEvent(e, (rate) => rate.cacheRead);
}

export function uncachedCostOf(e: Omit<UsageEvent, 'cost'>): number {
  return priceEvent(e, (rate) => rate.input);
}

export function unknownModels(): string[] {
  return [...unknownModelIds];
}
