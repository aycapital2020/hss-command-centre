// Scheduled refresh: pull Whop, Wise and Heartbeat, store one snapshot row.
// Called by the Vercel cron in vercel.json. Also callable by hand with the
// REFRESH_SECRET if we ever need to force it.

const { getLive } = require('../../lib/live');
const { writeSnapshot, prune } = require('../../lib/store');

module.exports = async (req, res) => {
  const url = new URL(req.url, 'https://hss-cfo-dashboard.vercel.app');
  const secret = process.env.REFRESH_SECRET;
  const isCron = Boolean(req.headers['x-vercel-cron']);
  const authorised = isCron || !secret || url.searchParams.get('key') === secret;
  if (!authorised) return res.status(401).json({ ok: false, error: 'unauthorised' });

  const started = Date.now();
  try {
    const data = await getLive();
    if (!data || !data.ok) {
      return res.status(200).json({ ok: false, error: data && (data.whopError || 'live read failed') });
    }
    const stored = await writeSnapshot(data);
    prune().catch(() => {});
    return res.status(200).json({
      ok: stored.ok,
      storedId: stored.id || null,
      capturedAt: stored.capturedAt || null,
      tookSeconds: Math.round((Date.now() - started) / 1000),
      mtdRevenue: data.whop && data.whop.mtdRevenue,
      renewals7d: data.whop && data.whop.renewals7d,
      reason: stored.reason || null,
    });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
};
