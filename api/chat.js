// CFO Agent chat endpoint.
// Grounds Claude (claude-opus-4-6) in the live P&L data and a Mem0 long-term
// memory of the business, so Vicky can ask anything about her numbers.
// Keys come from Vercel env: ANTHROPIC_API_KEY (required), MEM0_API_KEY (optional).

const { getPnlData } = require('../lib/pnl');
const { readXeroSnapshot, mergeWithSheet, reconcile } = require('../lib/xero');
const { getLive } = require('../lib/live');

const AnthropicPkg = require('@anthropic-ai/sdk');
const Anthropic = AnthropicPkg.default || AnthropicPkg;

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-6';
const DEFAULT_SHEET_ID = '1gGaQXHeQNo25EmtyN8CB2CL1155Gy1nmLX5LiaRbo10';
const MEM0_USER = 'vicky-hss';

const SYSTEM_PROMPT = `You are the CFO Agent for Her Sales Society (HSS) — Vicky Yee's sales-coaching business. You are Vicky's sharp, plain-spoken finance partner AND coach. You don't just report the numbers — you tell her what they mean and, crucially, what to DO about them.

Grounding:
- Use the data provided below. Never invent figures. If something isn't in the data, say so plainly and say what you'd need to answer it.
- British English. Money in GBP with the £ sign and thousands separators.

Targets (treat as the bar): net profit margin 58%; churn under 5%.

How to answer:
- Lead with the number/answer, then give the "so what" and the "what to do". Vicky has explicitly asked for SOPs and concrete steps on how to hit her targets — not just facts.
- When a metric is off target (net margin < 58%, churn > 5%, or anything else with a target shown), diagnose the gap: how far off, what's driving it (name the specific months, cost lines, or close-rate), then give a short prioritised SOP — 2 to 4 specific actions to close it, e.g. "To lift margin to 58%: 1) … 2) …". Put real numbers in the steps and quantify the impact where you can.
- Think in the levers she controls: revenue (calls booked × show rate × close rate × average deal value), recurring revenue / renewals, and cost structure (fixed vs variable). When she asks how to hit a target, work backwards through these levers and show the maths.
- Be decisive: give a recommendation, not a menu of options. Tight numbered steps or short paragraphs — this is a chat, not a report. No "Based on the data…" preamble.
- If a figure looks wrong or stale (a month not entered yet, a snapshot value), flag it rather than treating it as gospel.
- You cannot take actions or edit her sheets — you advise and coach.`;

function money(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return 'n/a';
  return '£' + Math.round(Number(n)).toLocaleString('en-GB');
}

function buildContext(data) {
  const lines = [];
  const y = data.ytd || {};
  lines.push('## Year-to-date (Jan–Jun 2026, closed months)');
  lines.push(`Revenue ${money(y.rev)} · Net profit ${money(y.profit)} · Net margin ${y.margin ?? 'n/a'}% (target 58%) · Operating cost ${money(y.opCost)} · New students ${y.students ?? 'n/a'}`);

  if (Array.isArray(data.months) && data.months.length) {
    lines.push('\n## Monthly (revenue / net profit / margin / students)');
    for (const m of data.months) {
      lines.push(`${m.full}: ${money(m.rev)} / ${money(m.profit)} / ${m.margin}% / ${m.students}`);
    }
  }
  if (Array.isArray(data.quarters) && data.quarters.length) {
    lines.push('\n## Quarters');
    for (const q of data.quarters) lines.push(`${q.q}: revenue ${money(q.rev)}, net profit ${money(q.profit)}`);
  }
  if (data.cost) {
    const c = data.cost;
    lines.push(`\n## Current-month cost structure (${c.tab})`);
    lines.push(`Recurring ${money(c.recurring)}/mo · Fixed ${money(c.fixed)} · Variable ${money(c.variable)}`);
    if (Array.isArray(c.cats)) {
      for (const cat of c.cats) lines.push(`  ${cat.n}: ${money((cat.f || 0) + (cat.v || 0))} (fixed ${money(cat.f)}, variable ${money(cat.v)})`);
    }
    if (Array.isArray(c.items) && c.items.length) {
      lines.push('Every line, this month (vendor - category - fixed/variable - amount):');
      for (const it of [...c.items].sort((a, b) => b.amount - a.amount)) {
        lines.push(`  ${it.vendor} - ${it.cat} - ${it.type} - ${money(it.amount)}`);
      }
    }
  }
  if (data.monthCosts && typeof data.monthCosts === 'object') {
    lines.push('\n## Expense lines by month (so you can answer "what changed" and "what did I spend on X in May")');
    for (const [monthName, block] of Object.entries(data.monthCosts)) {
      if (!block || !Array.isArray(block.items)) continue;
      const top = [...block.items].sort((a, b) => b.amount - a.amount)
        .map((it) => `${it.vendor} ${money(it.amount)}`).join(', ');
      lines.push(`${monthName} (total ${money(block.recurring)}): ${top}`);
    }
  }
  return lines.join('\n');
}


