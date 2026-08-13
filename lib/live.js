// Live "right now" metrics, straight from the systems the money moves through:
//   Whop  — every payment and membership (revenue, renewals, members, churn)
//   Wise  — cash balances
// Called server-side on each dashboard load (edge-cached, see api/live.js), so
// nothing here is ever a hand-typed snapshot. If a call fails we say so rather
// than showing a stale number.

const { whopDetail, heartbeatDetail } = require('./detail');

const WHOP_API = 'https://api.whop.com/api/v2';
const WISE_API = 'https://api.transferwise.com';
const DAY = 86400;

// Removed from the dashboard at Victoria's request (11 Aug 2026): dead
// checkout attempts that are not real recoverable money.
const HIDDEN_PEOPLE = ['alana knight'];

async function fxToGbp() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/GBP', { cache: 'no-store' });
    const data = await res.json();
    if (data && data.result === 'success' && data.rates) {
      const rates = { GBP: 1 };
      for (const [c, v] of Object.entries(data.rates)) if (v) rates[c] = 1 / Number(v);
      return { rates, source: 'exchangerate-api' };
    }
  } catch { /* fall through */ }
  try {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=GBP', { cache: 'no-store' });
    const data = await res.json();
    const rates = { GBP: 1 };
    for (const [c, v] of Object.entries((data && data.rates) || {})) if (v) rates[c] = 1 / Number(v);
    return { rates, source: 'frankfurter' };
  } catch {
    return { rates: { GBP: 1 }, source: 'gbp_only' };
  }
}

const gbp = (amount, currency, rates) => {
  const rate = rates[String(currency || 'GBP').toUpperCase()];
  return rate ? Number(amount || 0) * rate : 0;
};

async function whopPages(key, resource, cap = 60) {
  const out = [];
  for (let page = 1; page <= cap; page++) {
    const res = await fetch(`${WHOP_API}/${resource}?per=50&page=${page}`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`whop ${resource} http_${res.status}`);
    const data = await res.json();
    out.push(...((data && data.data) || []));
    const pages = (data && data.pagination && data.pagination.total_page) || 1;
    if (page >= pages) break;
  }
  return out;
}

const net = (p) => Number(p.final_amount || 0) - Number(p.refunded_amount || 0);
const monthKey = (ts) => new Date(ts * 1000).toISOString().slice(0, 7);

async function whopMetrics(key, rates) {
  const [payments, members] = await Promise.all([
    whopPages(key, 'payments'),
    whopPages(key, 'memberships'),
  ]);

  const paid = payments.filter((p) => p.status === 'paid' && p.paid_at);
  const months = {};
  for (const p of paid) {
    const k = monthKey(p.paid_at);
    months[k] = (months[k] || 0) + gbp(net(p), p.currency, rates);
  }

  const now = new Date();
  const ts = Date.now() / 1000;
  const thisMonth = now.toISOString().slice(0, 7);
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
  const day = now.getUTCDate();
  const mtd = months[thisMonth] || 0;

  const active = members.filter((m) => m.status === 'active');
  const cancelled = members.filter((m) => m.status === 'canceled');
  const ending = (list, lo, hi) => list.filter((m) => {
    const end = m.renewal_period_end;
    return end && end - ts >= lo && end - ts <= hi;
  });
  const renew7 = ending(active, 0, 7 * DAY);
  const leaving30 = ending(cancelled, 0, 30 * DAY);
  const left30 = ending(cancelled, -30 * DAY, 0);

  const lastByMembership = {};
  for (const p of [...paid].sort((a, b) => a.paid_at - b.paid_at)) {
    if (p.membership) lastByMembership[p.membership] = p;
  }
  let renewValue = 0;
  for (const m of renew7) {
    const p = lastByMembership[m.id];
    if (p) renewValue += gbp(net(p), p.currency, rates);
  }

  const byId = {};
  for (const m of members) byId[m.id] = m;
  // People Victoria has asked to remove from the chase list (dead checkouts,
  // not real recoverable money). Matched on the billing name Whop recorded.
  const hiddenName = (p) => HIDDEN_PEOPLE.includes(
    [p.billing_first_name, p.billing_last_name].filter(Boolean).join(' ').trim().toLowerCase(),
  );
  let atRisk = 0; let atRiskMembers = 0; let atRiskCheckouts = 0; let atRiskCount = 0;
  for (const p of payments) {
    if (p.status !== 'open' || Number(p.payments_failed || 0) <= 0) continue;
    if (!p.last_payment_attempt || ts - p.last_payment_attempt > 30 * DAY) continue;
    if (hiddenName(p)) continue;
    const value = gbp(Number(p.final_amount || 0), p.currency, rates);
    atRisk += value; atRiskCount += 1;
    const m = byId[p.membership || ''];
    if (m && ['active', 'past_due', 'completed'].includes(m.status)) atRiskMembers += value;
    else atRiskCheckouts += value;
  }

  const perUser = {};
  for (const p of paid) perUser[p.user] = (perUser[p.user] || 0) + gbp(net(p), p.currency, rates);
  const customers = Object.keys(perUser).length;
  const ltv = customers
    ? Object.values(perUser).reduce((a, b) => a + b, 0) / customers
    : 0;

  const base = active.length + left30.length;
  const round = (n) => Math.round(n * 100) / 100;

  return {
    months: Object.fromEntries(Object.entries(months).sort().map(([k, v]) => [k, round(v)])),
    mtdRevenue: round(mtd),
    mtdMonth: now.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    mtdAsOfDay: day,
    daysInMonth,
    projectedRevenue: round((mtd / day) * daysInMonth),
    activeSubscriptions: active.length,
    membersWithAccess: members.filter((m) => m.valid).length,
    pastDue: members.filter((m) => m.status === 'past_due').length,
    renewals7d: renew7.length,
    renewals7dValue: round(renewValue),
    leaving30d: leaving30.length,
    left30d: left30.length,
    churn30d: base ? round((left30.length / base) * 100) : 0,
    ltv: round(ltv),
    payingCustomers: customers,
    atRisk: round(atRisk),
    atRiskCount,
    atRiskMembers: round(atRiskMembers),
    atRiskCheckouts: round(atRiskCheckouts),
    paymentsSeen: payments.length,
    membershipsSeen: members.length,
    lastPaymentAt: paid.length
      ? new Date(Math.max(...paid.map((p) => p.paid_at)) * 1000).toISOString()
      : null,
  };
}

