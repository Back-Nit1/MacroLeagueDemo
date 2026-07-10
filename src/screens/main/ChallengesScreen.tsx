import React, { useCallback, useEffect, useState } from 'react';
import { View, ActivityIndicator, Pressable } from 'react-native';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { useTheme } from '../../theme';
import { useUserStore } from '../../store/userStore';
import ChallengeCard from '../../components/ChallengeCard';
import RotatingTrophy from '../../components/animations/RotatingTrophy';
import {
  Screen,
  Text,
  Card,
  Button,
  Sheet,
  SegmentedControl,
  Chip,
  TextField,
  Avatar,
  IconButton,
  AppIcon,
  Divider,
} from '../../components/ui';
import { AppIconName } from '../../components/ui/AppIcon';
import {
  listChallenges,
  getChallengeDetail,
  finalizeChallenge,
  createChallenge,
  joinChallenge,
  leaveChallenge,
  CHALLENGE_DROP_PENALTY,
  inviteToChallenge,
  respondChallengeInvite,
  getChallengeInvites,
  ChallengeSummary,
  ChallengeDetail as ChallengeDetailType,
  ChallengeResult,
  ChallengeInvite,
  ChallengeType,
  ChallengeGoalType,
} from '../../services/challengeService';
import { publicLeaderboardName } from '../../services/leaderboardService';
import { getFriends, Friend } from '../../services/friendService';
import { analytics } from '../../lib/analytics';

/** Friend passed from the Leaderboard "Challenge" button to pre-seed an invite. */
type InviteFriendParam = { id: string; name: string } | undefined;

/** A template can pre-seed the create sheet from the empty state. */
type CreateSeed = { name?: string; goalType?: ChallengeGoalType } | undefined;

export default function ChallengesScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const [challenges, setChallenges] = useState<ChallengeSummary[]>([]);
  const [invites, setInvites] = useState<ChallengeInvite[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  // Friend to invite once a challenge is created (from the Leaderboard button).
  const [pendingInvite, setPendingInvite] = useState<InviteFriendParam>(undefined);
  const [seed, setSeed] = useState<CreateSeed>(undefined);
  const [respondingInvite, setRespondingInvite] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [list, inv] = await Promise.all([listChallenges(), getChallengeInvites()]);
      setChallenges(list);
      setInvites(inv);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load challenges.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // A friend tapped "Challenge" on the Leaderboard → open Create pre-seeded.
  useFocusEffect(
    useCallback(() => {
      const friend = route.params?.inviteFriend as InviteFriendParam;
      if (friend) {
        setPendingInvite(friend);
        setShowCreate(true);
        navigation.setParams({ inviteFriend: undefined });
      }
    }, [route.params?.inviteFriend, navigation]),
  );

  async function respondToInvite(inviteId: string, accept: boolean) {
    setRespondingInvite(inviteId);
    try {
      await respondChallengeInvite(inviteId, accept);
      await load();
    } finally {
      setRespondingInvite(null);
    }
  }

  function openCreate(nextSeed?: CreateSeed) {
    setSeed(nextSeed);
    setShowCreate(true);
  }

  function closeCreate() {
    setShowCreate(false);
    setPendingInvite(undefined);
    setSeed(undefined);
  }

  if (selectedId) {
    return (
      <ChallengeDetail
        challengeId={selectedId}
        onBack={() => {
          setSelectedId(null);
          void load();
        }}
      />
    );
  }

  const active = challenges.filter((c) => c.status === 'active');
  const upcoming = challenges.filter((c) => c.status === 'upcoming');
  const completed = challenges.filter((c) => c.status === 'completed');

  return (
    <>
      <Screen scroll bottomSpace={96}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
          <Text variant="heading" color={colors.ink} style={{ flex: 1 }}>
            Challenges
          </Text>
          <IconButton
            icon="plus"
            onPress={() => openCreate()}
            bg={colors.ink}
            color={colors.onPrimary}
            border={false}
            accessibilityLabel="Create challenge"
          />
        </View>

        {isLoading ? (
          <View style={{ alignItems: 'center', paddingVertical: 48 }}>
            <ActivityIndicator color={colors.scarlet} />
          </View>
        ) : error ? (
          <Card
            padded
            accent={colors.brandTintBorder}
            style={{ backgroundColor: colors.brandTint, marginBottom: 12 }}
          >
            <Text variant="label" color={colors.error}>
              {error}
            </Text>
          </Card>
        ) : challenges.length === 0 && invites.length === 0 ? (
          <EmptyState onTemplate={(s) => openCreate(s)} onCreate={() => openCreate()} />
        ) : (
          <>
            {invites.length > 0 && (
              <View style={{ marginBottom: 24 }}>
                <SectionLabel>{`Challenge invites · ${invites.length}`}</SectionLabel>
                {invites.map((inv) => (
                  <InviteCard
                    key={inv.inviteId}
                    invite={inv}
                    busy={respondingInvite === inv.inviteId}
                    onRespond={(accept) => respondToInvite(inv.inviteId, accept)}
                  />
                ))}
              </View>
            )}

            <ChallengeSection label={`Active · ${active.length}`} items={active} onSelect={setSelectedId} />
            <ChallengeSection label={`Upcoming · ${upcoming.length}`} items={upcoming} onSelect={setSelectedId} />
            <ChallengeSection label="Completed" items={completed} onSelect={setSelectedId} dim />

            <CreateCTA onPress={() => openCreate()} />
          </>
        )}
      </Screen>

      <CreateChallengeSheet
        visible={showCreate}
        inviteFriend={pendingInvite}
        seed={seed}
        onClose={closeCreate}
        onCreated={() => {
          closeCreate();
          void load();
        }}
      />
    </>
  );
}

