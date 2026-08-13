// Reads Vicky's "P & L 2025" sheet and returns the dashboard data model.
// Used by /api/pnl.js (Vercel function) and by scripts/verify.js (local test).
// Read-only. All money in GBP.

const { google } = require('googleapis');

const READONLY = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const MONTHS_FULL = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/dh/gi, '').replace(/[£$,%\s]/g, '');
  if (s.includes('(') && s.includes(')')) s = '-' + s.replace(/[()]/g, '');
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

// Category headers exactly as spelled in the sheet ("Fullfillment" is theirs).
// Software is included so it bounds the Mentorship block above it (otherwise
// Mentorship's line-scan runs into the software section and double-counts it).
const CATEGORY_HEADERS = [
  { key: 'marketing', header: 'Marketing', label: 'Marketing' },
  { key: 'fulfillment', header: 'Fullfillment', label: 'Fulfillment' },
  { key: 'sales_revenue', header: 'Sales & Revenue Generation', label: 'Sales & Rev' },
  { key: 'team_ops', header: 'Team & Ops', label: 'Team & Ops' },
  { key: 'finance_legal', header: 'Finance & Legal', label: 'Finance & Legal' },
  { key: 'mentorship', header: 'Mentorship & Coaching', label: 'Mentorship' },
  { key: 'software', header: 'Software and apps', label: 'Software' },
];
const FIXED_CATEGORIES = new Set(['team_ops', 'finance_legal', 'mentorship', 'software']);
const FIXED_VENDOR_HINTS = ['shannon', 'va additional', 'ads manager'];

function classify(vendor, categoryKey) {
  const name = String(vendor || '').toLowerCase();
  if (FIXED_VENDOR_HINTS.some((h) => name.includes(h))) return 'fixed';
  if (FIXED_CATEGORIES.has(categoryKey)) return 'fixed';
  return 'variable'; // marketing / fulfillment / sales default variable
}

function findCell(grid, needle) {
  const n = needle.toLowerCase();
  for (let r = 0; r < grid.length; r += 1) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c += 1) {
      if (row[c] != null && String(row[c]).toLowerCase().includes(n)) return { r, c };
    }
  }
  return null;
}

function readCostFromGrid(grid) {
  // Locate each category header present in the tab.
  const found = [];
  for (const cat of CATEGORY_HEADERS) {
    const hit = findCell(grid, cat.header);
    if (hit) found.push({ ...cat, r: hit.r, c: hit.c });
  }
  if (!found.length) return null;
  found.sort((a, b) => a.r - b.r);
  const headerRows = found.map((f) => f.r);

  const cats = {};
  const items = []; // individual vendor lines — feeds the fixed/variable settings panel
  for (const cat of found) {
    const later = headerRows.filter((r) => r > cat.r);
    const boundary = later.length ? Math.min(...later) : grid.length;
    const labelCol = cat.c, amtCol = cat.c + 1;
    let f = 0, v = 0;
    for (let r = cat.r + 1; r < boundary; r += 1) {
      const row = grid[r] || [];
      const label = String(row[labelCol] ?? '').trim();
      if (!label) continue;
      if (/^total\b/i.test(label)) break;
      const amt = num(row[amtCol]);
      if (amt == null || amt === 0) continue;
      const type = classify(label, cat.key);
      if (type === 'fixed') f += amt; else v += amt;
      items.push({ key: cat.label + '|' + label, cat: cat.label, vendor: label, amount: amt, type });
    }
    cats[cat.key] = { n: cat.label, f, v };
  }

  // Software: prefer the sheet's own "Total Software" cell over the line-sum
  // (authoritative + guards against odd rows). Collapse to one lump line so the
  // settings panel doesn't list ~30 tiny subscriptions. Fixed by default.
  const swHit = findCell(grid, 'total software');
  const software = swHit ? num((grid[swHit.r] || [])[swHit.c + 1]) : null;
  if (software != null && software > 0) {
    cats.software = { n: 'Software', f: software, v: 0 };
    for (let i = items.length - 1; i >= 0; i -= 1) if (items[i].cat === 'Software') items.splice(i, 1);
    items.push({ key: 'Software|Software & apps', cat: 'Software', vendor: 'Software & apps', amount: software, type: 'fixed' });
  }

  // Total recurring from the sheet's "Total Business Expenses" cell.
  const tbeHit = findCell(grid, 'total business');
  const recurring = tbeHit ? num((grid[tbeHit.r] || [])[tbeHit.c + 1]) : null;

  const catList = Object.values(cats).filter((c) => (c.f + c.v) > 0);
  const fixed = catList.reduce((s, c) => s + c.f, 0);
  const variable = catList.reduce((s, c) => s + c.v, 0);
  return {
    recurring: recurring != null ? recurring : fixed + variable,
    fixed, variable, cats: catList, items,
  };
}

