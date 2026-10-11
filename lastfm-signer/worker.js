// Kodama Karaoke — Last.fm request signer (Cloudflare Worker).
//
// Last.fm wants every sign-in and scrobble request "signed" with the app's shared secret. A
// secret shipped inside a desktop app can be dug out of it, so it lives here instead, as an
// encrypted Worker secret, and the app asks this Worker to sign each request.
//
//   GET  /key   → { api_key }                     (public anyway: it appears in the sign-in URL)
//   POST /sign  → { api_key, api_sig }            body: { params: { method, ...Last.fm params } }
//
// Only the methods Kodama actually uses can be signed (sign-in, now playing, scrobble, love). The
// Worker never sees or stores anyone's Last.fm password or listening data beyond the request it
// signs, and a signature is useless without the user's own session key for track.* methods.

const ALLOWED_METHODS = new Set([
  "auth.getToken",
  "auth.getSession",
  "track.updateNowPlaying",
  "track.scrobble",
  "track.love",
  "track.unlove",
]);
const MAX_PARAMS = 40;
const MAX_VALUE_LEN = 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });
}

/** Last.fm api_sig: md5 of the sorted key+value pairs (without format/callback) + secret. */
export function lastfmSignature(params, secret) {
  const raw = Object.keys(params)
    .filter((k) => k !== "format" && k !== "callback")
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join("");
  return md5(raw + secret);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (!env.LASTFM_API_KEY || !env.LASTFM_API_SECRET) return json({ error: "signer_not_configured" }, 503);

    if (url.pathname === "/key" && request.method === "GET") {
      return json({ api_key: env.LASTFM_API_KEY });
    }

    if (url.pathname === "/sign" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
      const params = body && typeof body.params === "object" ? body.params : null;
      if (!params || Array.isArray(params)) return json({ error: "bad_params" }, 400);
      if (!ALLOWED_METHODS.has(params.method)) return json({ error: "method_not_allowed" }, 403);
      const keys = Object.keys(params);
      if (keys.length > MAX_PARAMS) return json({ error: "too_many_params" }, 400);
      const clean = {};
      for (const k of keys) {
        const v = params[k];
        if (typeof v !== "string" && typeof v !== "number") return json({ error: "bad_value", key: k }, 400);
        const s = String(v);
        if (s.length > MAX_VALUE_LEN) return json({ error: "value_too_long", key: k }, 400);
        if (k === "api_key" || k === "api_sig") continue;   // we set these
        clean[k] = s;
      }
      clean.api_key = env.LASTFM_API_KEY;
      return json({ api_key: env.LASTFM_API_KEY, api_sig: lastfmSignature(clean, env.LASTFM_API_SECRET) });
    }

    return json({ error: "not_found" }, 404);
  },
};

// ── MD5 (RFC 1321) on UTF-8 strings ─────────────────────────────────────────────────────────
// Self-contained so the Worker does not depend on a runtime offering MD5 in WebCrypto.
export function md5(str) {
  const bytes = new TextEncoder().encode(str);
  const n = bytes.length;
  const words = new Uint32Array((((n + 8) >>> 6) + 1) * 16);
  for (let i = 0; i < n; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
  words[n >> 2] |= 0x80 << ((n % 4) * 8);
  words[words.length - 2] = (n * 8) >>> 0;
  words[words.length - 1] = Math.floor((n * 8) / 0x100000000);

  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < words.length; off += 16) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const tmp = d;
      d = c;
      c = b;
      const x = (a + f + K[i] + words[off + g]) >>> 0;
      const s = S[(i >> 4) * 4 + (i % 4)];
      b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const hex = (v) => Array.from({ length: 4 }, (_, i) => ((v >>> (i * 8)) & 0xff).toString(16).padStart(2, "0")).join("");
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}