// ── Small presentational helpers ──────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <Text variant="overline" color={colors.textSecondary} style={{ marginBottom: 12 }}>
      {children}
    </Text>
  );
}

function ChallengeSection({
  label,
  items,
  onSelect,
  dim,
}: {
  label: string;
  items: ChallengeSummary[];
  onSelect: (id: string) => void;
  dim?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <View style={{ marginBottom: 24, opacity: dim ? 0.8 : 1 }}>
      <SectionLabel>{label}</SectionLabel>
      {items.map((c) => (
        <ChallengeCard
          key={c.id}
          name={c.name}
          type={c.type}
          stakesText={c.stakesText}
          endDate={c.endDate}
          status={c.status}
          participantCount={c.participantCount}
          joined={c.joined}
          onPress={() => onSelect(c.id)}
        />
      ))}
    </View>
  );
}

function CreateCTA({ onPress }: { onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 8,
        borderWidth: 1.5,
        borderColor: colors.borderInput,
        borderStyle: 'dashed',
        borderRadius: 16,
        paddingVertical: 16,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <AppIcon name="plus" size={18} color={colors.ink} />
      <Text variant="subhead" color={colors.ink}>
        Create challenge
      </Text>
    </Pressable>
  );
}

const TEMPLATES: { name: string; goalType: ChallengeGoalType; sub: string; icon: AppIconName; tint: 'scarlet' | 'success' | 'streak' }[] = [
  { name: 'Protein Push', goalType: 'protein', sub: 'Hit a daily protein goal for 7 days', icon: 'protein', tint: 'scarlet' },
  { name: 'Log Every Day', goalType: 'meal_count', sub: 'At least one confirmed meal daily', icon: 'calendar', tint: 'success' },
  { name: 'Streak Sprint', goalType: 'streak', sub: 'Longest streak wins the window', icon: 'flame', tint: 'streak' },
];

