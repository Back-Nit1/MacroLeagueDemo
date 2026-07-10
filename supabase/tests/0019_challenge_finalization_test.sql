-- Repeatable test for migration 0019 (challenge finalization).
--
-- Self-contained and transactional: everything runs inside ONE transaction that
-- ROLLS BACK at the end, so it leaves NO data behind and is safe to run against
-- any database (including production) via:
--   npx supabase db query --linked -f supabase/tests/0019_challenge_finalization_test.sql
-- A failed assertion RAISEs (visible error == failed test); the final
-- "ALL FINALIZATION TESTS PASSED" notice == success.
--
-- Unlike the 0007 test, we seed the ledger DIRECTLY (as the migration/table owner,
-- no `set role`) with occurred_at values inside a PAST challenge window. This is
-- required because a finalizable challenge has already ENDED, so live meals logged
-- at now() would fall outside its scoring window. Seeding the ledger lets us test
-- finalize_challenge()'s ranking + award logic in isolation from the meal trigger.

begin;
set local client_min_messages = warning;

do $$
declare
  u1 uuid := 'eeeeeeee-0000-4000-8000-000000000001';  -- higher score → winner
  u2 uuid := 'ffffffff-0000-4000-8000-000000000002';  -- lower score → not a winner
  v_cid          uuid;
  v_start        date := current_date - 10;
  v_end          date := current_date - 1;   -- ended yesterday → finalizable
  v_in_window    timestamptz := (current_date - 5)::timestamptz;
  v_win_count1   integer;
  v_win_count2   integer;
  v_points1      integer;
  v_points1_after integer;
  v_events       integer;
  v_rows         integer;
  v_is_winner1   boolean;
  v_is_winner2   boolean;
  v_rank1        integer;
  v_rank2        integer;
