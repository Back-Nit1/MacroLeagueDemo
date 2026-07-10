import { supabase } from '../lib/supabase';

/**
 * Supabase-backed challenge system (migration 0007). Scores are DERIVED by the
 * database (get_challenge_standings sums the trusted gamification_events ledger
 * over the challenge window); the client never sends a score. Status is derived
 * from dates here so it can never go stale.
 */

export type ChallengeType = 'solo' | 'team';
export type ChallengeGoalType = 'points' | 'protein' | 'meal_count' | 'streak';
export type ChallengeStatus = 'upcoming' | 'active' | 'completed';

export interface ChallengeSummary {
  id: string;
  name: string;
  type: ChallengeType;
  goalType: ChallengeGoalType;
  stakesText: string;
  durationDays: number;
  startDate: string;
  endDate: string;
  createdBy: string;
  status: ChallengeStatus;
  participantCount: number;
  /** Whether the signed-in user is enrolled. */
  joined: boolean;
}

export interface ChallengeStanding {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  teamName: string;
  streakCount: number;
  score: number;
  rank: number;
}

export interface ChallengeGoal {
  id: string;
  goalType: string;
  description: string;
  targetValue: number;
  pointsValue: number;
}

export interface ChallengeDetail extends ChallengeSummary {
  standings: ChallengeStanding[];
  goals: ChallengeGoal[];
}

/**
 * A single participant's finalized placement in a completed challenge, as stored
 * by finalize_challenge() (migration 0013). `isWinner` marks the top-ranked
 * participant(s) with a positive score. This is the durable snapshot, not the
 * live standings.
 */
export interface ChallengeResult {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  teamName: string | null;
  rank: number;
  score: number;
  isWinner: boolean;
}

type ChallengeRow = {
  id: string;
  created_by: string;
  name: string;
  type: ChallengeType;
  goal_type: ChallengeGoalType;
  stakes_text: string;
  duration_days: number;
  start_date: string;
  end_date: string;
};

/** Derives upcoming/active/completed from the challenge's date window (local today). */
export function deriveStatus(startDate: string, endDate: string): ChallengeStatus {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (todayStr < startDate) return 'upcoming';
  if (todayStr > endDate) return 'completed';
  return 'active';
}

async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/**
 * Lists all discoverable challenges with participant counts and whether the
 * signed-in user has joined. Reads are RLS-open for challenges/participants;
 * we aggregate counts client-side from the participant rows.
 */
export async function listChallenges(): Promise<ChallengeSummary[]> {
  const userId = await currentUserId();

  const [{ data: challenges, error: cErr }, { data: parts, error: pErr }] = await Promise.all([
    supabase
      .from('challenges')
      .select('id, created_by, name, type, goal_type, stakes_text, duration_days, start_date, end_date')
      .order('start_date', { ascending: false }),
    supabase.from('challenge_participants').select('challenge_id, user_id'),
  ]);

  if (cErr) throw cErr;
  if (pErr) throw pErr;

  const partRows = (parts ?? []) as { challenge_id: string; user_id: string }[];
  const counts = new Map<string, number>();
  const mine = new Set<string>();
  for (const row of partRows) {
    counts.set(row.challenge_id, (counts.get(row.challenge_id) ?? 0) + 1);
    if (userId && row.user_id === userId) mine.add(row.challenge_id);
  }

  return ((challenges ?? []) as ChallengeRow[]).map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    goalType: c.goal_type,
    stakesText: c.stakes_text,
    durationDays: c.duration_days,
    startDate: c.start_date,
    endDate: c.end_date,
    createdBy: c.created_by,
    status: deriveStatus(c.start_date, c.end_date),
    participantCount: counts.get(c.id) ?? 0,
    joined: mine.has(c.id),
  }));
}

/** Loads one challenge with its derived standings (ranked) and stacked goals. */
export async function getChallengeDetail(challengeId: string): Promise<ChallengeDetail> {
  const userId = await currentUserId();

  const [{ data: c, error: cErr }, standingsRes, { data: goals, error: gErr }] = await Promise.all([
    supabase
      .from('challenges')
      .select('id, created_by, name, type, goal_type, stakes_text, duration_days, start_date, end_date')
      .eq('id', challengeId)
      .maybeSingle<ChallengeRow>(),
    supabase.rpc('get_challenge_standings', { p_challenge_id: challengeId }),
    supabase
      .from('challenge_goals')
      .select('id, goal_type, description, target_value, points_value')
      .eq('challenge_id', challengeId)
      .order('created_at', { ascending: true }),
  ]);

  if (cErr) throw cErr;
  if (!c) throw new Error('Challenge not found.');
  if (standingsRes.error) throw standingsRes.error;
  if (gErr) throw gErr;

  type StandingRow = {
    user_id: string;
    username: string;
    display_name: string | null;
    avatar_url: string | null;
    team_name: string;
    streak_count: number | null;
    score: number | string;
  };

  const standings: ChallengeStanding[] = ((standingsRes.data ?? []) as StandingRow[]).map((row, i) => ({
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    teamName: row.team_name,
    streakCount: row.streak_count ?? 0,
    score: Number(row.score),
    rank: i + 1,
  }));

  type GoalRow = {
    id: string;
    goal_type: string;
    description: string;
    target_value: number | string;
    points_value: number;
  };

  return {
    id: c.id,
    name: c.name,
    type: c.type,
    goalType: c.goal_type,
    stakesText: c.stakes_text,
    durationDays: c.duration_days,
    startDate: c.start_date,
    endDate: c.end_date,
    createdBy: c.created_by,
    status: deriveStatus(c.start_date, c.end_date),
    participantCount: standings.length,
    joined: Boolean(userId && standings.some((s) => s.userId === userId)),
    standings,
    goals: ((goals ?? []) as GoalRow[]).map((g) => ({
      id: g.id,
      goalType: g.goal_type,
      description: g.description,
      targetValue: Number(g.target_value),
      pointsValue: g.points_value,
    })),
  };
}