function EmptyState({
  onTemplate,
  onCreate,
}: {
  onTemplate: (seed: CreateSeed) => void;
  onCreate: () => void;
}) {
  const { colors } = useTheme();
  const tintBg = { scarlet: colors.brandTint, success: colors.successTint, streak: colors.streakTint };
  const tintFg = { scarlet: colors.scarlet, success: colors.successDeep, streak: colors.streak };
  return (
    <View>
      <Card style={{ alignItems: 'center', paddingVertical: 28, marginBottom: 20 }}>
        <View
          style={{
            width: 52,
            height: 52,
            borderRadius: 14,
            backgroundColor: colors.track,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 14,
          }}
        >
          <AppIcon name="challenges" size={26} color={colors.ink} />
        </View>
        <Text variant="section" color={colors.ink} center style={{ marginBottom: 6 }}>
          Start a challenge.
        </Text>
        <Text variant="body" color={colors.textSecondary} center style={{ maxWidth: 260 }}>
          Pick a goal, invite friends, and compete for the week.
        </Text>
      </Card>

      <SectionLabel>Templates</SectionLabel>
      {TEMPLATES.map((t) => (
        <Card
          key={t.name}
          onPress={() => onTemplate({ name: t.name, goalType: t.goalType })}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 12 }}
        >
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              backgroundColor: tintBg[t.tint],
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <AppIcon name={t.icon} size={20} color={tintFg[t.tint]} />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="subhead" color={colors.ink}>
              {t.name}
            </Text>
            <Text variant="label" color={colors.textSecondary}>
              {t.sub}
            </Text>
          </View>
          <AppIcon name="chevron-right" size={18} color={colors.textTertiary} />
        </Card>
      ))}

      <View style={{ marginTop: 8 }}>
        <CreateCTA onPress={onCreate} />
      </View>
    </View>
  );
}

