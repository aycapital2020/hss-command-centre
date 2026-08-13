// Vercel function: team coaching performance (admin view).
// Proxies the Internal Sales Coach review feed (hss-closer-coach.vercel.app)
// so the CFO dashboard can show how the sales team is performing on their
// real calls, including the full per-call reviews (feedback + action steps).

const COACH = 'https://hss-closer-coach.vercel.app';

module.exports = async (req, res) => {
  try {
    const r = await fetch(`${COACH}/api/reviews`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`coach feed ${r.status}`);
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'coach feed error');
    const reviews = (data.reviews || []).map((x) => ({
      recording_id: x.recording_id,
      closer_name: x.closer_name || 'Unknown',
      prospect_name: x.prospect_name,
      title: x.title,
      recorded_at: x.recorded_at,
      duration_min: x.duration_min,
      share_url: x.share_url,
      outcome: x.outcome,
      overall: x.overall,
      verdict: x.verdict,
      scores: x.scores,
      summary: x.summary,
      feedback: x.feedback,
      action_steps: x.action_steps,
    }));
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
    return res.status(200).json({ ok: true, coachUrl: COACH, count: reviews.length, reviews });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
};
