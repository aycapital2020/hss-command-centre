// Failed payment messages ("dunning"), asked for by Tiffany and approved by
// Victoria on 11 Aug 2026: the moment a Whop payment fails, the student gets
// a Heartbeat DM (from AI Vicky) and an email (from Victoria's Gmail, the same
// account that sends the certificates), telling them how to fix their card.
//
// Runs on a Vercel cron (see vercel.json). Each failed payment is messaged
// exactly ONCE (keyed on the Whop payment id) and recorded in the
// `dunning_alerts` Supabase table, so retries and later attempts on the same
// invoice never spam the student. Historic failures were seeded as
// already-handled at go-live, because Tiffany chased those by hand.
//
// Modes (all need ?key=REFRESH_SECRET):
//   /api/dunning                 normal run: message anything new
//   /api/dunning?dry=1           show what would be sent, send nothing
//   /api/dunning?seed=1          mark everything currently failed as handled
//   /api/dunning?test=a@b.com    send ONE sample DM+email to that address only

const nodemailer = require('nodemailer');

const WHOP_API = 'https://api.whop.com/api/v2';
const HEARTBEAT_API = 'https://api.heartbeat.chat/v0';
const AI_VICKY_ID = 'b0c7b4a4-4ae3-4104-8bf2-de5cb0462b83';
const DAY = 86400;
const TABLE = 'dunning_alerts';

// Same rule as the dashboard: dead checkout attempts Victoria asked to hide.
const HIDDEN_PEOPLE = ['alana knight'];

const CURRENCY_SIGN = { gbp: '\u00a3', usd: '$', eur: '\u20ac', aud: 'A$', cad: 'C$' };
const money = (amount, currency) => {
  const sign = CURRENCY_SIGN[String(currency || 'gbp').toLowerCase()] || `${String(currency || '').toUpperCase()} `;
  return `${sign}${Number(amount || 0).toFixed(2).replace(/\.00$/, '')}`;
};

const personName = (p) => [p.billing_first_name, p.billing_last_name]
  .filter(Boolean).join(' ').trim() || null;
const firstName = (p, m) => (p.billing_first_name || '').trim()
  || ((m && m.email) ? '' : '') || 'there';

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

// ------------------------------------------------------------------ Supabase
function sb() {
  const url = (process.env.HSS_SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.HSS_SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('supabase_not_configured');
  return { url, key };
}

async function alreadySent() {
  const { url, key } = sb();
  const res = await fetch(`${url}/rest/v1/${TABLE}?select=payment_id`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: 'no-store',
  });
  if (!res.ok) throw new Error(`supabase_read_http_${res.status}`);
  return new Set((await res.json()).map((r) => r.payment_id));
}

async function record(rows) {
  if (!rows.length) return { ok: true, inserted: 0 };
  const { url, key } = sb();
  const res = await fetch(`${url}/rest/v1/${TABLE}`, {
    method: 'POST',
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`supabase_write_http_${res.status}:${(await res.text()).slice(0, 200)}`);
  return { ok: true, inserted: rows.length };
}

// ------------------------------------------------------------------ Messages
function buildCopy(row) {
  const fix = 'No need to do anything on your end. It will retry automatically in the next day or two, so just make sure the card on file has the funds available and it will go through on its own.';
  const dm = `Hey ${row.first}! Quick heads up from the HSS team. Your latest payment of ${row.pretty} for ${row.product || 'your programme'} didn't go through. The bank said: "${row.reason || 'payment declined'}". It's usually just insufficient funds at that moment or a temporary bank block, nothing to worry about. ${fix} Any questions at all, just reply here and we'll sort it together!`;
  const email = [
    `Hey ${row.first}!`,
    '',
    `Just a quick heads up. Your latest payment of ${row.pretty} for ${row.product || 'your programme'} didn't go through.`,
    '',
    `The bank said: "${row.reason || 'payment declined'}". It's usually just insufficient funds at that moment or a temporary bank block, nothing to worry about.`,
    '',
    fix,
    '',
    'Any questions at all, just reply to this email and we will sort it together!',
    '',
    'Victoria and the HSS team',
  ].join('\n');
  return { dm, email, subject: 'Your Her Sales Society payment didn\'t go through' };
}

async function heartbeatUsers() {
  const res = await fetch(`${HEARTBEAT_API}/users?limit=500`, {
    headers: { Authorization: `Bearer ${process.env.HEARTBEAT_API_KEY}` }, cache: 'no-store',
  });
  if (!res.ok) throw new Error(`heartbeat_users_http_${res.status}`);
  const byEmail = {};
  for (const u of await res.json()) {
    if (u.email) byEmail[u.email.toLowerCase()] = u;
  }
  return byEmail;
}

// Heartbeat renders DM text as HTML: plain text with a bare URL shows up as a
// BLANK message ("File attached" preview, no body). Escape + wrap in <p>, and
// make links real <a> tags. Allowed tags per Heartbeat docs: <p> <a> <b> <br>.
function toHeartbeatHtml(text) {
  const escaped = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linked = escaped.replace(/https?:\/\/[^\s<]+/g, (url) => {
    const trimmed = url.replace(/[.,)!?]+$/, '');
    const trail = url.slice(trimmed.length);
    return `<a href="${trimmed}">${trimmed}</a>${trail}`;
  });
  return `<p>${linked.replace(/\n/g, '<br>')}</p>`;
}