// Xero is connected but its books are behind the sheet — say so, with the gaps,
// so the agent never presents Xero's partial totals as the business's numbers.
// Whop is the live till: real-time revenue, renewals, members, declines.
function liveSection(live) {
  if (!live || !live.ok || !live.whop) {
    return 'LIVE WHOP DATA: unavailable right now'
      + (live && live.whopError ? ' (' + live.whopError + ')' : '') + '.';
  }
  const w = live.whop;
  const money = (n) => '£' + Math.round(n).toLocaleString('en-GB');
  const lines = [
    'LIVE DATA FROM WHOP (her actual payment platform, read ' + live.pulledAt + ')',
    '- This is the real-time till. It is the ONLY live source: the P&L sheet is monthly and Xero is behind.',
    '- ' + w.mtdMonth + ' month-to-date revenue: ' + money(w.mtdRevenue)
      + ' (day ' + w.mtdAsOfDay + ' of ' + w.daysInMonth + '), run-rate ' + money(w.projectedRevenue),
    '- Renewals in the next 7 days: ' + w.renewals7d + ' worth about ' + money(w.renewals7dValue),
    '- Active subscriptions: ' + w.activeSubscriptions + '; members with access: ' + w.membersWithAccess
      + '; past due: ' + w.pastDue,
    '- Declined & still-unpaid payments in the last 30 days: ' + money(w.atRisk)
      + ' (' + money(w.atRiskMembers) + ' from existing members whose cards failed — recoverable by asking them to update the card; '
      + money(w.atRiskCheckouts) + ' from checkouts that never completed — lost new sales)',
    '- Churn last 30 days: ' + w.churn30d + '% (' + w.left30d + ' left, ' + w.leaving30d
      + ' cancelled and leaving within 30 days)',
    '- Lifetime value per paying customer: ' + money(w.ltv) + ' across ' + w.payingCustomers + ' customers',
    '- Whop revenue by month (GBP, converted at today\'s rate): '
      + Object.entries(w.months).map(([m, v]) => m + ' ' + money(v)).join(', '),
  ];
  const d = live.detail || {};
  const fmt = (n) => '£' + Math.round(n || 0).toLocaleString('en-GB');
  const who = (r) => (r.name || (r.email || '').split('@')[0] || 'unknown')
    + (r.email ? ' <' + r.email + '>' : '');
  if ((d.renewals || []).length) {
    lines.push('- RENEWING IN THE NEXT 30 DAYS (' + d.renewals.length + '), soonest first: '
      + d.renewals.slice(0, 25).map((r) => who(r) + ' ' + fmt(r.amount) + ' on '
        + String(r.renewsAt).slice(0, 10) + (r.product ? ' (' + r.product + ')' : '')).join('; '));
  }
  if ((d.declined || []).length) {
    lines.push('- DECLINED & STILL UNPAID, last 30 days (' + d.declined.length + '): '
      + d.declined.slice(0, 20).map((r) => who(r) + ' ' + fmt(r.amount)
        + (r.stillAMember ? ' [still a member - chase the card]' : ' [checkout never completed]')
        + (r.reason ? ' - ' + r.reason : '')).join('; '));
  }
  if ((d.leaving || []).length) {
    lines.push('- CANCELLED, ACCESS ENDING WITHIN 30 DAYS (win-back list): '
      + d.leaving.map((r) => who(r) + ' ends ' + String(r.endsAt).slice(0, 10)
        + ' was paying ' + fmt(r.amount)).join('; '));
  }
  if ((d.left || []).length) {
    lines.push('- LEFT IN THE LAST 30 DAYS: '
      + d.left.map((r) => who(r) + ' left ' + String(r.endedAt).slice(0, 10)
        + ' was paying ' + fmt(r.amount)).join('; '));
  }
  if (d.mix && d.mix.program90) {
    lines.push('- REVENUE MIX last 90 days by programme: '
      + Object.entries(d.mix.program90).map(([k, v]) => k + ' ' + fmt(v)).join(', ')
      + ' | paid in full vs payment plan: '
      + Object.entries(d.mix.structure90 || {}).map(([k, v]) => k + ' ' + fmt(v)).join(', '));
  }
  if ((d.topCustomers || []).length) {
    lines.push('- BIGGEST CUSTOMERS by lifetime spend: '
      + d.topCustomers.slice(0, 10).map((c) => (c.name || c.who) + ' ' + fmt(c.total)).join(', '));
  }
  if (live.community) {
    const c = live.community;
    lines.push('- HEARTBEAT COMMUNITY (live): ' + c.members + ' members, ' + c.admins + ' admins. '
      + c.payingNotInCommunityCount + ' people are paying on Whop but have NO community account (onboarding gap - they paid and got nothing). '
      + c.inCommunityNotPayingCount + ' people are in the community with no active payment (either free/alumni by design, or revenue leaking). '
      + 'Biggest groups: ' + (c.courseGroups || []).slice(0, 5).map((g) => g.name + ' (' + g.members + ')').join(', '));
    if ((c.inCommunityNotPaying || []).length) {
      lines.push('  Names in the community with no active payment: '
        + c.inCommunityNotPaying.slice(0, 20).map((u) => (u.name || u.email)).join(', '));
    }
  } else if (live.communityError) {
    lines.push('- HEARTBEAT COMMUNITY: unavailable (' + live.communityError + ')');
  }
  if (live.wise && live.wise.totalGbp != null) {
    lines.push('- Wise cash: ' + money(live.wise.totalGbp)
      + ' (Wise only — she has other bank accounts we cannot see, so never call this her total cash)');
  }
  lines.push('- Whop monthly totals run slightly BELOW her P&L sheet because the sheet also includes'
    + ' non-Whop income. Use the sheet for official monthly P&L, Whop for anything live or in-month.');
  if (live.live === false) {
    lines.push('- NOTE: the live call failed, these are from the last successful read. Say so if she asks how current it is.');
  }
  return lines.join('\n');
}