async function getPnlData({ credentials, sheetId }) {
  const auth = new google.auth.GoogleAuth({ credentials, scopes: [READONLY] });
  const sheets = google.sheets({ version: 'v4', auth });

  // --- Yearly summary tab ---
  const yRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId, range: "'Yearly'!A2:M18", valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const Y = yRes.data.values || [];
  const months = [];
  const quarters = [];
  let ytd = null;
  for (const row of Y) {
    const label = String(row[0] ?? '').trim();
    const rev = num(row[1]);
    if (MONTHS_FULL.includes(label)) {
      if (rev != null && rev > 0) {
        const profit = num(row[7]) ?? 0;
        months.push({
          m: label.slice(0, 3), full: label, rev, profit,
          margin: +(100 * profit / rev).toFixed(2), students: num(row[9]) ?? 0,
        });
      }
    } else if (/^q[1-4]\b/i.test(label)) {
      if (rev != null && rev > 0) quarters.push({ q: label.split(/\s+/)[0].toUpperCase(), rev, profit: num(row[7]) ?? 0 });
    } else if (label.toLowerCase().includes('year total')) {
      const rv = num(row[1]); const pf = num(row[7]);
      if (rv) ytd = { rev: rv, profit: pf ?? 0, opCost: num(row[5]) ?? (rv - (pf ?? 0)), students: num(row[9]) ?? 0, margin: +(100 * (pf ?? 0) / rv).toFixed(2) };
    }
  }
  if (!ytd && months.length) {
    const rv = months.reduce((s, m) => s + m.rev, 0);
    const pf = months.reduce((s, m) => s + m.profit, 0);
    const st = months.reduce((s, m) => s + m.students, 0);
    ytd = { rev: rv, profit: pf, opCost: rv - pf, students: st, margin: +(100 * pf / rv).toFixed(2) };
  }

  // --- Latest 2026 monthly tab with expense data → cost structure ---
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets.properties(title)' });
  const titles = (meta.data.sheets || []).map((s) => s.properties.title);
  const monthTabs = titles.map((t) => {
    const p = String(t).trim().split(/\s+/);
    const mi = MONTHS_FULL.findIndex((M) => M.toLowerCase().startsWith(p[0].toLowerCase()));
    const yy = parseInt(p[1], 10);
    return (mi >= 0 && Number.isFinite(yy) && yy >= 26) ? { title: t, ord: yy * 12 + mi } : null;
  }).filter(Boolean).sort((a, b) => a.ord - b.ord);

  // Read the BUSINESS-expense side (cols G/H — never the personal side in A/B) of
  // every monthly tab, so the dashboard has each month's expense breakdown, not
  // just the current one. Keyed by full month name (Vicky is UK-based).
  const londonNow = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: 'numeric' })
    .formatToParts(new Date());
  const curMonth = Number(londonNow.find((p) => p.type === 'month').value); // 1-12

  const monthCosts = {};
  for (const t of monthTabs) {
    let res;
    try {
      res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId, range: `'${t.title}'!A1:Z120`, valueRenderOption: 'UNFORMATTED_VALUE',
      });
    } catch { continue; }
    const parsed = readCostFromGrid(res.data.values || []);
    if (parsed && parsed.recurring > 0) {
      parsed.tab = t.title;
      parsed.month = MONTHS_FULL[t.ord % 12];
      monthCosts[parsed.month] = parsed;
    }
  }

  // Default cost = current calendar month; else the latest month that has data.
  let cost = monthCosts[MONTHS_FULL[curMonth - 1]] || null;
  if (!cost) {
    const withData = monthTabs.filter((t) => monthCosts[MONTHS_FULL[t.ord % 12]]);
    if (withData.length) cost = monthCosts[MONTHS_FULL[withData[withData.length - 1].ord % 12]];
  }

  return { months, quarters, ytd, cost, monthCosts, generatedAt: new Date().toISOString() };
}

module.exports = { getPnlData };
