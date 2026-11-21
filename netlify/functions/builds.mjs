/**
 * /api/builds
 *   POST { code, ep?, stats?, name? }  -> saves a build, returns the stored record
 *   GET  ?limit=50                     -> newest builds first
 *
 * Storage is Netlify Blobs: no external database account, no connection string.
 * It is provisioned automatically for a deployed site, and `netlify dev` gives
 * you a local sandbox of it.
 */
import { getStore } from '@netlify/blobs';

const MAX_CODE = 2000;
const MAX_NAME = 80;
const DEFAULT_LIMIT = 50;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });

/**
 * AO Gear Builder codes are base64url (A-Z a-z 0-9 - _). The leading byte is
 * the format version (1-6), so the first character is always A or B.
 * The old aotools format (slot groups separated by |) is still accepted.
 */
function looksLikeBuildCode(code) {
  if (/^[AB][A-Za-z0-9_-]{7,}$/.test(code)) return true;
  return /^[A-Za-z0-9,|.\-]+$/.test(code) && code.includes('|');
}

export default async (req) => {
  const store = getStore('builds');

  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'body must be JSON' }, 400);
    }

    const code = String(body?.code ?? '').trim();
    if (!code || code.length > MAX_CODE || !looksLikeBuildCode(code)) {
      return json({ error: 'invalid build code' }, 400);
    }

    const record = {
      id: crypto.randomUUID(),
      code,
      ep: Number.isFinite(body?.ep) ? body.ep : null,
      stats: body?.stats && typeof body.stats === 'object' ? body.stats : null,
      name: typeof body?.name === 'string' ? body.name.slice(0, MAX_NAME) : null,
      createdAt: new Date().toISOString()
    };

    await store.setJSON(record.id, record);
    return json(record, 201);
  }

  if (req.method === 'GET') {
    const limit = Math.min(
      Number(new URL(req.url).searchParams.get('limit')) || DEFAULT_LIMIT,
      200
    );
    const { blobs } = await store.list();
    const records = await Promise.all(
      blobs.map((b) => store.get(b.key, { type: 'json' }).catch(() => null))
    );
    const items = records
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
    return json({ count: items.length, items });
  }

  return json({ error: 'method not allowed' }, 405);
};

export const config = { path: '/api/builds' };
