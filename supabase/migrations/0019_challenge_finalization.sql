-- Phase 1 challenge finalization: turn ended challenges into durable results and
-- real profile wins. Forward-only and ADDITIVE on top of 0001-0012; it never
-- edits earlier migrations.
--
-- This closes the gap documented in 0007_challenges.sql:
--   "No auto-finalization / winner declaration / challenge_win point award yet.
--    profiles.challenges_won therefore stays 0 until a later finalize step..."
--
-- TRUST MODEL (mirrors get_challenge_standings in 0007):
--   * Winners are DERIVED, never client-set. finalize_challenge() re-uses the
--     exact same scoring as get_challenge_standings(): sum each participant's
--     gamification_events.leaderboard_delta inside the challenge's date window.
--     The client can never submit a score or declare itself the winner.
--   * The whole award path is SECURITY DEFINER so it can write the backend-owned
--     counters (profiles.challenges_won / points) that the client is revoked from,
--     and read cross-user rows that per-row RLS would otherwise hide.
--
-- IDEMPOTENCY (double-award is impossible):
--   * finalize_challenge() locks the challenge row FOR UPDATE, so concurrent calls
--     serialize; the award block runs only while challenges.finalized_at is NULL.
--   * The challenge_win ledger event uses source_id = challenge_id, so the
--     existing partial unique index gamification_events_unique_source guarantees
--     at most one win event per (user, challenge). The counter bump only happens
--     for events that were actually inserted (INSERT ... RETURNING), so a replay
--     changes nothing.
--
-- DELIBERATE CHOICES (documented):
--   * A challenge is finalizable only once it has ENDED (current_date > end_date),
--     matching the client's deriveStatus() 'completed' rule.
--   * Winner(s) = the top rank WITH a positive score. A challenge where nobody
--     scored produces results rows but no winner and no award (no empty wins).
--   * True ties (identical score AND streak) share rank 1 via rank(), so genuine
--     co-winners are all awarded. Each is a distinct user, so the ledger's
--     per-user uniqueness still holds.
--   * The win bonus is data-driven from the system rule set (points.challenge_win,
--     default 100) and awarded as points only. leaderboard_delta = 0 so a win is a
--     reward and never distorts other leaderboard windows. profiles.points is
--     updated in lockstep so the cached balance stays equal to the ledger sum.

-- ===========================================================================
-- 1. Mark a challenge as finalized. NULL until finalize_challenge() runs once.
-- ===========================================================================
alter table public.challenges
  add column finalized_at timestamptz;

comment on column public.challenges.finalized_at is
  'When finalize_challenge() computed durable results + awarded wins for this challenge. NULL = not finalized yet. Set once; the award path is gated on it being NULL.';

-- ===========================================================================
-- 2. Durable, per-participant result history. This is the source of truth for a
--    completed challenge''s ranking + winners (get_challenge_standings stays the
--    LIVE view; results are the SNAPSHOT at finalization).
-- ===========================================================================
create table public.challenge_results (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  rank integer not null,
  score bigint not null,
  is_winner boolean not null default false,
  finalized_at timestamptz not null default now(),
  constraint challenge_results_rank_positive check (rank >= 1),
  constraint challenge_results_score_nonnegative check (score >= 0)
);

-- One result row per (challenge, user); makes re-finalization inserts a no-op path.
create unique index challenge_results_unique
  on public.challenge_results (challenge_id, user_id);
create index challenge_results_challenge on public.challenge_results (challenge_id);
-- Supports future "wins history / wins by division" reads for a user.
create index challenge_results_user on public.challenge_results (user_id);

comment on table public.challenge_results is
  'Snapshot of a challenge''s final ranking, written once by finalize_challenge(). is_winner marks the top-ranked participant(s) with a positive score. Durable history for profile wins and future per-division breakdowns.';