function xeroBookkeepingSection(recon) {
  if (!recon) return '';
  const lines = ['## Xero bookkeeping status (IMPORTANT)'];
  lines.push('Xero IS connected' + (recon.org ? ' (' + recon.org + ')' : '')
    + ', last pulled ' + (recon.pulledAt || 'n/a') + '.');
  lines.push('Xero holds ' + money(recon.xeroRevTotal) + ' of revenue against '
    + money(recon.sheetRevTotal) + ' in the P&L sheet — a gap of ' + money(recon.revenueGap)
    + '. Revenue is not posted in Xero for: ' + (recon.missingRevenueMonths.join(', ') || 'none') + '.');
  lines.push('So the revenue and profit figures above come from the sheet, which is the accurate source today. Do NOT quote Xero totals as the business\'s revenue.');
  if (Array.isArray(recon.rows) && recon.rows.length) {
    lines.push('Month-by-month (sheet revenue vs Xero revenue / Xero expenses booked):');
    for (const r of recon.rows) {
      lines.push('  ' + r.full + ': sheet ' + money(r.sheetRev) + ' vs Xero ' + money(r.xeroRev)
        + ' / Xero expenses ' + money(r.xeroExpenses));
    }
  }
  lines.push('If Vicky asks about Xero: the connection works, but her bookkeeping needs invoices/payments reconciled in Xero for the missing months before Xero can become the single source of truth. Xero expense data IS flowing from the bank feed for ' + ((recon.xeroExpenseMonths || []).join(', ') || 'no months yet') + '.');
  return lines.join('\n');
}

