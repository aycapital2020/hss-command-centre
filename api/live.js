// Live Whop + Wise + Heartbeat figures for the dashboard.
//
// Reads the newest stored snapshot (fast). Only computes from scratch if there
// is no snapshot at all, or if ?fresh=1 is passed. The refresh itself runs on a
// schedule via /api/live/refresh, so a page load never waits on Whop.

const { getLive } = require('../lib/live');
const { readSnapshot, writeSnapshot } = require('../lib/store');

const MAX_AGE_MINUTES = Number(process.env.LIVE_MAX_AGE_MINUTES || 24 * 60);

module.exports = async (req, res) => {
  const url = new URL(req.url, 'https://hss-cfo-dashboard.vercel.app');
  const forceFresh = url.searchParams.get('fresh') === '1';

  if (!forceFresh) {
    const stored = await readSnapshot();
    if (stored.ok && stored.payload) {
      const stale = stored.ageMinutes > MAX_AGE_MINUTES;
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
      return res.status(200).json({
        ...stored.payload,
        pulledAt: stored.capturedAt,
        readFrom: 'snapshot',
        ageMinutes: Math.round(stored.ageMinutes),
        stale,
      });
    }
  }

  // No snapshot (or a forced refresh): compute, store it for next time, return it.
  try {
    const data = await getLive();
    if (data && data.ok) writeSnapshot(data).catch(() => {});
    res.setHeader('Cache-Control', forceFresh ? 'no-store' : 'public, s-maxage=300');
    return res.status(200).json({ ...data, readFrom: 'live', ageMinutes: 0, stale: false });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
};