-- ===========================================================================
-- 3. finalize_challenge(): derive final standings, store results, award wins.
--    SECURITY DEFINER so it can write backend-owned counters and read across
--    users. Safe for ANY authenticated viewer to call (e.g. lazily when a
--    completed challenge is opened): it computes everything from the trusted
--    ledger and is idempotent. Returns the stored results for display.
-- ===========================================================================
create or replace function public.finalize_challenge(p_challenge_id uuid)
returns table (
  user_id uuid,
  username text,
  display_name text,
  avatar_url text,
  team_name text,
  rank integer,
  score bigint,
  is_winner boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
-- ^ The RETURNS TABLE output names (user_id, rank, score, ...) are in scope as
-- variables for the whole body, which would make bare column references like the
-- INSERT ... RETURNING below ambiguous. use_column makes the column win.
declare
  v_end        date;
  v_finalized  timestamptz;
  v_sys_rules  jsonb;
  v_win_points integer;
begin
  -- Lock the challenge row so two concurrent finalizations serialize on it.
  select end_date, finalized_at
    into v_end, v_finalized
  from public.challenges
  where id = p_challenge_id
  for update;

  if v_end is null then
    raise exception 'Challenge not found';
  end if;

  -- Only an ENDED challenge can be finalized (mirrors client deriveStatus:
  -- 'completed' == today is strictly past end_date).
  if current_date <= v_end then
    raise exception 'Challenge has not ended yet';
  end if;

  -- First finalization only. A replay skips straight to returning stored results.
  if v_finalized is null then
    -- Configurable win bonus from the system economy (default 100 points).
    select rules into v_sys_rules
    from public.gamification_rule_sets
    where scope = 'system' and is_default
    limit 1;
    v_win_points := coalesce((v_sys_rules #>> '{points,challenge_win}')::int, 100);

    -- (a) Derive + persist the final ranking from the trusted ledger. Same window
    --     and same leaderboard_delta sum as get_challenge_standings(). rank() lets
    --     genuine ties (same score AND streak) share rank 1 as co-winners.
    with standings as (
      select
        cp.user_id,
        p.streak_count,
        coalesce((
          select sum(e.leaderboard_delta)
          from public.gamification_events e
          where e.user_id = cp.user_id
            and e.leaderboard_delta <> 0
            and e.occurred_at >= c.start_date::timestamptz
            and e.occurred_at <  (c.end_date + 1)::timestamptz
        ), 0)::bigint as score
      from public.challenge_participants cp
      join public.challenges c on c.id = cp.challenge_id
      join public.profiles    p on p.id = cp.user_id
      where cp.challenge_id = p_challenge_id
    ),
    ranked as (
      select
        s.user_id,
        s.score,
        rank() over (order by s.score desc, s.streak_count desc) as rnk
      from standings s
    )
    insert into public.challenge_results (challenge_id, user_id, rank, score, is_winner, finalized_at)
    select
      p_challenge_id,
      r.user_id,
      r.rnk::int,
      r.score,
      (r.rnk = 1 and r.score > 0),  -- winner(s): top rank, but only with a positive score
      now()
    from ranked r;

    -- (b) Award each winner exactly once: an idempotent challenge_win ledger event
    --     (source_id = challenge_id => unique per user/challenge) plus the cached
    --     counter bumps. leaderboard_delta = 0 so a win never leaks into other
    --     leaderboard windows.
    with winners as (
      select cr.user_id
      from public.challenge_results cr
      where cr.challenge_id = p_challenge_id and cr.is_winner
    ),
    inserted as (
      insert into public.gamification_events
        (user_id, event_type, source_type, source_id, xp_delta, points_delta, leaderboard_delta, metadata)
      select
        w.user_id, 'challenge_win', 'challenge', p_challenge_id, 0, v_win_points, 0,
        jsonb_build_object('challenge_id', p_challenge_id)
      from winners w
      on conflict (user_id, event_type, source_type, source_id) where source_id is not null
      do nothing
      returning user_id, points_delta
    )
    update public.profiles pr
      set challenges_won = pr.challenges_won + 1,
          points         = pr.points + i.points_delta,
          updated_at     = now()
    from inserted i
    where pr.id = i.user_id;

    update public.challenges
      set finalized_at = now()
      where id = p_challenge_id;
  end if;

  -- Return the stored results (single source of truth post-finalization).
  return query
    select
      cr.user_id,
      p.username,
      p.display_name,
      p.avatar_url,
      cp.team_name,
      cr.rank,
      cr.score,
      cr.is_winner
    from public.challenge_results cr
    join public.profiles p on p.id = cr.user_id
    left join public.challenge_participants cp
      on cp.challenge_id = cr.challenge_id and cp.user_id = cr.user_id
    where cr.challenge_id = p_challenge_id
    order by cr.rank asc, p.username asc;
end;
$$;

revoke all on function public.finalize_challenge(uuid) from public;
grant execute on function public.finalize_challenge(uuid) to authenticated;

comment on function public.finalize_challenge(uuid) is
  'Finalizes an ended challenge: derives the final ranking from the gamification_events ledger, stores it in challenge_results, and awards each winner one idempotent challenge_win event + a profiles.challenges_won/points bump. Locks the challenge row and gates on finalized_at so it can never double-award. Returns the stored results.';

-- ===========================================================================
-- 4. RLS. Results are readable by any authenticated user (a campus competition
--    app shows completed standings/winners). There is NO client write policy:
--    rows are written ONLY by finalize_challenge() (SECURITY DEFINER, table
--    owner), so a client can never fake a result or a win.
-- ===========================================================================
alter table public.challenge_results enable row level security;

create policy "read challenge results"
  on public.challenge_results
  for select
  using (true);
