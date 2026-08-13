// Vercel serverless function: returns the live P&L dashboard data as JSON.
// Source of truth order:
//   1. Xero (live accounting data, published to Edge Config by Viktor's sync job)
//   2. the "P & L 2025" Google Sheet (Vicky's manual workbook) — fallback, and
//      always the source for student counts
// Cached at the edge for 4 hours (s-maxage=14400); a Vercel Cron (vercel.json)
// pings this to keep it warm.

const { getPnlData } = require('../lib/pnl');
const { readXeroSnapshot, mergeWithSheet, reconcile } = require('../lib/xero');

const DEFAULT_SHEET_ID = '1gGaQXHeQNo25EmtyN8CB2CL1155Gy1nmLX5LiaRbo10'; // "P & L 2025"

async function readSheet() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set');
  return getPnlData({
    credentials: JSON.parse(raw),
    sheetId: process.env.SHEET_ID || DEFAULT_SHEET_ID,
  });
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'https://hss-cfo-dashboard.vercel.app');
  const forced = url.searchParams.get('source'); // 'sheet' | 'xero' | null

  const [sheetOutcome, xeroOutcome] = await Promise.allSettled([
    readSheet(),
    forced === 'sheet' ? Promise.resolve({ ok: false, reason: 'forced_sheet' }) : readXeroSnapshot(),
  ]);

  const sheet = sheetOutcome.status === 'fulfilled' ? sheetOutcome.value : null;
  const sheetError = sheetOutcome.status === 'rejected'
    ? String(sheetOutcome.reason && sheetOutcome.reason.message || sheetOutcome.reason)
    : null;
  const xero = xeroOutcome.status === 'fulfilled'
    ? xeroOutcome.value
    : { ok: false, reason: String(xeroOutcome.reason && xeroOutcome.reason.message || xeroOutcome.reason) };

  try {
    // Xero drives the dashboard only when its books hold the revenue too.
    // Otherwise the sheet keeps the headline numbers and we surface the gap.
    const recon = xero.ok ? reconcile(xero.snapshot, sheet) : null;

    if (xero.ok && (forced === 'xero' || !sheet || recon.revenueComplete)) {
      const merged = mergeWithSheet(xero.snapshot, sheet);
      res.setHeader('Cache-Control', 'public, s-maxage=14400, stale-while-revalidate=86400');
      return res.status(200).json({
        ok: true,
        source: 'xero',
        org: xero.snapshot.tenantName || null,
        xeroAgeHours: xero.ageHours,
        sheetAvailable: Boolean(sheet),
        xero: recon,
        ...merged,
      });
    }

    if (xero.ok && sheet) {
      res.setHeader('Cache-Control', 'public, s-maxage=14400, stale-while-revalidate=86400');
      return res.status(200).json({
        ok: true,
        source: 'sheet',
        xeroStatus: 'connected_books_incomplete',
        xeroAgeHours: xero.ageHours,
        xero: recon,
        ...sheet,
      });
    }

    if (!sheet) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(500).json({
        ok: false,
        source: 'none',
        error: sheetError || 'sheet unavailable',
        xeroStatus: xero.reason,
      });
    }

    res.setHeader('Cache-Control', 'public, s-maxage=14400, stale-while-revalidate=86400');
    return res.status(200).json({
      ok: true,
      source: 'sheet',
      xeroStatus: xero.reason || 'unavailable',
      ...sheet,
    });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
};
