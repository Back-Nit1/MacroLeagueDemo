import { supabase } from '../lib/supabase';

/**
 * The user-facing toggles/thresholds parsed out of a rule set's `rules` JSON.
 * These mirror the modules the award trigger (migration 0006) evaluates, so
 * enabling/disabling one here changes what scores future meals. Award amounts
 * (points/xp/leaderboard) are intentionally NOT exposed in Phase 1.
 */
export interface RuleModules {
  mealCountEnabled: boolean;
  mealCountRequired: number;
  proteinGoalEnabled: boolean;
  proteinMinPct: number;
  macroAccuracyEnabled: boolean;
  streakEnabled: boolean;
}

export interface ActiveRuleSet {
  id: string;
  name: string;
  scope: string;
  durationDays: number;
  /** Raw config; preserved on save so award amounts/bands are never lost. */
  rules: Record<string, any>;
  /** True when this is the caller's OWN rule set (vs. the shared system default). */
  isOwn: boolean;
  modules: RuleModules;
}

type RuleSetRow = {
  id: string;
  owner_user_id: string | null;
  scope: string;
  name: string;
  duration_days: number;
  rules: Record<string, any>;
};

function parseModules(rules: Record<string, any>): RuleModules {
  return {
    mealCountEnabled: rules?.meal_count?.enabled ?? false,
    mealCountRequired: rules?.meal_count?.required ?? 3,
    proteinGoalEnabled: rules?.protein_goal?.enabled ?? false,
    proteinMinPct: rules?.protein_goal?.min_pct ?? 100,
    macroAccuracyEnabled: rules?.macro_accuracy?.enabled ?? false,
    streakEnabled: rules?.streak?.enabled ?? false,
  };
}

/**
 * Loads the rule set the award engine will actually use for this user: their own
 * default if they have one, otherwise the shared system default. RLS ("read system
 * and own rule sets") permits exactly these rows. Mirrors the trigger's selection
 * (own default preferred over system).
 */
export async function getActiveRuleSet(userId: string): Promise<ActiveRuleSet> {
  const { data, error } = await supabase
    .from('gamification_rule_sets')
    .select('id, owner_user_id, scope, name, duration_days, rules')
    .or(`owner_user_id.eq.${userId},scope.eq.system`)
    .eq('is_default', true);

  if (error) throw error;

  const rows = (data ?? []) as RuleSetRow[];
  // Prefer the user's own default; fall back to the system default.
  const own = rows.find((r) => r.owner_user_id === userId);
  const system = rows.find((r) => r.scope === 'system');
  const chosen = own ?? system;
  if (!chosen) {
    throw new Error('No gamification rule set is configured. Apply migration 0006.');
  }

  return {
    id: chosen.id,
    name: chosen.name,
    scope: chosen.scope,
    durationDays: chosen.duration_days,
    rules: chosen.rules,
    isOwn: Boolean(own),
    modules: parseModules(chosen.rules),
  };
}

export interface EarnRule {
  action: string;
  points: number;
}

/**
 * Client-side fallback for the "How to Earn" list. Mirrors the seeded system
 * default economy in migration 0006 (points.per_meal 10, meal_count_goal 15,
 * protein_goal 25, macro_accuracy 30, streak_milestone 100 at the first 7-day
 * milestone). Used when getEarnRules() cannot resolve real rules (e.g. the rule
 * set is missing on first login, or the network read fails) so the screen still
 * shows the known defaults instead of an empty "unavailable" state. If the seed
 * amounts in 0006 change, update these to match.
 */
export const DEFAULT_EARN_RULES: EarnRule[] = [
  { action: 'Log a meal', points: 10 },
  { action: 'Log 3 meals in a day', points: 15 },
  { action: 'Hit your daily protein goal', points: 25 },
  { action: 'Nail your macro accuracy', points: 30 },
  { action: 'Reach a 7-day streak', points: 100 },
];

/**
 * Builds the "how to earn" list from the ACTIVE rule set's real award amounts +
 * enabled modules, so the Rewards screen reflects what the award engine actually
 * grants (replaces the former hardcoded EARN_RULES). Disabled modules are omitted.
 */
export async function getEarnRules(userId: string): Promise<EarnRule[]> {
  const active = await getActiveRuleSet(userId);
  const points = active.rules?.points ?? {};
  const m = active.modules;
  const rules: EarnRule[] = [];

  if (typeof points.per_meal === 'number') {
    rules.push({ action: 'Log a meal', points: points.per_meal });
  }
  if (m.mealCountEnabled && typeof points.meal_count_goal === 'number') {
    rules.push({ action: `Log ${m.mealCountRequired} meals in a day`, points: points.meal_count_goal });
  }
  if (m.proteinGoalEnabled && typeof points.protein_goal === 'number') {
    rules.push({ action: 'Hit your daily protein goal', points: points.protein_goal });
  }
  if (m.macroAccuracyEnabled && typeof points.macro_accuracy === 'number') {
    rules.push({ action: 'Nail your macro accuracy', points: points.macro_accuracy });
  }
  if (m.streakEnabled && typeof points.streak_milestone === 'number') {
    const firstMilestone = active.rules?.streak?.milestones?.[0];
    rules.push({
      action: firstMilestone ? `Reach a ${firstMilestone}-day streak` : 'Reach a streak milestone',
      points: points.streak_milestone,
    });
  }

  return rules;
}

/**
 * Persists module toggles/thresholds for the user by writing their OWN default
 * rule set (creating it from the current active rules on first save, updating it
 * after). The non-module config (xp/points/leaderboard amounts, macro bands) is
 * copied from the current active rules so nothing is lost. After this, the award
 * trigger uses the user's rule set instead of the system default.
 */
export async function saveRuleModules(userId: string, modules: RuleModules): Promise<void> {
  const active = await getActiveRuleSet(userId);

  // Patch only the module fields onto a deep-ish copy of the current rules.
  const nextRules: Record<string, any> = {
    ...active.rules,
    meal_count: {
      ...(active.rules?.meal_count ?? {}),
      enabled: modules.mealCountEnabled,
      required: modules.mealCountRequired,
    },
    protein_goal: {
      ...(active.rules?.protein_goal ?? {}),
      enabled: modules.proteinGoalEnabled,
      min_pct: modules.proteinMinPct,
    },
    macro_accuracy: {
      ...(active.rules?.macro_accuracy ?? {}),
      enabled: modules.macroAccuracyEnabled,
    },
    streak: {
      ...(active.rules?.streak ?? {}),
      enabled: modules.streakEnabled,
    },
  };

  if (active.isOwn) {
    const { error } = await supabase
      .from('gamification_rule_sets')
      .update({ rules: nextRules })
      .eq('id', active.id);
    if (error) throw error;
    return;
  }

  // First personal save: create the user's own default rule set (scope individual).
  const { error } = await supabase.from('gamification_rule_sets').insert({
    owner_user_id: userId,
    scope: 'individual',
    name: 'My Rules',
    duration_days: active.durationDays,
    is_default: true,
    rules: nextRules,
  });
  if (error) throw error;
}