function InviteCard({
  invite,
  busy,
  onRespond,
}: {
  invite: ChallengeInvite;
  busy: boolean;
  onRespond: (accept: boolean) => void;
}) {
  const { colors } = useTheme();
  return (
    <Card
      accent={colors.brandTintBorder}
      style={{
        marginBottom: 10,
        borderStyle: 'dashed',
        borderWidth: 1.5,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Avatar name={invite.inviterName} size={40} />
        <View style={{ flex: 1 }}>
          <Text variant="subhead" color={colors.ink} numberOfLines={1}>
            {invite.challengeName}
          </Text>
          <Text variant="label" color={colors.textSecondary} numberOfLines={1}>
            {invite.inviterName} invited you · ends{' '}
            {new Date(`${invite.endDate}T00:00:00`).toLocaleDateString()}
          </Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
        <Button
          label="Accept"
          onPress={() => onRespond(true)}
          loading={busy}
          size="md"
          style={{ flex: 1 }}
        />
        <Button
          label="Decline"
          variant="secondary"
          onPress={() => onRespond(false)}
          disabled={busy}
          size="md"
          style={{ flex: 1 }}
        />
      </View>
    </Card>
  );
}

// ── Create Challenge Sheet ────────────────────────────────

const GOAL_OPTIONS: { key: ChallengeGoalType; label: string; icon: AppIconName }[] = [
  { key: 'protein', label: 'Protein', icon: 'protein' },
  { key: 'meal_count', label: 'Meals', icon: 'meal-goal' },
  { key: 'streak', label: 'Streak', icon: 'flame' },
];

const DURATIONS = [3, 7, 14];

function CreateChallengeSheet({
  visible,
  inviteFriend,
  seed,
  onClose,
  onCreated,
}: {
  visible: boolean;
  inviteFriend?: InviteFriendParam;
  seed?: CreateSeed;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { colors } = useTheme();
  const [name, setName] = useState('');
  const [type, setType] = useState<ChallengeType>('team');
  const [goalType, setGoalType] = useState<ChallengeGoalType>('protein');
  const [duration, setDuration] = useState(7);
  const [stakes, setStakes] = useState('');
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Apply template/friend seed each time the sheet opens.
  useEffect(() => {
    if (visible) {
      setName(seed?.name ?? '');
      setGoalType(seed?.goalType ?? 'protein');
      setNameError(null);
      setNotice(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  async function handleCreate() {
    if (!name.trim()) {
      // Inline error — never a system alert. Every other field is preserved.
      setNameError('Give your challenge a name. Everything else is saved.');
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const challengeId = await createChallenge({
        name: name.trim(),
        type,
        goalType,
        durationDays: duration,
        stakes: stakes.trim(),
      });
      // Creating a challenge auto-enrolls the creator — a participation signal.
      analytics.challengeCreated({ type, goalType, durationDays: duration });
      // If launched from a friend's "Challenge" button, invite them now.
      if (inviteFriend) {
        try {
          await inviteToChallenge(challengeId, inviteFriend.id);
        } catch {
          setName('');
          setStakes('');
          onCreated();
          return;
        }
      }
      setName('');
      setStakes('');
      onCreated();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not create. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="Create challenge" showClose scrollable>
      <View style={{ paddingHorizontal: 20, paddingTop: 16, gap: 18 }}>
        {inviteFriend && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <AppIcon name="users" size={15} color={colors.scarlet} />
            <Text variant="label" color={colors.scarlet}>
              Inviting {inviteFriend.name}
            </Text>
          </View>
        )}

        <TextField
          label="Challenge name"
          value={name}
          onChangeText={(t) => {
            setName(t);
            if (nameError) setNameError(null);
          }}
          placeholder="e.g. Protein Push"
          error={nameError}
          autoCapitalize="sentences"
        />

        <View style={{ gap: 8 }}>
          <Text variant="labelSm" color={colors.textSecondary}>
            Format
          </Text>
          <SegmentedControl
            segments={['Solo', 'Team']}
            value={type === 'solo' ? 0 : 1}
            onChange={(i) => setType(i === 0 ? 'solo' : 'team')}
          />
        </View>

        <View style={{ gap: 8 }}>
          <Text variant="labelSm" color={colors.textSecondary}>
            Goal
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {GOAL_OPTIONS.map((g) => (
              <Chip
                key={g.key}
                label={g.label}
                icon={g.icon}
                shape="tile"
                selected={goalType === g.key}
                onPress={() => setGoalType(g.key)}
              />
            ))}
          </View>
        </View>

        <View style={{ gap: 8 }}>
          <Text variant="labelSm" color={colors.textSecondary}>
            Duration
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {DURATIONS.map((d) => (
              <Chip
                key={d}
                label={`${d} days`}
                selected={duration === d}
                onPress={() => setDuration(d)}
              />
            ))}
          </View>
        </View>

        <TextField
          label="Stakes — optional"
          value={stakes}
          onChangeText={setStakes}
          placeholder="Loser buys smoothies"
          rightIcon="edit"
          autoCapitalize="sentences"
        />

        {notice && (
          <Text variant="label" color={colors.error}>
            {notice}
          </Text>
        )}

        <Button
          label="Create challenge"
          onPress={handleCreate}
          loading={saving}
          loadingLabel="Creating…"
        />
      </View>
    </Sheet>
  );
}

// ── Challenge Detail ──────────────────────────────────────

const RANK_ICON: Record<number, AppIconName> = { 1: 'crown', 2: 'medal', 3: 'medal' };

function ChallengeDetail({ challengeId, onBack }: { challengeId: string; onBack: () => void }) {
  const { colors } = useTheme();
  const userId = useUserStore((s) => s.user?.id);
  const refreshStats = useUserStore((s) => s.refreshStats);
  const [detail, setDetail] = useState<ChallengeDetailType | null>(null);
  const [results, setResults] = useState<ChallengeResult[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showDrop, setShowDrop] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const loaded = await getChallengeDetail(challengeId);
      setDetail(loaded);
      // A completed challenge is finalized on open: this derives + stores the
      // winner and awards challenges_won on the backend (idempotent, so calling
      // it every open is safe). We then refresh our own stats in case we won.
      if (loaded.status === 'completed') {
        try {
          setResults(await finalizeChallenge(challengeId));
          void refreshStats();
        } catch {
          // Best-effort: standings still render even if finalization fails.
          setResults(null);
        }
      } else {
        setResults(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this challenge.');
    } finally {
      setIsLoading(false);
    }
  }, [challengeId, refreshStats]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function handleJoin() {
    setJoining(true);
    try {
      await joinChallenge(challengeId, detail?.type === 'solo' ? 'Solo' : 'My Team');
      analytics.challengeJoined({
        challengeId,
        type: detail?.type ?? 'unknown',
        goalType: detail?.goalType ?? 'unknown',
      });
      await load();
    } finally {
      setJoining(false);
    }
  }

  async function handleLeave() {
    setDropping(true);
    setDropError(null);
    try {
      await leaveChallenge(challengeId);
      analytics.challengeLeft({ challengeId });
      // Dropping is a forfeit; return to the list, which reloads standings.
      setShowDrop(false);
      onBack();
    } catch (e) {
      setDropError(e instanceof Error ? e.message : 'Could not drop this challenge.');
    } finally {
      setDropping(false);
    }
  }

  if (isLoading) {
    return (
      <Screen>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.scarlet} size="large" />
        </View>
      </Screen>
    );
  }

  if (error || !detail) {
    return (
      <Screen scroll bottomSpace={96}>
        <IconButton icon="chevron-left" onPress={onBack} accessibilityLabel="Back" style={{ marginLeft: -4, marginBottom: 16 }} />
        <Card accent={colors.brandTintBorder} style={{ backgroundColor: colors.brandTint }}>
          <Text variant="label" color={colors.error}>
            {error ?? 'Challenge not found.'}
          </Text>
        </Card>
      </Screen>
    );
  }

  const canInvite = detail.joined && detail.status !== 'completed';

  // Group standings by team for team challenges (head-to-head VS layout).
  const teams = new Map<string, { score: number; members: string[] }>();
  for (const s of detail.standings) {
    const entry = teams.get(s.teamName) ?? { score: 0, members: [] };
    entry.score += s.score;
    entry.members.push(publicLeaderboardName(s));
    teams.set(s.teamName, entry);
  }
  const teamEntries = Array.from(teams.entries());
  const headToHead = detail.type === 'team' && teamEntries.length >= 2;

  // Winner(s) of a finalized challenge. May be empty (nobody scored) or hold
  // multiple names on a genuine tie.
  const winners = (results ?? []).filter((r) => r.isWinner);
  const iWon = winners.some((w) => w.userId === userId);
  const winnerLabel = iWon
    ? 'You won!'
    : winners.length === 1
      ? `${publicLeaderboardName(winners[0])} won`
      : `${winners.map((w) => publicLeaderboardName(w)).join(' & ')} tied for the win`;

  return (
    <>
      <Screen scroll bottomSpace={96}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
          <IconButton icon="chevron-left" onPress={onBack} accessibilityLabel="Back" style={{ marginLeft: -4 }} />
          <View style={{ flex: 1 }} />
          {canInvite && (
            <Pressable
              onPress={() => setShowInvite(true)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                backgroundColor: colors.brandTint,
                borderRadius: 99,
                paddingHorizontal: 14,
                paddingVertical: 8,
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <AppIcon name="users" size={15} color={colors.scarlet} />
              <Text variant="label" color={colors.scarlet}>
                Invite
              </Text>
            </Pressable>
          )}
        </View>

        <Text variant="heading" color={colors.ink} style={{ marginBottom: 4 }}>
          {detail.name}
        </Text>
        <Text variant="label" color={colors.textSecondary} style={{ marginBottom: 20, textTransform: 'capitalize' }}>
          {detail.type === 'solo' ? 'Solo challenge' : 'Team challenge'} · {detail.status} · ends{' '}
          {new Date(`${detail.endDate}T00:00:00`).toLocaleDateString()}
        </Text>

        {/* Winner banner — only for finalized challenges that produced a winner */}
        {winners.length > 0 && (
          <Card
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 14,
              marginBottom: 20,
              backgroundColor: colors.gold + '14',
              borderWidth: 1,
              borderColor: colors.gold + '44',
            }}
          >
            <RotatingTrophy size={28} color={colors.gold} />
            <View style={{ flex: 1 }}>
              <Text color={colors.gold} style={{ fontFamily: 'BarlowCondensed_700Bold', fontSize: 22 }}>
                {winnerLabel}
              </Text>
              <Text variant="labelSm" color={colors.textSecondary} style={{ marginTop: 2 }}>
                Final score {winners[0].score} pts
              </Text>
            </View>
          </Card>
        )}

        {/* Standings */}
        <SectionLabel>Standings</SectionLabel>
        {detail.standings.length === 0 ? (
          <Card style={{ marginBottom: 24 }}>
            <Text variant="body" color={colors.textSecondary}>
              No participants yet.
            </Text>
          </Card>
        ) : headToHead ? (
          <Card style={{ marginBottom: 24 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              {teamEntries.slice(0, 2).map(([teamName, t], idx) => (
                <React.Fragment key={teamName}>
                  {idx === 1 && (
                    <Text
                      color={colors.textTertiary}
                      style={{ fontFamily: 'BarlowCondensed_700Bold', fontSize: 22, letterSpacing: 2, paddingHorizontal: 8 }}
                    >
                      VS
                    </Text>
                  )}
                  <View style={{ flex: 1, alignItems: 'center', gap: 8 }}>
                    <Avatar name={t.members[0] ?? teamName} size={64} ring={idx === 0 ? colors.scarlet : undefined} />
                    <Text variant="cardTitle" color={colors.ink} numberOfLines={1}>
                      {teamName}
                    </Text>
                    <Text
                      color={idx === 0 ? colors.scarlet : colors.ink}
                      style={{ fontFamily: 'BarlowCondensed_700Bold', fontSize: 40, lineHeight: 40 }}
                    >
                      {t.score}
                    </Text>
                    {t.members.map((m, i) => (
                      <Text key={i} variant="labelSm" color={colors.textSecondary} numberOfLines={1}>
                        {m}
                      </Text>
                    ))}
                  </View>
                </React.Fragment>
              ))}
            </View>
          </Card>
        ) : (
          <Card style={{ marginBottom: 24, paddingVertical: 4 }}>
            {detail.standings.map((s, i) => {
              const me = s.userId === userId;
              const rankColor = me
                ? colors.scarlet
                : s.rank === 1
                ? colors.gold
                : s.rank === 2
                ? colors.medalSilver
                : s.rank === 3
                ? colors.medalBronze
                : colors.textSecondary;
              return (
                <View key={s.userId}>
                  {i > 0 && <Divider />}
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                      paddingVertical: 12,
                      paddingHorizontal: 12,
                      marginHorizontal: -4,
                      borderRadius: 12,
                      backgroundColor: me ? colors.brandTint : 'transparent',
                    }}
                  >
                    <View style={{ width: 26, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                      {RANK_ICON[s.rank] && (
                        <AppIcon name={RANK_ICON[s.rank]} size={14} color={rankColor} />
                      )}
                      <Text color={rankColor} style={{ fontFamily: 'BarlowCondensed_700Bold', fontSize: 18 }}>
                        {s.rank}
                      </Text>
                    </View>
                    <Avatar name={publicLeaderboardName(s)} size={32} />
                    <Text variant="cardTitle" color={colors.ink} style={{ flex: 1 }} numberOfLines={1}>
                      {publicLeaderboardName(s)}
                      {me ? ' (You)' : ''}
                    </Text>
                    <Text color={colors.ink} style={{ fontFamily: 'BarlowCondensed_700Bold', fontSize: 18 }}>
                      {s.score}
                    </Text>
                  </View>
                </View>
              );
            })}
          </Card>
        )}

        {/* Goals */}
        {detail.goals.length > 0 && (
          <>
            <SectionLabel>Goals</SectionLabel>
            <Card style={{ marginBottom: 24, paddingVertical: 4 }}>
              {detail.goals.map((g, i) => (
                <View key={g.id}>
                  {i > 0 && <Divider />}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 }}>
                    <AppIcon name="target" size={18} color={colors.scarlet} />
                    <Text variant="cardTitle" color={colors.ink} style={{ flex: 1 }}>
                      {g.description}
                    </Text>
                    <View style={{ backgroundColor: colors.scarlet, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                      <Text color={colors.onPrimary} style={{ fontFamily: 'BarlowCondensed_700Bold', fontSize: 12 }}>
                        +{g.pointsValue}
                      </Text>
                    </View>
                  </View>
                </View>
              ))}
            </Card>
          </>
        )}

        {/* Stakes */}
        <Card
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 14,
            marginBottom: 24,
            backgroundColor: colors.goldTint,
          }}
          accent={colors.goldTint}
        >
          <RotatingTrophy size={28} color={colors.gold} />
          <View style={{ flex: 1 }}>
            <Text variant="overline" color={colors.gold}>
              Stakes
            </Text>
            <Text variant="subhead" color={colors.ink}>
              {detail.stakesText || 'Winner takes bragging rights'}
            </Text>
          </View>
        </Card>

        {/* Actions */}
        {detail.joined ? (
          <>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'center',
                alignItems: 'center',
                gap: 8,
                backgroundColor: colors.successTint,
                borderRadius: 14,
                paddingVertical: 14,
              }}
            >
              <AppIcon name="check" size={17} color={colors.successDeep} />
              <Text variant="cardTitle" color={colors.successDeep}>
                You're in this challenge
              </Text>
            </View>
            {detail.status !== 'completed' && (
              <>
                <Button
                  label="Invite friends"
                  variant="secondary"
                  icon="users"
                  onPress={() => setShowInvite(true)}
                  style={{ marginTop: 12 }}
                />
                <Pressable
                  onPress={() => {
                    setDropError(null);
                    setShowDrop(true);
                  }}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    justifyContent: 'center',
                    alignItems: 'center',
                    gap: 8,
                    paddingVertical: 14,
                    marginTop: 8,
                    opacity: pressed ? 0.6 : 1,
                  })}
                  accessibilityRole="button"
                  accessibilityLabel="Drop challenge"
                >
                  <AppIcon name="close" size={16} color={colors.error} />
                  <Text variant="cardTitle" color={colors.error}>
                    Drop challenge
                  </Text>
                </Pressable>
              </>
            )}
          </>
        ) : detail.status !== 'completed' ? (
          <Button label="Join challenge" onPress={handleJoin} loading={joining} loadingLabel="Joining…" />
        ) : (
          <View style={{ alignItems: 'center', paddingVertical: 14 }}>
            <Text variant="cardTitle" color={colors.textSecondary}>
              This challenge has ended
            </Text>
          </View>
        )}
      </Screen>

      <InviteFriendsSheet
        visible={showInvite}
        challengeId={challengeId}
        existingParticipantIds={detail.standings.map((s) => s.userId)}
        onClose={() => setShowInvite(false)}
      />

      <DropChallengeSheet
        visible={showDrop}
        penalty={CHALLENGE_DROP_PENALTY}
        dropping={dropping}
        error={dropError}
        onConfirm={handleLeave}
        onClose={() => {
          if (dropping) return;
          setShowDrop(false);
        }}
      />
    </>
  );
}