/**
 * Finalizes an ended challenge and returns its durable results (ranked, with
 * winner flags). Backed by the finalize_challenge() RPC (migration 0013), which
 * derives the ranking from the trusted ledger, stores challenge_results, and
 * awards each winner one challenge_win event + a profiles.challenges_won bump.
 * The RPC is idempotent and locks the challenge row, so it is safe to call every
 * time a completed challenge is opened; the backend never double-awards. Only
 * challenges that have already ended can be finalized (the RPC raises otherwise).
 */
export async function finalizeChallenge(challengeId: string): Promise<ChallengeResult[]> {
  const { data, error } = await supabase.rpc('finalize_challenge', {
    p_challenge_id: challengeId,
  });
  if (error) throw error;

  type ResultRow = {
    user_id: string;
    username: string;
    display_name: string | null;
    avatar_url: string | null;
    team_name: string | null;
    rank: number;
    score: number | string;
    is_winner: boolean;
  };

  return ((data ?? []) as ResultRow[]).map((r) => ({
    userId: r.user_id,
    username: r.username,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    teamName: r.team_name,
    rank: r.rank,
    score: Number(r.score),
    isWinner: r.is_winner,
  }));
}

export interface CreateChallengeInput {
  name: string;
  type: ChallengeType;
  goalType: ChallengeGoalType;
  durationDays: number;
  stakes: string;
}

/** Creates a challenge (and enrolls the creator) via the atomic create_challenge RPC. */
export async function createChallenge(input: CreateChallengeInput): Promise<string> {
  const { data, error } = await supabase.rpc('create_challenge', {
    p_name: input.name,
    p_type: input.type,
    p_goal_type: input.goalType,
    p_duration_days: input.durationDays,
    p_stakes: input.stakes,
  });
  if (error) throw error;
  return data as string;
}

/** Enrolls the signed-in user. The unique index makes a repeat join a clean error. */
export async function joinChallenge(challengeId: string, teamName = 'My Team'): Promise<void> {
  const userId = await currentUserId();
  if (!userId) throw new Error('You are not signed in.');
  const { error } = await supabase
    .from('challenge_participants')
    .insert({ challenge_id: challengeId, user_id: userId, team_name: teamName });
  if (error) {
    if (error.code === '23505') throw new Error('You have already joined this challenge.');
    throw error;
  }
}

/**
 * League points forfeited when you drop a challenge that has not ended. Kept in
 * sync with the hardcoded penalty inside the leave_challenge RPC (migration 0016)
 * so the UI warning and the DB always agree.
 */
export const CHALLENGE_DROP_PENALTY = 20;

/**
 * Drops the signed-in user out of a challenge. Dropping a challenge that is still
 * active (or upcoming) is a FORFEIT: the backend removes your membership AND docks
 * CHALLENGE_DROP_PENALTY league points from your leaderboard standing, atomically,
 * via the SECURITY DEFINER leave_challenge RPC (the client can never write points
 * itself). Returns the league points actually deducted — 0 if the challenge had
 * already ended, in which case leaving is free.
 */
export async function leaveChallenge(challengeId: string): Promise<number> {
  const { data, error } = await supabase.rpc('leave_challenge', {
    p_challenge_id: challengeId,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

// ── Challenge invites (migration 0011) ────────────────────────────

export interface ChallengeInvite {
  inviteId: string;
  challengeId: string;
  challengeName: string;
  goalType: string;
  endDate: string;
  inviterId: string;
  inviterName: string;
  createdAt: string;
}

/**
 * Invites a specific user into a challenge the caller participates in. Returns the
 * invite id. Throws if the caller isn't a participant or the target already is.
 */
export async function inviteToChallenge(challengeId: string, inviteeId: string): Promise<string> {
  const { data, error } = await supabase.rpc('invite_to_challenge', {
    p_challenge_id: challengeId,
    p_invitee: inviteeId,
  });
  if (error) throw error;
  return data as string;
}

/** Accept (auto-joins) or decline a challenge invite addressed to the caller. */
export async function respondChallengeInvite(inviteId: string, accept: boolean): Promise<void> {
  const { error } = await supabase.rpc('respond_challenge_invite', {
    p_invite_id: inviteId,
    p_accept: accept,
  });
  if (error) throw error;
}

/** The caller's pending incoming challenge invites. */
export async function getChallengeInvites(): Promise<ChallengeInvite[]> {
  const { data, error } = await supabase.rpc('get_challenge_invites');
  if (error) throw error;
  return ((data ?? []) as any[]).map((r) => ({
    inviteId: r.invite_id,
    challengeId: r.challenge_id,
    challengeName: r.challenge_name,
    goalType: r.goal_type,
    endDate: r.end_date,
    inviterId: r.inviter_id,
    inviterName: r.inviter_name,
    createdAt: r.created_at,
  }));
}
