// The working detail behind the headline numbers: who is renewing, whose card
// failed, who cancelled, what sells, and how the paying list compares to the
// Heartbeat community. Everything is derived from one Whop fetch plus Heartbeat.
//
// Design rule for this file: no metric without the rows behind it. If the
// dashboard shows "11 past due", the same payload carries the 11 names.

const WHOP_API = 'https://api.whop.com/api/v2';
const HEARTBEAT_API = 'https://api.heartbeat.chat/v0';
const DAY = 86400;

// Removed from the dashboard at Victoria's request (11 Aug 2026): dead
// checkout attempts that are not real recoverable money.
const HIDDEN_PEOPLE = ['alana knight'];

const round2 = (n) => Math.round(n * 100) / 100;
const dayKey = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
const net = (p) => Number(p.final_amount || 0) - Number(p.refunded_amount || 0);

const gbpOf = (amount, currency, rates) => {
  const rate = rates[String(currency || 'GBP').toUpperCase()];
  return rate ? Number(amount || 0) * rate : 0;
};

async function whopPages(key, resource, cap = 60) {
  const out = [];
  for (let page = 1; page <= cap; page++) {
    const res = await fetch(`${WHOP_API}/${resource}?per=50&page=${page}`, {
      headers: { Authorization: `Bearer ${key}` }, cache: 'no-store',
    });
    if (!res.ok) throw new Error(`whop ${resource} http_${res.status}`);
    const data = await res.json();
    out.push(...((data && data.data) || []));
    const pages = (data && data.pagination && data.pagination.total_page) || 1;
    if (page >= pages) break;
  }
  return out;
}

function programOf(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('closer') || n.includes('closing')) return 'Closer';
  if (n.includes('setter') || n.includes('setting')) return 'Setter';
  if (n.includes('mentor') || n.includes('mastermind')) return 'Mentorship';
  return 'Other';
}

function structureOf(name, plan) {
  const n = String(name || '').toLowerCase();
  if (n.includes('split') || n.includes('instal')) return 'Payment plan';
  if (n.includes('pif') || n.includes('full')) return 'Paid in full';
  if (plan && plan.plan_type === 'one_time') return 'Paid in full';
  return 'Payment plan';
}

const personName = (p) => [p.billing_first_name, p.billing_last_name]
  .filter(Boolean).join(' ').trim() || null;

// --------------------------------------------------------------------- Whop
async function whopDetail(key, rates) {
  const [payments, members, products, plans] = await Promise.all([
    whopPages(key, 'payments'),
    whopPages(key, 'memberships'),
    whopPages(key, 'products'),
    whopPages(key, 'plans'),
  ]);

  const productById = {};
  for (const p of products) productById[p.id] = p;
  const planById = {};
  for (const p of plans) planById[p.id] = p;
  const memberById = {};
  for (const m of members) memberById[m.id] = m;

  const paid = payments.filter((p) => p.status === 'paid' && p.paid_at);
  const ts = Date.now() / 1000;

  // ---- daily revenue: lets the UI answer ANY date range, not just months
  const daily = {};
  for (const p of paid) {
    const k = dayKey(p.paid_at);
    daily[k] = round2((daily[k] || 0) + gbpOf(net(p), p.currency, rates));
  }

  // ---- what sells: program and payment structure, last 90 days and all time
  const mix = { program: {}, structure: {}, program90: {}, structure90: {} };
  for (const p of paid) {
    const product = productById[p.product] || {};
    const name = product.name;
    const value = gbpOf(net(p), p.currency, rates);
    const prog = programOf(name);
    const struct = structureOf(name, planById[p.plan]);
    mix.program[prog] = round2((mix.program[prog] || 0) + value);
    mix.structure[struct] = round2((mix.structure[struct] || 0) + value);
    if (ts - p.paid_at <= 90 * DAY) {
      mix.program90[prog] = round2((mix.program90[prog] || 0) + value);
      mix.structure90[struct] = round2((mix.structure90[struct] || 0) + value);
    }
  }

  // ---- last real payment per membership, used to value a renewal
  const lastPaid = {};
  for (const p of [...paid].sort((a, b) => a.paid_at - b.paid_at)) {
    if (p.membership) lastPaid[p.membership] = p;
  }

  const rowFor = (m, extra = {}) => {
    const p = lastPaid[m.id];
    const product = productById[m.product] || {};
    return {
      email: m.email || null,
      name: p ? personName(p) : null,
      product: product.name || null,
      program: programOf(product.name),
      amount: p ? round2(gbpOf(net(p), p.currency, rates)) : null,
      renewsAt: m.renewal_period_end ? new Date(m.renewal_period_end * 1000).toISOString() : null,
      manageUrl: m.manage_url || null,
      ...extra,
    };
  };

  const active = members.filter((m) => m.status === 'active');
  const cancelled = members.filter((m) => m.status === 'canceled');
  const inWindow = (list, lo, hi) => list.filter((m) => m.renewal_period_end
    && m.renewal_period_end - ts >= lo && m.renewal_period_end - ts <= hi);

  const renewals = inWindow(active, 0, 30 * DAY)
    .sort((a, b) => a.renewal_period_end - b.renewal_period_end)
    .map((m) => rowFor(m));

  const leaving = inWindow(cancelled, 0, 30 * DAY)
    .sort((a, b) => a.renewal_period_end - b.renewal_period_end)
    .map((m) => rowFor(m, { endsAt: new Date(m.renewal_period_end * 1000).toISOString() }));

  const left = inWindow(cancelled, -30 * DAY, 0)
    .sort((a, b) => b.renewal_period_end - a.renewal_period_end)
    .map((m) => rowFor(m, { endedAt: new Date(m.renewal_period_end * 1000).toISOString() }));

  // ---- declined and still unpaid in the last 30 days, with the reason
  const declined = [];
  for (const p of payments) {
    if (p.status !== 'open' || Number(p.payments_failed || 0) <= 0) continue;
    if (!p.last_payment_attempt || ts - p.last_payment_attempt > 30 * DAY) continue;
    if (HIDDEN_PEOPLE.includes((personName(p) || '').toLowerCase())) continue;
    const m = memberById[p.membership || ''];
    const product = productById[p.product] || {};
    declined.push({
      email: (m && m.email) || null,
      name: personName(p),
      amount: round2(gbpOf(Number(p.final_amount || 0), p.currency, rates)),
      product: product.name || null,
      attempts: Number(p.payments_failed || 0),
      lastAttempt: new Date(p.last_payment_attempt * 1000).toISOString(),
      reason: (p.failure_message || '').slice(0, 140) || null,
      stillAMember: Boolean(m && ['active', 'past_due', 'completed'].includes(m.status)),
      membershipStatus: (m && m.status) || 'no membership (checkout never completed)',
    });
  }
  declined.sort((a, b) => b.amount - a.amount);

  // ---- top customers by lifetime spend
  const spend = {};
  for (const p of paid) {
    const m = memberById[p.membership || ''];
    const key = (m && m.email) || p.user;
    if (!spend[key]) spend[key] = { who: key, total: 0, payments: 0, name: personName(p) };
    spend[key].total = round2(spend[key].total + gbpOf(net(p), p.currency, rates));
    spend[key].payments += 1;
    if (!spend[key].name) spend[key].name = personName(p);
  }
  const topCustomers = Object.values(spend).sort((a, b) => b.total - a.total).slice(0, 15);

  // Two different questions, two different sets:
  //  - currentlyPaying: an open subscription right now (active / in dunning).
  //    Used to find people who pay but have no community account.
  //  - everPaid: anyone who ever bought, including one-off and lapsed.
  //    Used so alumni aren't flagged as freeloaders.
  const currentlyPaying = new Set(members
    .filter((m) => ['active', 'past_due'].includes(m.status) && m.email)
    .map((m) => m.email.toLowerCase()));
  const everPaid = new Set(members.filter((m) => m.email).map((m) => m.email.toLowerCase()));

  return {
    daily,
    mix,
    renewals,
    leaving,
    left,
    declined,
    topCustomers,
    currentlyPaying: [...currentlyPaying],
    everPaid: [...everPaid],
    counts: {
      payments: payments.length,
      memberships: members.length,
      products: products.length,
      active: active.length,
      pastDue: members.filter((m) => m.status === 'past_due').length,
      withAccess: members.filter((m) => m.valid).length,
    },
  };
}

