// api/gmail.js
// Gmail read / write / delete proxy for the CRM Inbox (tehran.hopkins@gmail.com).
// Auth to call THIS endpoint: Bearer c4-my-secret-2026.
//
// Gmail auth: OAuth2 refresh token. Requires Vercel env vars:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
// One-time consent mints the refresh token (see CLAUDE.md -> Gmail setup).
//
// Until those are set the endpoint always returns HTTP 200 with degraded:true
// so the Inbox tab can render a setup card instead of erroring.
//
// Actions (no SDK — raw Gmail REST + global fetch):
//   GET    ?action=list   &q=in:inbox&max=20      list message summaries
//   GET    ?action=get    &id=<id>                full message (decoded body)
//   POST   ?action=send   { to, subject, body, cc }   send mail
//   DELETE ?action=trash  &id=<id>                move to Trash (default)
//   DELETE ?action=delete &id=<id>  (or &hard=1)  permanent delete

const AUTH    = process.env.C4_SECRET || 'c4-my-secret-2026';
const CID     = process.env.GOOGLE_CLIENT_ID;
const CSECRET = process.env.GOOGLE_CLIENT_SECRET;
const RTOKEN  = process.env.GOOGLE_REFRESH_TOKEN;
const GMAIL   = 'https://gmail.googleapis.com/gmail/v1/users/me';

function authorized(req) {
  return (req.headers.authorization || '').trim() === `Bearer ${AUTH}`;
}

async function accessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CID, client_secret: CSECRET, refresh_token: RTOKEN, grant_type: 'refresh_token',
    }),
  });
  if (!r.ok) throw new Error('Google token exchange failed: HTTP ' + r.status);
  return (await r.json()).access_token;
}

const hdr = (headers, name) =>
  (headers.find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';

const b64url = (s) =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function decode(data) {
  try { return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
  catch { return ''; }
}

function extractBody(payload) {
  if (!payload) return '';
  if (payload.body?.data) return decode(payload.body.data);
  const parts = payload.parts || [];
  const text = parts.find(p => p.mimeType === 'text/plain');
  if (text?.body?.data) return decode(text.body.data);
  const html = parts.find(p => p.mimeType === 'text/html');
  if (html?.body?.data) return decode(html.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  for (const p of parts) { const sub = extractBody(p); if (sub) return sub; }
  return '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  if (!CID || !CSECRET || !RTOKEN) {
    return res.status(200).json({
      degraded: true,
      error: 'Gmail not configured',
      setup: 'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN in Vercel env. See CLAUDE.md -> Gmail setup.',
      messages: [],
    });
  }

  try {
    const token = await accessToken();
    const auth = { Authorization: `Bearer ${token}` };
    const action = (req.query.action || '').toLowerCase();

    // ── LIST ───────────────────────────────────────────────────────────
    if (req.method === 'GET' && (action === 'list' || !action)) {
      const q = req.query.q || 'in:inbox';
      const max = Math.min(parseInt(req.query.max) || 20, 50);
      const lr = await fetch(`${GMAIL}/messages?maxResults=${max}&q=${encodeURIComponent(q)}`, { headers: auth });
      const lj = await lr.json();
      if (!lr.ok) return res.status(200).json({ degraded: true, error: lj.error?.message || 'list failed', messages: [] });
      const ids = (lj.messages || []).map(m => m.id);
      const messages = await Promise.all(ids.map(async (id) => {
        const mr = await fetch(`${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: auth });
        const mj = await mr.json();
        const H = mj.payload?.headers || [];
        return {
          id, threadId: mj.threadId,
          from: hdr(H, 'From'), subject: hdr(H, 'Subject'), date: hdr(H, 'Date'),
          snippet: mj.snippet, unread: (mj.labelIds || []).includes('UNREAD'),
        };
      }));
      return res.status(200).json({ degraded: false, count: messages.length, messages });
    }

    // ── GET single (full body) ─────────────────────────────────────────
    if (req.method === 'GET' && action === 'get') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id required' });
      const mr = await fetch(`${GMAIL}/messages/${id}?format=full`, { headers: auth });
      const mj = await mr.json();
      if (!mr.ok) return res.status(500).json({ error: mj.error?.message || 'get failed' });
      const H = mj.payload?.headers || [];
      return res.status(200).json({
        degraded: false, id, threadId: mj.threadId,
        from: hdr(H, 'From'), to: hdr(H, 'To'), subject: hdr(H, 'Subject'), date: hdr(H, 'Date'),
        body: extractBody(mj.payload), snippet: mj.snippet,
      });
    }

    // ── SEND ────────────────────────────────────────────────────────────
    if (req.method === 'POST' && (action === 'send' || !action)) {
      const { to, subject, body, cc } = req.body || {};
      if (!to) return res.status(400).json({ error: 'to required' });
      const lines = [
        `To: ${to}`,
        cc ? `Cc: ${cc}` : null,
        `Subject: ${subject || '(no subject)'}`,
        'Content-Type: text/plain; charset=UTF-8',
        '',
        body || '',
      ].filter(x => x !== null);
      const sr = await fetch(`${GMAIL}/messages/send`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: b64url(lines.join('\r\n')) }),
      });
      const sj = await sr.json();
      if (!sr.ok) return res.status(500).json({ error: sj.error?.message || 'send failed' });
      return res.status(200).json({ success: true, id: sj.id, threadId: sj.threadId });
    }

    // ── TRASH / DELETE ──────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = req.query.id || (req.body || {}).id;
      if (!id) return res.status(400).json({ error: 'id required' });
      const hard = req.query.hard === '1' || action === 'delete';
      const path = hard ? `${GMAIL}/messages/${id}` : `${GMAIL}/messages/${id}/trash`;
      const dr = await fetch(path, { method: hard ? 'DELETE' : 'POST', headers: auth });
      if (!dr.ok && dr.status !== 204) {
        const dj = await dr.json().catch(() => ({}));
        return res.status(500).json({ error: dj.error?.message || 'delete failed' });
      }
      return res.status(200).json({ success: true, [hard ? 'deleted' : 'trashed']: id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(200).json({ degraded: true, error: e.message, messages: [] });
  }
}