begin
  -- Seed auth.users + profiles. challenges_won/points start at 0 (schema defaults).
  insert into auth.users (id, email, instance_id, aud, role)
  values
    (u1, 'finwinner@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
    (u2, 'finloser@test.local',  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
  on conflict (id) do nothing;

  insert into public.profiles
    (id, username, timezone, goal_calories, goal_protein_g, goal_carbs_g, goal_unsaturated_fat_g, goal_trans_fat_g)
  values
    (u1, 'fin_winner', 'America/New_York', 2000, 100, 200, 60, 0),
    (u2, 'fin_loser',  'America/New_York', 2000, 100, 200, 60, 0)
  on conflict (id) do nothing;

  -- A challenge that already ended. Inserted directly (owner) with past dates,
  -- since create_challenge() forces start_date = current_date.
  insert into public.challenges
    (created_by, name, type, goal_type, stakes_text, duration_days, start_date, end_date)
  values
    (u1, 'Finished League', 'team', 'points', 'Bragging rights', 7, v_start, v_end)
  returning id into v_cid;

  insert into public.challenge_participants (challenge_id, user_id, team_name)
  values (v_cid, u1, 'Team A'), (v_cid, u2, 'Team B');

  -- Seed the ledger inside the challenge window: u1 = 30, u2 = 10.
  insert into public.gamification_events
    (user_id, event_type, source_type, source_id, points_delta, leaderboard_delta, occurred_at, metadata)
  values
    (u1, 'manual_adjustment', 'system', null, 0, 30, v_in_window, '{}'::jsonb),
    (u2, 'manual_adjustment', 'system', null, 0, 10, v_in_window, '{}'::jsonb);

  -- Capture u1's starting points so we can assert the win bonus is applied once.
  select points into v_points1 from public.profiles where id = u1;

  ------------------------------------------------------------------------------
  -- TEST 1: finalizing a NOT-yet-ended challenge is rejected.
  ------------------------------------------------------------------------------
  declare
    v_future_cid uuid;
  begin
    insert into public.challenges
      (created_by, name, type, goal_type, stakes_text, duration_days, start_date, end_date)
    values
      (u1, 'Ongoing League', 'team', 'points', 'Bragging rights', 7, current_date, current_date + 7)
    returning id into v_future_cid;

    begin
      perform public.finalize_challenge(v_future_cid);
      raise exception 'TEST 1 FAILED: finalizing a non-ended challenge should have raised';
    exception when others then
      if sqlerrm not like '%has not ended%' then
        raise exception 'TEST 1 FAILED: unexpected error: %', sqlerrm;
      end if;
    end;
  end;
  raise notice 'TEST 1 ok: a non-ended challenge cannot be finalized';

  ------------------------------------------------------------------------------
  -- TEST 2: finalize the ended challenge → durable results with correct ranks.
  ------------------------------------------------------------------------------
  perform public.finalize_challenge(v_cid);

  select count(*) into v_rows from public.challenge_results where challenge_id = v_cid;
  if v_rows <> 2 then
    raise exception 'TEST 2 FAILED: expected 2 result rows, got %', v_rows;
  end if;

  select rank, is_winner into v_rank1, v_is_winner1
  from public.challenge_results where challenge_id = v_cid and user_id = u1;
  select rank, is_winner into v_rank2, v_is_winner2
  from public.challenge_results where challenge_id = v_cid and user_id = u2;

  if v_rank1 <> 1 or v_is_winner1 is not true then
    raise exception 'TEST 2 FAILED: u1 should be rank 1 winner, got rank=% winner=%', v_rank1, v_is_winner1;
  end if;
  if v_rank2 <> 2 or v_is_winner2 is not false then
    raise exception 'TEST 2 FAILED: u2 should be rank 2 non-winner, got rank=% winner=%', v_rank2, v_is_winner2;
  end if;
  raise notice 'TEST 2 ok: results stored, u1 ranked winner, u2 ranked non-winner';

  ------------------------------------------------------------------------------
  -- TEST 3: the winner got exactly one challenge_win event, +1 win, +bonus points;
  -- the loser got nothing.
  ------------------------------------------------------------------------------
  select count(*) into v_events
  from public.gamification_events
  where user_id = u1 and event_type = 'challenge_win' and source_type = 'challenge' and source_id = v_cid;
  if v_events <> 1 then
    raise exception 'TEST 3 FAILED: expected exactly 1 challenge_win event for u1, got %', v_events;
  end if;

  select challenges_won into v_win_count1 from public.profiles where id = u1;
  select challenges_won into v_win_count2 from public.profiles where id = u2;
  if v_win_count1 <> 1 then
    raise exception 'TEST 3 FAILED: u1 challenges_won should be 1, got %', v_win_count1;
  end if;
  if v_win_count2 <> 0 then
    raise exception 'TEST 3 FAILED: u2 challenges_won should be 0, got %', v_win_count2;
  end if;

  select points into v_points1_after from public.profiles where id = u1;
  if v_points1_after <> v_points1 + 100 then
    raise exception 'TEST 3 FAILED: u1 points should be +100 (start % -> %), got %',
      v_points1, v_points1 + 100, v_points1_after;
  end if;
  raise notice 'TEST 3 ok: winner got 1 event, +1 win, +100 points; loser got nothing';

  ------------------------------------------------------------------------------
  -- TEST 4: re-finalizing is idempotent — no double award.
  ------------------------------------------------------------------------------
  perform public.finalize_challenge(v_cid);

  select count(*) into v_events
  from public.gamification_events
  where user_id = u1 and event_type = 'challenge_win' and source_type = 'challenge' and source_id = v_cid;
  select challenges_won into v_win_count1 from public.profiles where id = u1;
  select points into v_points1_after from public.profiles where id = u1;
  select count(*) into v_rows from public.challenge_results where challenge_id = v_cid;

  if v_events <> 1 then
    raise exception 'TEST 4 FAILED: re-finalize duplicated the win event (count=%)', v_events;
  end if;
  if v_win_count1 <> 1 then
    raise exception 'TEST 4 FAILED: re-finalize double-counted challenges_won (=%)', v_win_count1;
  end if;
  if v_points1_after <> v_points1 + 100 then
    raise exception 'TEST 4 FAILED: re-finalize double-awarded points (=%)', v_points1_after;
  end if;
  if v_rows <> 2 then
    raise exception 'TEST 4 FAILED: re-finalize duplicated result rows (=%)', v_rows;
  end if;
  raise notice 'TEST 4 ok: re-finalization is idempotent (no double award)';

  raise notice 'ALL FINALIZATION TESTS PASSED';
end $$;

rollback;