// ----------------------------------------------------------------- Heartbeat
const TEST_ACCOUNT = /@example\.com$|@test\.|(^|\s)test[- ]?user/i;

async function heartbeatDetail(key, currentlyPaying, everPaid) {
  const headers = { Authorization: `Bearer ${key}` };
  const [usersRes, groupsRes] = await Promise.all([
    fetch(`${HEARTBEAT_API}/users?limit=500`, { headers, cache: 'no-store' }),
    fetch(`${HEARTBEAT_API}/groups`, { headers, cache: 'no-store' }),
  ]);
  if (!usersRes.ok) throw new Error(`heartbeat users http_${usersRes.status}`);
  const users = await usersRes.json();
  const groups = groupsRes.ok ? await groupsRes.json() : [];

  const members = users.filter((u) => !u.isAdmin
    && !TEST_ACCOUNT.test(u.email || '') && !TEST_ACCOUNT.test(u.name || ''));
  const joinsByDay = {};
  for (const u of users) {
    if (!u.createdAt) continue;
    const k = String(u.createdAt).slice(0, 10);
    joinsByDay[k] = (joinsByDay[k] || 0) + 1;
  }

  const paying = new Set((currentlyPaying || []).map((e) => e.toLowerCase()));
  const paidEver = new Set((everPaid || []).map((e) => e.toLowerCase()));
  const communityEmails = new Set(members.map((u) => (u.email || '').toLowerCase()).filter(Boolean));

  // The two gaps that cost real money, both only visible because Whop and
  // Heartbeat are connected at the same time.
  // Never bought anything at all — the ones actually worth checking.
  const inCommunityNotPaying = members
    .filter((u) => u.email && !paidEver.has(u.email.toLowerCase()))
    .map((u) => ({ name: u.name, email: u.email, joined: u.createdAt }));
  const payingNotInCommunity = [...paying]
    .filter((e) => !communityEmails.has(e));

  const courseGroups = groups
    .filter((g) => !g.archived)
    .map((g) => ({ name: String(g.name || '').trim(), members: (g.users || []).length }))
    .sort((a, b) => b.members - a.members)
    .slice(0, 12);

  return {
    totalUsers: users.length,
    members: members.length,
    admins: users.filter((u) => u.isAdmin).length,
    joinsByDay,
    courseGroups,
    inCommunityNotPaying: inCommunityNotPaying.slice(0, 50),
    inCommunityNotPayingCount: inCommunityNotPaying.length,
    payingNotInCommunity: payingNotInCommunity.slice(0, 50),
    payingNotInCommunityCount: payingNotInCommunity.length,
  };
}

module.exports = { whopDetail, heartbeatDetail };
