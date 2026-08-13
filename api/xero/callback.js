// Xero OAuth callback.
//
// The dashboard exchanges the one-time authorisation code for tokens straight
// away (the code lives only ~5 minutes, so leaving that exchange to a human
// copy/paste raced against the clock). What the page shows instead is the
// long-lived, rotating refresh token + tenant id, which Viktor persists in
// files/hss/cfo/secrets/xero.json and uses for every later sync. Needs
// XERO_CLIENT_ID / XERO_CLIENT_SECRET in the Vercel env; if they are missing we
// fall back to showing the raw code so the old manual path still works.

const REDIRECT_URI = 'https://hss-cfo-dashboard.vercel.app/api/xero/callback';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';

function page(title, body, tone) {
  const accent = tone === 'error' ? '#d03b3b' : '#b3306e';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — HSS CFO Dashboard</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f3f1;
    font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;color:#1a1013}
  .card{max-width:620px;background:#fffdfc;border:1px solid #eadfe2;border-radius:16px;
    padding:34px 36px;box-shadow:0 1px 2px rgba(26,16,19,.05),0 8px 24px -12px rgba(26,16,19,.14)}
  h1{margin:0 0 6px;font-size:21px;letter-spacing:-.01em}
  .tag{display:inline-block;margin-bottom:16px;font-size:12px;font-weight:600;letter-spacing:.06em;
    text-transform:uppercase;color:${accent}}
  code{display:block;margin:16px 0 6px;padding:14px 16px;background:#faf6f4;border:1px solid #eadfe2;
    border-radius:10px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
  p{margin:10px 0;color:#5f545a}
  a{color:${accent}}
</style></head><body><div class="card">${body}</div></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function exchange(code) {
  const basic = Buffer.from(
    `${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`
  ).toString('base64');

  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokens.refresh_token) {
    throw new Error(
      `token exchange failed (${tokenRes.status}) ${tokens.error || ''} ${tokens.error_description || ''}`.trim()
    );
  }

  let orgs = [];
  try {
    const connRes = await fetch(CONNECTIONS_URL, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json',
      },
    });
    if (connRes.ok) orgs = await connRes.json();
  } catch (_) {
    orgs = [];
  }

  return { refreshToken: tokens.refresh_token, orgs: Array.isArray(orgs) ? orgs : [] };
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'https://hss-cfo-dashboard.vercel.app');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const desc = url.searchParams.get('error_description');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (error) {
    return res.status(400).send(page('Authorisation failed', `
      <span class="tag">Xero connection</span>
      <h1>Authorisation didn't complete</h1>
      <p>${escapeHtml(desc || error)}</p>
      <p>Nothing was changed. Send this message to Viktor and he'll reissue the link.</p>`, 'error'));
  }

  if (!code) {
    return res.status(400).send(page('Nothing to do', `
      <span class="tag">Xero connection</span>
      <h1>No authorisation code</h1>
      <p>Open this page only via the Xero consent link.</p>
      <p><a href="/">Back to the dashboard</a></p>`, 'error'));
  }

  if (!process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET) {
    return res.status(200).send(page('Xero connected', `
      <span class="tag">Xero connection</span>
      <h1>Authorised — one step left</h1>
      <p>Send this code to Viktor within 5 minutes (single use):</p>
      <code>${escapeHtml(code)}</code>
      <p><a href="/">Back to the dashboard</a></p>`));
  }

  try {
    const { refreshToken, orgs } = await exchange(code);
    const names = orgs.map((o) => o.tenantName).filter(Boolean).join(', ') || 'the authorised organisation';
    const payload = JSON.stringify({
      refresh_token: refreshToken,
      tenants: orgs.map((o) => ({ id: o.tenantId, name: o.tenantName })),
    });
    return res.status(200).send(page('Xero connected', `
      <span class="tag">Xero connection</span>
      <h1>Connected to ${escapeHtml(names)}</h1>
      <p>Authorisation worked. Send this block to Viktor — it doesn't expire in
      minutes like the old code did, so there's no rush:</p>
      <code>${escapeHtml(payload)}</code>
      <p>He drops it into the sync and the dashboard switches to live Xero numbers.</p>
      <p><a href="/">Back to the dashboard</a></p>`));
  } catch (err) {
    return res.status(400).send(page('Authorisation failed', `
      <span class="tag">Xero connection</span>
      <h1>Xero rejected the exchange</h1>
      <p>${escapeHtml(err.message)}</p>
      <p>Nothing was changed in Her Sales Academy's books. Send this to Viktor and he'll reissue the link.</p>`, 'error'));
  }
};
