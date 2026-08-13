// Reads the Xero snapshot that Viktor's sync job publishes to Vercel Edge Config.
// Edge Config is read-only from here (the connection string is a read token), so
// the dashboard can never mutate finance data — it only serves it.

const DEFAULT_MAX_AGE_HOURS = 36;

async function readXeroSnapshot() {
  const conn = process.env.EDGE_CONFIG_URL || process.env.EDGE_CONFIG;
  if (!conn) return { ok: false, reason: 'edge_config_not_configured' };

  let url;
  try {
    const base = new URL(conn);
    const token = base.searchParams.get('token');
    url = `${base.origin}${base.pathname.replace(/\/$/, '')}/item/xero${token ? `?token=${token}` : ''}`;
  } catch {
    return { ok: false, reason: 'edge_config_url_invalid' };
  }

  let snapshot;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.status === 404) return { ok: false, reason: 'never_synced' };
    if (!res.ok) return { ok: false, reason: `edge_config_http_${res.status}` };
    snapshot = await res.json();
  } catch (err) {
    return { ok: false, reason: `edge_config_error:${String(err && err.message || err)}` };
  }

  if (!snapshot || snapshot.ok !== true || !Array.isArray(snapshot.months) || !snapshot.months.length) {
    return { ok: false, reason: 'snapshot_empty' };
  }

  const maxAge = Number(process.env.XERO_MAX_AGE_HOURS || DEFAULT_MAX_AGE_HOURS);
  const ageHours = snapshot.pulledAt
    ? (Date.now() - new Date(snapshot.pulledAt).getTime()) / 3600000
    : Infinity;
  if (Number.isFinite(maxAge) && ageHours > maxAge) {
    return { ok: false, reason: 'snapshot_stale', ageHours: Math.round(ageHours), snapshot };
  }

  return { ok: true, ageHours: Math.round(ageHours * 10) / 10, snapshot };
}

const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Xero is only allowed to drive the headline numbers if its books actually
// contain the revenue. Her Sales Academy's Xero has expenses flowing in from the
// bank feed but invoices/payments are not posted for every month, so a naive
// switch would wipe ~£200k of real revenue off the dashboard. This compares the
// two sources month by month and reports the gaps instead of hiding them.
const REVENUE_TOLERANCE = 0.9; // Xero must hold >=90% of the sheet's revenue

function reconcile(snapshot, sheet) {
  const sheetMonths = new Map(((sheet && sheet.months) || []).map((m) => [m.full, m]));
  const xeroMonths = new Map(((snapshot && snapshot.months) || []).map((m) => [m.full, m]));
  const names = MONTHS_FULL.filter((n) => sheetMonths.has(n) || xeroMonths.has(n));

  const rows = names.map((full) => {
    const s = sheetMonths.get(full) || {};
    const x = xeroMonths.get(full) || {};
    const sheetRev = Number(s.rev) || 0;
    const xeroRev = Number(x.rev) || 0;
    return {
      full,
      m: full.slice(0, 3),
      sheetRev,
      xeroRev,
      revGap: Math.round((sheetRev - xeroRev) * 100) / 100,
      sheetExpenses: Number(s.expenses) || 0,
      xeroExpenses: Number(x.expenses) || 0,
      inXero: xeroMonths.has(full),
    };
  });

  const missingRevenue = rows.filter((r) => r.sheetRev > 0 && r.xeroRev < r.sheetRev * REVENUE_TOLERANCE);
  const revenueGap = Math.round(missingRevenue.reduce((sum, r) => sum + r.revGap, 0) * 100) / 100;

  return {
    connected: true,
    org: (snapshot && snapshot.tenantName) || null,
    pulledAt: (snapshot && snapshot.pulledAt) || null,
    revenueComplete: missingRevenue.length === 0,
    missingRevenueMonths: missingRevenue.map((r) => r.full),
    revenueGap,
    sheetRevTotal: Math.round(rows.reduce((s, r) => s + r.sheetRev, 0) * 100) / 100,
    xeroRevTotal: Math.round(rows.reduce((s, r) => s + r.xeroRev, 0) * 100) / 100,
    xeroExpenseMonths: rows.filter((r) => r.xeroExpenses > 0).map((r) => r.full),
    rows,
  };
}

// Xero knows the money; the sheet knows how many students produced it.
function mergeWithSheet(snapshot, sheet) {
  const students = new Map(
    ((sheet && sheet.months) || []).map((m) => [m.full, Number(m.students) || 0]),
  );
  const months = snapshot.months.map((m) => ({ ...m, students: students.get(m.full) || 0 }));
  const totalStudents = months.reduce((sum, m) => sum + (m.students || 0), 0);
  return {
    months,
    quarters: snapshot.quarters || [],
    ytd: { ...snapshot.ytd, students: (sheet && sheet.ytd && sheet.ytd.students) || totalStudents },
    cost: snapshot.cost || (sheet && sheet.cost) || null,
    monthCosts: snapshot.monthCosts || {},
    generatedAt: snapshot.pulledAt,
  };
}

module.exports = { readXeroSnapshot, mergeWithSheet, reconcile };