async function sendHeartbeatDM(toUserId, text) {
  text = toHeartbeatHtml(text);
  const res = await fetch(`${HEARTBEAT_API}/directMessages`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${process.env.HEARTBEAT_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: AI_VICKY_ID, to: toUserId, text }),
  });
  if (!res.ok) throw new Error(`heartbeat_dm_http_${res.status}:${(await res.text()).slice(0, 200)}`);
  return true;
}

function mailer() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error('gmail_not_configured');
  return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
}

async function sendEmail(transport, to, subject, text) {
  await transport.sendMail({
    from: `Victoria Yee <${process.env.GMAIL_USER}>`, to, subject, text,
  });
  return true;
}

// --------------------------------------------------------------------- Runs
async function failedPayments() {
  const key = process.env.WHOP_API_KEY;
  if (!key) throw new Error('whop_key_missing');
  const [payments, members, products] = await Promise.all([
    whopPages(key, 'payments'),
    whopPages(key, 'memberships'),
    whopPages(key, 'products'),
  ]);
  const memberById = {}; for (const m of members) memberById[m.id] = m;
  const productById = {}; for (const p of products) productById[p.id] = p;
  const ts = Date.now() / 1000;

  const rows = [];
  for (const p of payments) {
    if (p.status !== 'open' || Number(p.payments_failed || 0) <= 0) continue;
    if (!p.last_payment_attempt || ts - p.last_payment_attempt > 30 * DAY) continue;
    if (HIDDEN_PEOPLE.includes((personName(p) || '').toLowerCase())) continue;
    const m = memberById[p.membership || ''];
    rows.push({
      paymentId: p.id,
      email: (m && m.email) ? m.email.toLowerCase() : null,
      name: personName(p),
      first: (p.billing_first_name || '').trim() || 'there',
      amount: Number(p.final_amount || 0),
      currency: p.currency || 'gbp',
      pretty: money(p.final_amount, p.currency),
      product: (productById[p.product] || {}).name || null,
      attempts: Number(p.payments_failed || 0),
      lastAttempt: new Date(p.last_payment_attempt * 1000).toISOString(),
      reason: (p.failure_message || '').slice(0, 200) || null,
      manageUrl: (m && m.manage_url) || null,
    });
  }
  return rows;
}

module.exports = async (req, res) => {
  const q = req.query || {};
  if ((q.key || '') !== process.env.REFRESH_SECRET) {
    return res.status(401).json({ ok: false, error: 'bad_key' });
  }

  try {
    const failed = await failedPayments();

    // One sample message to a chosen address. Nothing is recorded.
    if (q.test) {
      const sample = failed[0] || {
        paymentId: 'pay_TEST', first: 'there', pretty: '\u00a3197', product: 'Setter Certification',
        reason: 'Your card has insufficient funds to complete this purchase.', manageUrl: 'https://whop.com/orders',
      };
      const row = { ...sample, first: 'Alessandro' };
      const copy = buildCopy(row);
      const hb = await heartbeatUsers();
      const target = hb[String(q.test).toLowerCase()];
      const out = { ok: true, mode: 'test', to: q.test, sampleFrom: sample.paymentId };
      out.heartbeat = target ? await sendHeartbeatDM(target.id, `[TEST, please ignore] ${copy.dm}`) : 'no_heartbeat_account';
      out.email = await sendEmail(mailer(), q.test, `[TEST] ${copy.subject}`, copy.email);
      return res.status(200).json(out);
    }

    const sent = await alreadySent();
    const fresh = failed.filter((r) => !sent.has(r.paymentId));

    if (q.seed) {
      await record(fresh.map((r) => ({
        payment_id: r.paymentId, email: r.email, name: r.name, amount: r.amount,
        currency: r.currency, product: r.product, reason: r.reason,
        dm_sent: false, email_sent: false, note: 'seeded_at_golive',
      })));
      return res.status(200).json({ ok: true, mode: 'seed', seeded: fresh.length });
    }

    if (q.dry) {
      return res.status(200).json({
        ok: true, mode: 'dry', failedTotal: failed.length, wouldMessage: fresh,
      });
    }

    const hb = fresh.length ? await heartbeatUsers() : {};
    const transport = fresh.length ? mailer() : null;
    const results = [];
    for (const r of fresh) {
      const copy = buildCopy(r);
      const result = {
        payment_id: r.paymentId, email: r.email, name: r.name, amount: r.amount,
        currency: r.currency, product: r.product, reason: r.reason,
        dm_sent: false, email_sent: false, note: null,
      };
      if (!r.email) {
        result.note = 'no_email_on_membership';
      } else {
        const target = hb[r.email];
        try {
          if (target) result.dm_sent = await sendHeartbeatDM(target.id, copy.dm);
          else result.note = 'no_heartbeat_account';
        } catch (err) { result.note = `dm_error:${String(err.message || err).slice(0, 120)}`; }
        try {
          result.email_sent = await sendEmail(transport, r.email, copy.subject, copy.email);
        } catch (err) {
          result.note = `${result.note ? result.note + ';' : ''}email_error:${String(err.message || err).slice(0, 120)}`;
        }
      }
      results.push(result);
    }
    await record(results);
    return res.status(200).json({
      ok: true, mode: 'live', failedTotal: failed.length, messaged: results,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
