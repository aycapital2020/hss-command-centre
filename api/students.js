// Vercel function: student practice leaderboard (admin view).
// The Student Sales Coach app (hss-sales-coach.vercel.app) keeps its
// leaderboard behind per-student logins, so the portal reads the same
// Supabase tables directly, server-side, and rebuilds the ranking.
// Same idea as api/coaching.js: no keys ever reach the browser.
//
// Env needed (Vercel project settings, ask Viktor):
//   HSS_COACH_SUPABASE_URL          e.g. https://xxxx.supabase.co
//   HSS_COACH_SUPABASE_SERVICE_KEY  service role key of the coach app

const TRACK_HINTS = ['setter', 'booking', 'triage', 'dm '];

function agentTrack(agent) {
  const haystack = `${agent.role || ''} ${agent.name || ''} ${agent.background || ''}`.toLowerCase();
  return TRACK_HINTS.some((h) => haystack.includes(h)) ? 'setter' : 'closer';
}

function sb() {
  const url = (process.env.HSS_COACH_SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.HSS_COACH_SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('coach_supabase_not_configured');
  return { url, key };
}

async function rows(table, select, filter) {
  const { url, key } = sb();
  const qs = new URLSearchParams({ select });
  if (filter) for (const [k, v] of Object.entries(filter)) qs.set(k, v);
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${url}/rest/v1/${table}?${qs}`, {
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        Range: `${from}-${from + 999}`, 'Range-Unit': 'items',
      },
      cache: 'no-store',
    });
    if (!r.ok) throw new Error(`${table} ${r.status}`);
    const page = await r.json();
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

module.exports = async (req, res) => {
  try {
    const window = (req.query || {}).window === 'week' ? 'week' : 'all';
    const since = window === 'week' ? new Date(Date.now() - 7 * 86400e3).toISOString() : null;

    const [profiles, allSessions, scores, agents] = await Promise.all([
      rows('salesbot_profiles', 'id,email,full_name'),
      rows('salesbot_sessions', 'id,user_id,agent_id,mode,ended_at', { status: 'eq.completed' }),
      rows('salesbot_session_scores', 'session_id,total_score'),
      rows('salesbot_agents', 'id,name,role,background'),
    ]);

    const sessions = since ? allSessions.filter((s) => s.ended_at && s.ended_at >= since) : allSessions;
    const scoreBySession = new Map(scores
      .filter((s) => typeof s.total_score === 'number')
      .map((s) => [s.session_id, Number(s.total_score)]));
    const trackByAgent = new Map(agents.map((a) => [a.id, agentTrack(a)]));
    const nameById = new Map(profiles.map((p) => [
      p.id, p.full_name || (p.email ? p.email.split('@')[0] : 'Student'),
    ]));

    const boards = { setter: new Map(), closer: new Map() };
    for (const sess of sessions) {
      const track = sess.mode === 'dm_chat' ? 'setter' : (trackByAgent.get(sess.agent_id) || 'closer');
      const board = boards[track];
      const row = board.get(sess.user_id) || {
        userId: sess.user_id, name: nameById.get(sess.user_id) || 'Student',
        sessions: 0, dmSessions: 0, scored: 0,
        avgScore: null, bestScore: null, lastPracticedAt: null, badges: [],
      };
      row.sessions += 1;
      if (sess.mode === 'dm_chat') row.dmSessions += 1;
      if (sess.ended_at && (!row.lastPracticedAt || sess.ended_at > row.lastPracticedAt)) {
        row.lastPracticedAt = sess.ended_at;
      }
      const score = scoreBySession.get(sess.id);
      if (score !== undefined) {
        const total = (row.avgScore ?? 0) * row.scored + score;
        row.scored += 1;
        row.avgScore = Math.round((total / row.scored) * 10) / 10;
        row.bestScore = row.bestScore === null ? score : Math.max(row.bestScore, score);
      }
      board.set(sess.user_id, row);
    }

    // Badges, always from all-time data (same rules as the coach app).
    const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString();
    const daysByUser = new Map();
    const dmWeekByUser = new Map();
    const totalByUser = new Map();
    const bestByUser = new Map();
    for (const sess of allSessions) {
      if (sess.ended_at) {
        const day = sess.ended_at.slice(0, 10);
        if (!daysByUser.has(sess.user_id)) daysByUser.set(sess.user_id, new Set());
        daysByUser.get(sess.user_id).add(day);
        if (sess.mode === 'dm_chat' && sess.ended_at >= weekAgo) {
          dmWeekByUser.set(sess.user_id, (dmWeekByUser.get(sess.user_id) || 0) + 1);
        }
      }
      totalByUser.set(sess.user_id, (totalByUser.get(sess.user_id) || 0) + 1);
      const sc = scoreBySession.get(sess.id);
      if (sc !== undefined) bestByUser.set(sess.user_id, Math.max(bestByUser.get(sess.user_id) || 0, sc));
    }

    const dayStr = (d) => d.toISOString().slice(0, 10);
    const streakDays = (userId) => {
      const days = daysByUser.get(userId);
      if (!days) return 0;
      let cursor = new Date();
      if (!days.has(dayStr(cursor))) cursor = new Date(cursor.getTime() - 86400e3);
      let count = 0;
      while (days.has(dayStr(cursor))) { count += 1; cursor = new Date(cursor.getTime() - 86400e3); }
      return count;
    };
    const badgesFor = (userId) => {
      const out = [];
      const streak = streakDays(userId);
      if (streak >= 2) out.push(`\u{1F525} ${streak}-day streak`);
      const dm = dmWeekByUser.get(userId) || 0;
      if (dm >= 5) out.push(`\u{1F4AC} ${dm} DMs this week`);
      if ((bestByUser.get(userId) || 0) >= 85) out.push('\u{1F3AF} 85+ scorer');
      const total = totalByUser.get(userId) || 0;
      if (total >= 25) out.push('\u{1F3C6} 25 sessions');
      else if (total >= 10) out.push('\u{1F3C5} 10 sessions');
      return out;
    };
    for (const board of [boards.setter, boards.closer]) {
      for (const row of board.values()) row.badges = badgesFor(row.userId);
    }

    const rank = (m) => Array.from(m.values()).sort((a, b) => {
      if (a.avgScore !== null && b.avgScore !== null && a.avgScore !== b.avgScore) return b.avgScore - a.avgScore;
      if ((a.avgScore !== null) !== (b.avgScore !== null)) return a.avgScore !== null ? -1 : 1;
      return b.sessions - a.sessions;
    });

    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
    return res.status(200).json({
      ok: true,
      coachUrl: 'https://hss-sales-coach.vercel.app',
      window,
      setter: rank(boards.setter),
      closer: rank(boards.closer),
    });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
};