// ── Drop Challenge Sheet ──────────────────────────────────

/**
 * Forfeit warning. Dropping an active challenge means you lose it and get docked
 * league points, so we make the cost explicit and require an "I understand" tap
 * before calling leave_challenge. No system alert — an in-app sheet, like the
 * rest of the screen.
 */
function DropChallengeSheet({
  visible,
  penalty,
  dropping,
  error,
  onConfirm,
  onClose,
}: {
  visible: boolean;
  penalty: number;
  dropping: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Sheet visible={visible} onClose={onClose} title="Drop this challenge?" showClose>
      <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 8, gap: 16 }}>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              backgroundColor: colors.brandTint,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <AppIcon name="warning" size={20} color={colors.error} />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="cardTitle" color={colors.ink} style={{ marginBottom: 4 }}>
              You'll lose this challenge.
            </Text>
            <Text variant="body" color={colors.textSecondary}>
              Dropping counts as a forfeit — you lose, and{' '}
              <Text variant="body" color={colors.error}>
                {penalty} league points
              </Text>{' '}
              will be deducted from your leaderboard standing. This can't be undone.
            </Text>
          </View>
        </View>

        {error && (
          <Text variant="label" color={colors.error}>
            {error}
          </Text>
        )}

        <Pressable
          onPress={onConfirm}
          disabled={dropping}
          style={({ pressed }) => ({
            height: 54,
            borderRadius: 14,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            backgroundColor: dropping ? colors.track : colors.error,
            opacity: pressed ? 0.9 : 1,
          })}
          accessibilityRole="button"
          accessibilityLabel={`I understand, drop challenge and lose ${penalty} league points`}
        >
          {dropping ? (
            <ActivityIndicator size="small" color={colors.onPrimary} />
          ) : (
            <AppIcon name="warning" size={18} color={colors.onPrimary} />
          )}
          <Text variant="button" color={colors.onPrimary}>
            {dropping ? 'Dropping…' : `I understand — lose ${penalty} points`}
          </Text>
        </Pressable>

        <Button label="Cancel" variant="secondary" onPress={onClose} disabled={dropping} />
      </View>
    </Sheet>
  );
}