async function wiseCash(token, rates) {
  const res = await fetch(`${WISE_API}/v1/profiles`, {
    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
  });
  if (!res.ok) throw new Error(`wise profiles http_${res.status}`);
  const profiles = await res.json();
  const balances = [];
  let total = 0;
  for (const prof of profiles) {
    const r = await fetch(`${WISE_API}/v4/profiles/${prof.id}/balances?types=STANDARD`, {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
    });
    if (!r.ok) continue;
    for (const bal of (await r.json()) || []) {
      const value = Number((bal.amount && bal.amount.value) || 0);
      if (value <= 0) continue;
      const asGbp = gbp(value, bal.currency, rates);
      total += asGbp;
      balances.push({
        profile: prof.type,
        currency: bal.currency,
        amount: Math.round(value * 100) / 100,
        gbp: Math.round(asGbp * 100) / 100,
      });
    }
  }
  balances.sort((a, b) => b.gbp - a.gbp);
  return { totalGbp: Math.round(total * 100) / 100, balances };
}

// Fallback: the snapshot live_sync.py publishes to Edge Config, used only when
// a live API call fails. Carries its own timestamp so the UI can age it.
async function readLiveSnapshot() {
  const conn = process.env.EDGE_CONFIG_URL || process.env.EDGE_CONFIG;
  if (!conn) return null;
  try {
    const base = new URL(conn);
    const token = base.searchParams.get('token');
    const url = `${base.origin}${base.pathname.replace(/\/$/, '')}/item/live${token ? `?token=${token}` : ''}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const snap = await res.json();
    return snap && snap.ok ? snap : null;
  } catch {
    return null;
  }
}

async function getLive() {
  const whopKey = process.env.WHOP_API_KEY;
  const wiseToken = process.env.WISE_API_TOKEN;
  const { rates, source: fxSource } = await fxToGbp();

  const [whopOut, wiseOut] = await Promise.allSettled([
    whopKey ? whopMetrics(whopKey, rates) : Promise.reject(new Error('whop_key_missing')),
    wiseToken ? wiseCash(wiseToken, rates) : Promise.reject(new Error('wise_token_missing')),
  ]);

  const payload = {
    ok: whopOut.status === 'fulfilled',
    live: whopOut.status === 'fulfilled',
    pulledAt: new Date().toISOString(),
    fx: { source: fxSource, usd: rates.USD ? Math.round(rates.USD * 1e4) / 1e4 : null },
  };

  if (whopOut.status === 'fulfilled') payload.whop = whopOut.value;
  else payload.whopError = String((whopOut.reason && whopOut.reason.message) || whopOut.reason);

  if (wiseOut.status === 'fulfilled') payload.wise = wiseOut.value;
  else payload.wiseError = String((wiseOut.reason && wiseOut.reason.message) || wiseOut.reason);

  // Detail rows + community, so every headline number has its list behind it.
  if (payload.whop) {
    try {
      const detail = await whopDetail(whopKey, rates);
      payload.detail = detail;
      const hbKey = process.env.HEARTBEAT_API_KEY;
      if (hbKey) {
        try {
          payload.community = await heartbeatDetail(hbKey, detail.currentlyPaying, detail.everPaid);
        } catch (err) {
          payload.communityError = String((err && err.message) || err);
        }
      } else {
        payload.communityError = 'heartbeat_key_missing';
      }
      // don't ship raw email lists to the browser
      delete payload.detail.currentlyPaying;
      delete payload.detail.everPaid;
    } catch (err) {
      payload.detailError = String((err && err.message) || err);
    }
  }

  if (!payload.whop) {
    const snap = await readLiveSnapshot();
    if (snap && snap.whop) {
      return {
        ...snap,
        ok: true,
        live: false,
        fallback: 'edge_snapshot',
        liveError: payload.whopError || null,
      };
    }
  }
  return payload;
}

module.exports = { getLive, whopMetrics, wiseCash, fxToGbp };
