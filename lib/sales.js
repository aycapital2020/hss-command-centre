// Reads Vicky's Sales Sheet (weekly funnel numbers) and the Monday Scorecard.
// This is the "attach my sales sheet" feature: show rate, calls booked/held,
// deals, close rate, cash — straight from the sheets her team already fills in.
//
// Both sheets are link-readable, so the service account (same one as the P&L
// sheet) reads them fine; if it ever fails we fall back to the public CSV export.

const { google } = require('googleapis');

const READONLY = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const SALES_WB = '1MuhZWoWZ5XDB2HDqMGNdjUBGt0RBMF3CdIvmfNelhUc'; // HSS Sales Sheet
const SCORECARD = '16oiQ1yl7UDkUYXpgfBlHc1Tf5L4VM9TVUw4_MpSj3jI'; // Monday Scorecard v4
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[£$,%\s]/g, '');
  if (s.includes('(') && s.includes(')')) s = '-' + s.replace(/[()]/g, '');
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

function sheetsClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(raw), scopes: [READONLY] });
  return google.sheets({ version: 'v4', auth });
}

// Minimal CSV parser (handles quoted cells) for the public-export fallback.
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i += 1; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

async function readTab(sheets, spreadsheetId, tab, range) {
  if (sheets) {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId, range: `'${tab}'!${range}`,
      });
      return res.data.values || [];
    } catch (err) { /* fall through to public CSV */ }
  }
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`csv fallback ${tab}: http ${res.status}`);
  return parseCsv(await res.text());
}

// 'Mon 04 Aug 26' -> ISO date
function wcToIso(label) {
  const m = /^Mon (\d{2}) (\w{3,4}) (\d{2})$/.exec(String(label).trim());
  if (!m) return null;
  const mi = MON.findIndex((x) => m[2].startsWith(x));
  if (mi < 0) return null;
  return `20${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1]}`;
}

function parseWeekly(grid) {
  // gviz CSV merges the title into the first header cell, so accept both
  // 'W/C' exactly and '... W/C' at the end of the cell.
  const hdr = grid.find((r) => r && /(^|\s)W\/C$/.test(String(r[0]).trim()));
  if (!hdr) throw new Error('Weekly 2026: header row not found');
  const col = {}; hdr.forEach((h, i) => { col[String(h).trim().toLowerCase()] = i; });
  col['w/c'] = 0;
  const pick = (r, name) => (col[name] != null ? r[col[name]] : null);
  const todayIso = new Date().toISOString().slice(0, 10);

  const weeks = []; let total = null;
  for (const r of grid) {
    const label = String((r && r[0]) || '').trim();
    if (/^Mon \d{2}/.test(label)) {
      const wc = wcToIso(label);
      if (!wc || wc > todayIso) continue; // future weeks: skip
      weeks.push({
        wc, label,
        booked: num(pick(r, 'booked')) || 0,
        taken: num(pick(r, 'taken')) || 0,
        showPct: num(pick(r, 'show %')),
        deals: num(pick(r, 'deals')) || 0,
        closePct: num(pick(r, 'close %')),
        revenue: num(pick(r, 'revenue')) || 0,
        cash: num(pick(r, 'cash')) || 0,
        noShows: num(pick(r, 'no shows')) || 0,
        cancelled: num(pick(r, 'cancelled')) || 0,
      });
    }
  }
  weeks.sort((a, b) => (a.wc < b.wc ? -1 : 1));
  // Totals computed from the weeks up to today (the sheet's TOTAL row includes
  // empty future weeks and its label cell vanishes in the CSV fallback).
  const sum = (k) => weeks.reduce((s, w) => s + (w[k] || 0), 0);
  total = {
    booked: sum('booked'), taken: sum('taken'), deals: sum('deals'),
    revenue: sum('revenue'), cash: sum('cash'),
    noShows: sum('noShows'), cancelled: sum('cancelled'),
    showPct: sum('booked') ? Math.round((sum('taken') / sum('booked')) * 100) : null,
    closePct: sum('taken') ? Math.round((sum('deals') / sum('taken')) * 100) : null,
  };
  return { weeks, total };
}

// Scorecard tab name for the current London month: "Aug 26" / "July 26" style.
function scorecardTabCandidates(now) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: '2-digit', month: 'long' }).formatToParts(now);
  const monthFull = parts.find((p) => p.type === 'month').value; // "August"
  const yy = parts.find((p) => p.type === 'year').value;         // "26"
  const out = [`${monthFull} ${yy}`, `${monthFull.slice(0, 3)} ${yy}`];
  if (monthFull === 'September') out.push(`Sept ${yy}`);
  return out;
}

function parseScorecard(grid, tabName) {
  // Header row: Measurable | Owner | Goal | Aim | WB1..WB5 | MONTH | Hit?
  // The CSV fallback merges the team labels into the header cells ("Vicky ·
  // money Goal"), so match each header by its LAST word.
  const lastWord = (h) => { const w = String(h).trim().toLowerCase().split(/\s+/); return w[w.length - 1] || ''; };
  const hi = grid.findIndex((r) => r && r.some((c) => lastWord(c) === 'hit?'));
  if (hi < 0) throw new Error(`Scorecard ${tabName}: header not found`);
  const hdr = grid[hi].map(lastWord);
  const cMonth = hdr.indexOf('month');
  const cHit = hdr.indexOf('hit?');
  const cGoal = hdr.indexOf('goal');
  const cAim = hdr.indexOf('aim');
  const cOwner = hdr.indexOf('owner');
  const wbCols = hdr.map((h, i) => (/^wb\d$/.test(h) ? i : -1)).filter((i) => i >= 0);

  const groups = []; let cur = null;
  for (let i = hi + 1; i < grid.length; i += 1) {
    const r = grid[i] || [];
    const name = String(r[0] || '').trim();
    if (!name) continue;
    if (/^TIER/i.test(name)) {
      cur = { title: name.replace(/\s{2,}/g, ' '), rows: [] };
      groups.push(cur);
      continue;
    }
    if (!cur) {
      // CSV fallback merges the "TIER 1" banner into the header row.
      cur = { title: 'TIER 1 — THE SIX. This is the whole meeting.', rows: [] };
      groups.push(cur);
    }
    const weekVals = wbCols.map((c) => String(r[c] || '').trim()).filter(Boolean);
    cur.rows.push({
      name,
      owner: cOwner >= 0 ? String(r[cOwner] || '').trim() : '',
      goal: cGoal >= 0 ? String(r[cGoal] || '').trim() : '',
      aim: cAim >= 0 ? String(r[cAim] || '').trim() : '',
      weeks: weekVals,
      month: cMonth >= 0 ? String(r[cMonth] || '').trim() : '',
      hit: cHit >= 0 ? String(r[cHit] || '').trim() : '',
    });
  }
  return groups.filter((g) => g.rows.length);
}

async function getSales() {
  const sheets = sheetsClient();
  const weeklyGrid = await readTab(sheets, SALES_WB, 'Weekly 2026', 'A1:P60');
  const { weeks, total } = parseWeekly(weeklyGrid);

  let scorecard = null; let scorecardError = null;
  for (const tab of scorecardTabCandidates(new Date())) {
    try {
      const grid = await readTab(sheets, SCORECARD, tab, 'A1:K80');
      const groups = parseScorecard(grid, tab);
      if (groups.length) { scorecard = { tab, groups }; break; }
    } catch (err) { scorecardError = String((err && err.message) || err); }
  }

  return {
    ok: true,
    weeks, total,
    scorecard, scorecardError: scorecard ? null : scorecardError,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { getSales };
