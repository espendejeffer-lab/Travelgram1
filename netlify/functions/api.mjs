// TravelGram API for Netlify: a small document store on Netlify Blobs with the same
// access rules the class site used before, teacher sign-in, and chunked media uploads.
// Routes: /api/* (JSON) and /m/<id> (uploaded photos, videos, audio).
import { getStore } from "@netlify/blobs";
import { createHash, createHmac, randomBytes, timingSafeEqual, pbkdf2Sync } from "node:crypto";

export const config = { path: ["/api/*", "/m/*"] };

const CHUNK = 3 * 1024 * 1024;           // upload chunk size (request bodies must stay under ~4.5 MB)
const MAX_FILE = 20 * 1024 * 1024;       // same 20 MB limit the page enforces
const WINDOW = 20000;                    // re-send changes from the last 20 s on every sync
const KEEP_LOG = 60 * 60 * 1000;         // keep one hour of change log behind the snapshot
const SNAP_EVERY = 150;                  // rebuild the snapshot after this many logged changes
const MAX_DOC = 300 * 1024;
const UPLOADS_PER_DAY = 40;
const TYPES = new Set(["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime", "video/webm",
  "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/mpeg", "audio/webm", "audio/aac", "audio/ogg"]);

// Same rules as the original site: everyone reads by default, only the teacher writes, except:
const SELF_WRITE = new Set(["subs", "csubs", "psubs", "people", "reacts", "pcomments"]);
const SELF_READ = new Set(["subs", "csubs", "psubs", "people", "grades"]);      // own doc only
const TEACHER_READ = new Set(["subs", "csubs", "psubs", "people", "grades", "rosterfull", "tsec", "gradedrafts"]);
const NO_SYNC = new Set(["roster", "tsec"]);                                     // read one at a time
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

export function canRead(path, who) {
  if (who.admin) return true;
  const [c, id] = path.split("/");
  if (!TEACHER_READ.has(c)) return true;
  return SELF_READ.has(c) && !!who.uid && id === who.uid;
}
export function canWrite(path, who) {
  if (who.admin) return true;
  const [c, id] = path.split("/");
  return SELF_WRITE.has(c) && !!who.uid && id === who.uid;
}
const validPath = p => typeof p === "string" && p.split("/").length === 2 && p.split("/").every(s => SEG.test(s));
const key13 = t => String(Math.max(0, Math.floor(t))).padStart(13, "0");
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
function merge(a, b) { const out = { ...a }; for (const k in b) { const v = b[k]; out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v; } return out; }
const b64u = buf => Buffer.from(buf).toString("base64url");
export const uidFromToken = t => "u_" + createHash("sha256").update("tg|" + t).digest("base64url").slice(0, 22);