// --- Mem0 (optional, REST, graceful) ---------------------------------------
async function mem0Search(query) {
  const key = process.env.MEM0_API_KEY;
  if (!key) return '';
  try {
    const r = await fetch('https://api.mem0.ai/v1/memories/search/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${key}` },
      body: JSON.stringify({ query, user_id: MEM0_USER, limit: 6 }),
    });
    if (!r.ok) return '';
    const j = await r.json();
    const list = Array.isArray(j) ? j : (j.results || j.memories || []);
    return list.map((m) => '- ' + (m.memory || m.text || m.data || '')).filter((s) => s.length > 2).join('\n');
  } catch { return ''; }
}
function mem0Add(userMsg, reply) {
  const key = process.env.MEM0_API_KEY;
  if (!key) return;
  fetch('https://api.mem0.ai/v1/memories/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Token ${key}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: userMsg }, { role: 'assistant', content: reply }], user_id: MEM0_USER }),
  }).catch(() => {});
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') { try { return Promise.resolve(JSON.parse(req.body)); } catch { return Promise.resolve({}); } }
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') { res.status(405).json({ reply: 'POST only.' }); return; }
  try {
    const body = await readBody(req);
    const message = String(body.message || '').trim().slice(0, 2000);
    const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
    if (!message) { res.status(400).json({ reply: 'Ask me something about the numbers.' }); return; }

    if (!process.env.ANTHROPIC_API_KEY) {
      res.status(200).json({ reply: "I'm not switched on yet — the ANTHROPIC_API_KEY hasn't been added to this deployment. Add it in Vercel and I'll be able to answer." });
      return;
    }

    // Live financial context (best-effort; chat still answers if the sheet read fails).
    let context = 'P&L data is temporarily unavailable.';
    try {
      const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      const [sheetOutcome, xero, live] = await Promise.all([
        getPnlData({ credentials, sheetId: process.env.SHEET_ID || DEFAULT_SHEET_ID })
          .then((d) => d).catch(() => null),
        readXeroSnapshot().catch(() => ({ ok: false })),
        getLive().catch((e) => ({ ok: false, whopError: String(e && e.message || e) })),
      ]);
      const recon = xero && xero.ok ? reconcile(xero.snapshot, sheetOutcome) : null;
      if (xero && xero.ok && (!sheetOutcome || recon.revenueComplete)) {
        const merged = mergeWithSheet(xero.snapshot, sheetOutcome);
        context = 'Source: Xero accounting data'
          + (xero.snapshot.tenantName ? ' (' + xero.snapshot.tenantName + ')' : '')
          + ', pulled ' + xero.snapshot.pulledAt + '. Student counts come from the P&L sheet.\n'
          + buildContext(merged);
      } else if (xero && xero.ok && sheetOutcome) {
        context = 'Source: Vicky\'s "P & L 2025" Google Sheet for revenue and profit.\n'
          + buildContext(sheetOutcome) + '\n' + xeroBookkeepingSection(recon);
      } else if (sheetOutcome) {
        context = 'Source: Vicky\'s "P & L 2025" Google Sheet (Xero snapshot unavailable: '
          + ((xero && xero.reason) || 'unknown') + ').\n' + buildContext(sheetOutcome);
      } else {
        context = 'P&L data temporarily unavailable (sheet read failed and no Xero snapshot).';
      }
      context += '\n\n' + liveSection(live);
    } catch (e) { context = 'P&L data temporarily unavailable (' + e.message + ').'; }

    const memories = await mem0Search(message);

    const system = SYSTEM_PROMPT
      + '\n\n# LIVE FINANCIAL DATA\n' + context
      + (memories ? '\n\n# WHAT YOU REMEMBER ABOUT THE BUSINESS\n' + memories : '');

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const messages = history
      .filter((h) => h && h.content)
      .map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content).slice(0, 4000) }));
    messages.push({ role: 'user', content: message });

    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system,
      messages,
    });

    const reply = (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim() || "I couldn't put an answer together — try rephrasing.";

    mem0Add(message, reply);
    res.status(200).json({ reply, model: resp.model });
  } catch (e) {
    res.status(200).json({ reply: 'Sorry — I hit an error answering that. (' + String((e && e.message) || e).slice(0, 200) + ')' });
  }
};
