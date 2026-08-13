// Vercel function: sales-sheet data (weekly funnel + Monday Scorecard).
// Backed by Vicky's own sheets — the numbers her setters/closers fill in.
// Cached for 30 minutes at the edge so page loads stay instant.

const { getSales } = require('../lib/sales');

module.exports = async (req, res) => {
  try {
    const data = await getSales();
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=14400');
    return res.status(200).json(data);
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
};