// ── Invite Friends Sheet ──────────────────────────────────

function InviteFriendsSheet({
  visible,
  challengeId,
  existingParticipantIds,
  onClose,
}: {
  visible: boolean;
  challengeId: string;
  existingParticipantIds: string[];
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(true);
  const [invited, setInvited] = useState<Record<string, 'sending' | 'sent'>>({});

  useFocusEffect(
    useCallback(() => {
      if (!visible) return;
      let active = true;
      setLoading(true);
      (async () => {
        try {
          const all = await getFriends();
          if (active) setFriends(all);
        } catch {
          if (active) setFriends([]);
        } finally {
          if (active) setLoading(false);
        }
      })();
      return () => {
        active = false;
      };
    }, [visible]),
  );

  async function invite(friend: Friend) {
    setInvited((m) => ({ ...m, [friend.userId]: 'sending' }));
    try {
      await inviteToChallenge(challengeId, friend.userId);
      setInvited((m) => ({ ...m, [friend.userId]: 'sent' }));
    } catch {
      setInvited((m) => {
        const next = { ...m };
        delete next[friend.userId];
        return next;
      });
    }
  }

  const eligible = friends.filter((f) => !existingParticipantIds.includes(f.userId));

  return (
    <Sheet visible={visible} onClose={onClose} title="Invite friends" showClose scrollable>
      <View style={{ paddingHorizontal: 20, paddingTop: 12 }}>
        {loading ? (
          <ActivityIndicator color={colors.scarlet} style={{ marginVertical: 24 }} />
        ) : eligible.length === 0 ? (
          <Text variant="body" color={colors.textSecondary} style={{ paddingVertical: 16 }}>
            {friends.length === 0
              ? 'Add friends first, then invite them here.'
              : 'All your friends are already in this challenge.'}
          </Text>
        ) : (
          eligible.map((f) => {
            const state = invited[f.userId];
            return (
              <View
                key={f.userId}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 }}
              >
                <Avatar name={f.name} uri={f.avatarUrl} size={40} />
                <Text variant="cardTitle" color={colors.ink} style={{ flex: 1 }} numberOfLines={1}>
                  {f.name}
                </Text>
                <Pressable
                  onPress={() => invite(f)}
                  disabled={!!state}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    borderRadius: 99,
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    backgroundColor: state === 'sent' ? colors.successTint : colors.scarlet,
                  }}
                >
                  {state === 'sent' ? (
                    <AppIcon name="check" size={15} color={colors.successDeep} />
                  ) : (
                    <AppIcon name="plus" size={15} color={colors.onPrimary} />
                  )}
                  <Text
                    variant="label"
                    color={state === 'sent' ? colors.successDeep : colors.onPrimary}
                  >
                    {state === 'sent' ? 'Invited' : state === 'sending' ? '…' : 'Invite'}
                  </Text>
                </Pressable>
              </View>
            );
          })
        )}
      </View>
    </Sheet>
  );
}
