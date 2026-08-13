// Snapshot store for the live figures.
//
// Reading Whop end to end takes ~20s (700+ payments, 320 memberships, products,
// plans) so the dashboard must never do it during a page load. Instead:
//
//   /api/live          -> newest row from Supabase  (one query, ~100ms)
//   /api/live/refresh  -> recomputes and inserts a row (Vercel cron, 4x a day)
//
// Every row is kept, so the history doubles as a trend table we can chart later.
// Falls back to Edge Config, then to a live read, so a Supabase outage degrades
// to "slow" rather than "broken".

const TABLE = 'cfo_snapshots';

function config() {
  const url = process.env.HSS_SUPABASE_URL;
  const key = process.env.HSS_SUPABASE_SERVICE_KEY;
  return url && key ? { url: url.replace(/\/$/, ''), key } : null;
}

async function readSnapshot() {
  const cfg = config();
  if (!cfg) return { ok: false, reason: 'supabase_not_configured' };
  try {
    const res = await fetch(
      `${cfg.url}/rest/v1/${TABLE}?select=captured_at,payload&order=captured_at.desc&limit=1`,
      { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` }, cache: 'no-store' },
    );
    if (!res.ok) return { ok: false, reason: `supabase_http_${res.status}` };
    const rows = await res.json();
    if (!rows || !rows.length) return { ok: false, reason: 'no_snapshot_yet' };
    const row = rows[0];
    const ageMinutes = (Date.now() - new Date(row.captured_at).getTime()) / 60000;
    return { ok: true, capturedAt: row.captured_at, ageMinutes, payload: row.payload };
  } catch (err) {
    return { ok: false, reason: `supabase_error:${String((err && err.message) || err)}` };
  }
}

async function writeSnapshot(payload) {
  const cfg = config();
  if (!cfg) return { ok: false, reason: 'supabase_not_configured' };
  const res = await fetch(`${cfg.url}/rest/v1/${TABLE}`, {
    method: 'POST',
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify([{ payload }]),
  });
  if (!res.ok) {
    return { ok: false, reason: `supabase_http_${res.status}`, detail: (await res.text()).slice(0, 300) };
  }
  const rows = await res.json();
  return { ok: true, id: rows && rows[0] && rows[0].id, capturedAt: rows && rows[0] && rows[0].captured_at };
}

// Housekeeping: 4 writes a day is ~1,500 rows a year, which is fine, but keep
// the table tidy anyway — one row per hour is plenty of history.
async function prune(keepDays = 400) {
  const cfg = config();
  if (!cfg) return { ok: false };
  const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString();
  const res = await fetch(`${cfg.url}/rest/v1/${TABLE}?captured_at=lt.${cutoff}`, {
    method: 'DELETE',
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
  });
  return { ok: res.ok };
}

module.exports = { readSnapshot, writeSnapshot, prune };