export function makeApi({ docs, logs, meta, media, env, now = () => Date.now() }) {
  const secret = () => env("TG_SECRET") || createHash("sha256").update("tg-secret|" + (env("TEACHER_PASSWORD") || "")).digest("hex");
  const sign = exp => `${exp}.${createHmac("sha256", secret()).update("adm|" + exp).digest("base64url")}`;
  const adminOk = tok => {
    if (!tok || typeof tok !== "string") return false;
    const [exp] = tok.split(".");
    if (!/^\d+$/.test(exp) || Number(exp) < now()) return false;
    const a = Buffer.from(sign(exp)), b = Buffer.from(tok);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const who = req => {
    const t = req.headers.get("x-tg-token") || "";
    const uid = /^[a-f0-9]{32,128}$/.test(t) ? uidFromToken(t) : null;
    return { uid, admin: adminOk(req.headers.get("x-tg-admin")) };
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  const fail = (code, status = 400) => json({ error: code }, status);

  async function readDoc(p) { try { return await docs.get(p, { type: "json" }); } catch (e) { return null; } }
  async function readMany(paths) {
    const out = {};
    for (let i = 0; i < paths.length; i += 25) {
      const part = paths.slice(i, i + 25);
      const vals = await Promise.all(part.map(readDoc));
      part.forEach((p, j) => { out[p] = vals[j]; });
    }
    return out;
  }
  async function listLogs() { const { blobs } = await logs.list(); return blobs.map(b => b.key).sort(); }
  const logPath = k => k.slice(k.indexOf("|") + 1);

  async function buildSnapshot() {
    const ver = key13(now() - WINDOW);
    const { blobs } = await docs.list();
    const all = await readMany(blobs.map(b => b.key));
    const snap = { ver, docs: Object.fromEntries(Object.entries(all).filter(([, v]) => v !== null)) };
    await meta.setJSON("snapshot", snap);
    // Mark the boundary first, so a client that still needs older changes does a full sync instead.
    const cut = key13(Number(ver) - KEEP_LOG);
    const prev = await meta.get("pruned", { type: "json" }).catch(() => null);
    if (!prev || prev.k < cut) await meta.setJSON("pruned", { k: cut });
    const old = (await listLogs()).filter(k => k < cut);
    for (let i = 0; i < old.length; i += 25) await Promise.all(old.slice(i, i + 25).map(k => logs.delete(k)));
    return snap;
  }

  async function sync(w, since, context) {
    const nextSince = key13(now() - WINDOW);
    const [snapRaw, prunedRaw, logKeys] = await Promise.all([
      meta.get("snapshot", { type: "json" }).catch(() => null), meta.get("pruned", { type: "json" }).catch(() => null), listLogs()]);
    let snap = snapRaw;
    const pruned = (prunedRaw && prunedRaw.k) || "0";
    const full = !since || since === "0" || since < pruned;
    let base = {}, from = since;
    if (full) {
      if (!snap) snap = await buildSnapshot();
      base = snap.docs; from = snap.ver;
    }
    const changed = [...new Set(logKeys.filter(k => k > from).map(logPath))];
    const fresh = await readMany(changed);
    const out = {};
    for (const [p, v] of Object.entries(full ? { ...base, ...fresh } : fresh)) {
      const c = p.split("/")[0];
      if (NO_SYNC.has(c) || !canRead(p, w)) continue;
      out[p] = v;
    }
    if (logKeys.length > SNAP_EVERY) {
      const job = buildSnapshot().catch(e => console.error("TravelGram snapshot", e));
      if (context && typeof context.waitUntil === "function") context.waitUntil(job); else await job;
    }
    return { full, since: nextSince, docs: out };
  }

  async function write(w, ops) {
    if (!Array.isArray(ops) || !ops.length || ops.length > 60) return fail("bad_request");
    for (const o of ops) {
      if (!o || !["set", "update", "delete"].includes(o.op) || !validPath(o.path)) return fail("bad_request");
      if (!canWrite(o.path, w)) return fail("permission_denied", 403);
      if (o.op !== "delete" && (!isObj(o.data) || JSON.stringify(o.data).length > MAX_DOC)) return fail("too_large");
    }
    for (const o of ops) {
      if (o.op === "set") await docs.setJSON(o.path, o.data);
      else if (o.op === "update") {
        const cur = await readDoc(o.path);
        if (!cur) return fail("invalid_argument");
        const next = merge(cur, o.data);
        if (JSON.stringify(next).length > MAX_DOC) return fail("too_large");
        await docs.setJSON(o.path, next);
      } else await docs.delete(o.path);
      await logs.set(`${key13(now())}${b64u(randomBytes(4))}|${o.path}`, "1");
    }
    return json({ ok: true });
  }

  async function passwordOk(pw) {
    if (typeof pw !== "string" || !pw) return false;
    const stored = await meta.get("teacher", { type: "json" }).catch(() => null);
    if (stored && stored.salt && stored.hash) {
      const h = pbkdf2Sync(pw, stored.salt, 120000, 32, "sha256").toString("hex");
      return timingSafeEqual(Buffer.from(h), Buffer.from(stored.hash));
    }
    const envPw = env("TEACHER_PASSWORD");
    if (!envPw) return false;
    const a = createHash("sha256").update(pw).digest(), b = createHash("sha256").update(envPw).digest();
    return timingSafeEqual(a, b);
  }
  async function login(body) {
    const lock = await meta.get("loginlock", { type: "json" }).catch(() => null) || { n: 0, until: 0 };
    if (lock.until > now()) return fail("too_many_attempts", 429);
    if (!env("TEACHER_PASSWORD") && !(await meta.get("teacher", { type: "json" }).catch(() => null))) return fail("not_set_up", 503);
    if (!(await passwordOk(body && body.password))) {
      const n = (lock.n || 0) + 1;
      await meta.setJSON("loginlock", n >= 5 ? { n: 0, until: now() + 60000 } : { n, until: 0 });
      return fail("wrong_password", 401);
    }
    await meta.setJSON("loginlock", { n: 0, until: 0 });
    return json({ admin: sign(now() + 12 * 3600 * 1000) });
  }
  async function setpw(w, body) {
    if (!w.admin) return fail("permission_denied", 403);
    if (!(await passwordOk(body && body.current))) return fail("wrong_password", 401);
    const next = body && body.next;
    if (typeof next !== "string" || next.length < 6) return fail("too_short");
    const salt = b64u(randomBytes(16));
    await meta.setJSON("teacher", { salt, hash: pbkdf2Sync(next, salt, 120000, 32, "sha256").toString("hex"), at: now() });
    return json({ ok: true });
  }

  async function uploadStart(w, body) {
    if (!w.uid && !w.admin) return fail("not_signed_in", 401);
    const type = String((body && body.type) || "").toLowerCase().split(";")[0], size = Number(body && body.size);
    if (!TYPES.has(type)) return fail("unsupported_type");
    if (!(size > 0) || size > MAX_FILE) return fail("too_large");
    if (!w.admin) {
      const qk = `q/${w.uid}/${new Date(now()).toISOString().slice(0, 10)}`;
      const q = await meta.get(qk, { type: "json" }).catch(() => null) || { n: 0 };
      if (q.n >= UPLOADS_PER_DAY) return fail("rate_limited", 429);
      await meta.setJSON(qk, { n: q.n + 1 });
    }
    const id = b64u(randomBytes(15));
    await media.setJSON(`${id}/meta`, { type, size, n: Math.ceil(size / CHUNK), owner: w.uid || "admin", done: false, at: now() });
    return json({ id, chunk: CHUNK });
  }
  async function uploadPart(w, id, n, req) {
    const m = await media.get(`${id}/meta`, { type: "json" }).catch(() => null);
    if (!m || m.done) return fail("not_found", 404);
    if (m.owner !== (w.uid || "admin") && !w.admin) return fail("permission_denied", 403);
    if (!(n >= 0 && n < m.n)) return fail("bad_request");
    const buf = await req.arrayBuffer();
    const want = n === m.n - 1 ? m.size - n * CHUNK : CHUNK;
    if (buf.byteLength !== want) return fail("bad_request");
    await media.set(`${id}/${n}`, buf);
    return json({ ok: true });
  }
  async function uploadDone(w, id) {
    const m = await media.get(`${id}/meta`, { type: "json" }).catch(() => null);
    if (!m) return fail("not_found", 404);
    if (m.owner !== (w.uid || "admin") && !w.admin) return fail("permission_denied", 403);
    const { blobs } = await media.list({ prefix: `${id}/` });
    const have = new Set(blobs.map(b => b.key));
    for (let i = 0; i < m.n; i++) if (!have.has(`${id}/${i}`)) return fail("incomplete");
    await media.setJSON(`${id}/meta`, { ...m, done: true });
    return json({ ref: "nb:" + id });
  }
  async function serveMedia(id, req) {
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) return new Response("Not found", { status: 404 });
    const m = await media.get(`${id}/meta`, { type: "json" }).catch(() => null);
    if (!m || !m.done) return new Response("Not found", { status: 404 });
    let start = 0, end = m.size - 1, status = 200;
    const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") || "");
    if (r && (r[1] || r[2])) {
      if (r[1]) { start = Number(r[1]); if (r[2]) end = Math.min(Number(r[2]), m.size - 1); }
      else { start = Math.max(0, m.size - Number(r[2])); }
      if (start > end || start >= m.size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${m.size}` } });
      status = 206;
    }
    const first = Math.floor(start / CHUNK), last = Math.floor(end / CHUNK);
    let i = first;
    const body = new ReadableStream({
      async pull(ctrl) {
        if (i > last) { ctrl.close(); return; }
        const buf = new Uint8Array(await media.get(`${id}/${i}`, { type: "arrayBuffer" }));
        const s = i === first ? start - i * CHUNK : 0, e = i === last ? end - i * CHUNK + 1 : buf.length;
        ctrl.enqueue(buf.subarray(s, e)); i++;
      }
    });
    const h = { "content-type": m.type, "accept-ranges": "bytes", "content-length": String(end - start + 1),
      "cache-control": "public, max-age=31536000, immutable", "netlify-cdn-cache-control": "public, max-age=31536000, immutable" };
    if (status === 206) h["content-range"] = `bytes ${start}-${end}/${m.size}`;
    return new Response(body, { status, headers: h });
  }

  return async function handle(req, context) {
    const url = new URL(req.url), p = url.pathname.replace(/\/+$/, "");
    try {
      if (p.startsWith("/m/")) return await serveMedia(p.slice(3), req);
      const w = who(req);
      if (req.method === "GET" && p === "/api/me") return json({ uid: w.uid, admin: w.admin });
      if (req.method === "GET" && p === "/api/sync") {
        if (!w.uid && !w.admin) return fail("not_signed_in", 401);
        return json(await sync(w, url.searchParams.get("since") || "0", context));
      }
      if (req.method === "GET" && p === "/api/doc") {
        const path = url.searchParams.get("p") || "";
        if (!validPath(path)) return fail("bad_request");
        if (!canRead(path, w)) return json({ exists: false });
        const d = await readDoc(path);
        return json(d ? { exists: true, data: d } : { exists: false });
      }
      let m;
      if (req.method === "PUT" && (m = /^\/api\/upload\/([A-Za-z0-9_-]{10,40})\/(\d{1,3})$/.exec(p))) return await uploadPart(w, m[1], Number(m[2]), req);
      if (req.method !== "POST") return fail("not_found", 404);
      if ((m = /^\/api\/upload\/([A-Za-z0-9_-]{10,40})\/done$/.exec(p))) return await uploadDone(w, m[1]);
      const body = await req.json().catch(() => null);
      if (p === "/api/write") { if (!w.uid && !w.admin) return fail("not_signed_in", 401); return await write(w, body && body.ops); }
      if (p === "/api/login") return await login(body);
      if (p === "/api/setpw") return await setpw(w, body);
      if (p === "/api/upload/start") return await uploadStart(w, body);
      return fail("not_found", 404);
    } catch (e) {
      console.error("TravelGram API error", e);
      return fail("server_error", 500);
    }
  };
}

// Netlify gives each invocation its own short-lived Blobs token, so the stores are opened per
// request. (Keeping them between requests made every call fail with "Token expired".)
const env = k => (globalThis.Netlify && Netlify.env.get(k)) || process.env[k] || "";
export default async (req, context) => {
  const store = name => getStore({ name, consistency: "strong" });
  const api = makeApi({ docs: store("tg-docs"), logs: store("tg-log"), meta: store("tg-meta"), media: store("tg-media"), env });
  return api(req, context);
};
