// TravelGram AI assessment assistant (background function, runs up to 15 minutes).
// The teacher's dashboard calls it with { id } for one submission:
//   "<uid>~s"        Team Story, speaking (S1), from the recorded audio/video
//   "<uid>~w~<pid>"  Trip Diary, writing (10W1–10W4) plus a separate photo check
// It writes the AI suggestion into the teacher-only "aiassess/<id>" doc as a draft.
// It never writes "aipub": only the teacher's "Approve and publish" does that.
import { getStore } from "@netlify/blobs";
import { GoogleGenAI } from "@google/genai";
import { adminAuth, logKey } from "./api.mjs";
import RUB from "../../site/rubrics.json" with { type: "json" };

const MODELS = ["gemini-3.1-pro-preview", "gemini-2.5-pro"];
const MAX_INLINE = 14 * 1024 * 1024;     // inline request limit, after base64
const MAX_PHOTOS = 8;
const ID = /^(u_[A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{3,60})~(s|w~[A-Za-z0-9_-]{3,60})$/;

const env = k => (globalThis.Netlify && Netlify.env.get(k)) || process.env[k] || "";
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const snap = v => { const n = Number(v); return n > 0 ? Math.min(4, Math.max(1, Math.round(n * 2) / 2)) : 0; };
const levelOf = v => RUB.levels[String(v)] || "";
const three = a => { const out = (Array.isArray(a) ? a : []).map(x => String(x || "").trim()).filter(Boolean).slice(0, 3); while (out.length < 3) out.push(""); return out; };
const rubricText = crit => crit.map(c => `${c.code} – ${c.title}\n` + RUB.steps.map(s => `  ${s.toFixed(1)} ${RUB.levels[String(s)]}: ${c.desc[String(s)].join(" ")}`).join("\n")).join("\n\n");

async function loadRef(ref, media, origin) {
  if (!ref || typeof ref !== "string") return null;
  if (ref.startsWith("nb:")) {
    const id = ref.slice(3);
    const m = await media.get(`${id}/meta`, { type: "json" }).catch(() => null);
    if (!m || !m.done) return null;
    if (m.size > MAX_INLINE) return { tooBig: true, type: m.type, size: m.size };
    const parts = [];
    for (let i = 0; i < m.n; i++) parts.push(Buffer.from(await media.get(`${id}/${i}`, { type: "arrayBuffer" })));
    return { type: m.type, buf: Buffer.concat(parts) };
  }
  if (ref.startsWith("st:") && /^media\/[A-Za-z0-9_.-]+$/.test(ref.slice(3))) {
    const r = await fetch(new URL("/" + ref.slice(3), origin)).catch(() => null);
    if (!r || !r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_INLINE) return { tooBig: true, size: buf.length };
    return { type: (r.headers.get("content-type") || "").split(";")[0], buf };
  }
  const d = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(ref);
  if (d) return { type: d[1], buf: Buffer.from(d[2], "base64") };
  return null;
}
const part = f => ({ inlineData: { mimeType: f.type === "audio/x-m4a" || f.type === "audio/m4a" ? "audio/mp4" : f.type === "video/quicktime" ? "video/mov" : f.type, data: f.buf.toString("base64") } });

async function ask(system, parts, schema) {
  const ai = new GoogleGenAI({});
  let last;
  for (const model of MODELS) {
    try {
      const r = await ai.models.generateContent({ model, contents: [{ role: "user", parts }],
        config: { systemInstruction: system, temperature: 0.2, responseMimeType: "application/json", responseJsonSchema: schema } });
      return { model, out: JSON.parse(r.text) };
    } catch (e) { last = e; console.error("TravelGram AI", model, e && e.message); }
  }
  throw last;
}

const str = { type: "string" }, list3 = { type: "array", items: str, minItems: 3, maxItems: 3 };
const scoreProp = { type: "number", minimum: 1, maximum: 4, description: "1.0 to 4.0 in 0.5 steps" };
const COMMON = `You are an assessment ASSISTANT for an English teacher. You only suggest; the teacher reviews, edits and decides what students see.
Rules:
- Use ONLY the rubric descriptors supplied. Do not add other criteria (for example, do not mark pronunciation, length or effort unless the descriptors mention it).
- Scores are 1.0 to 4.0 in 0.5 steps. Choose the band whose descriptors best match the evidence; a half band means the work sits between two bands.
- Every strength, improvement and comment must point to something specific in THIS submission (quote or closely paraphrase it). No generic advice.
- Write feedback for a secondary-school English learner: warm, clear, specific and actionable. Address the student as "you".
- Never invent evidence. If something cannot be heard, read or seen reliably, say so and add a flag for the teacher.`;

async function speaking(sub, cls, media, origin) {
  const S = RUB.speaking, flags = [];
  const f = await loadRef(sub.media, media, origin);
  if (!sub.media) return { unprocessable: "No recording is attached to this Team Story." };
  if (!f) return { unprocessable: "The recording could not be loaded. It may have been removed or the upload did not finish." };
  if (f.tooBig) return { unprocessable: `The recording is ${(f.size / 1048576).toFixed(1)} MB, too large for the AI to process (limit about 14 MB). Please listen and assess it yourself.` };
  const system = `${COMMON}

Task: assess a student's "${S.title}" (Team Stories, skill focus: ${S.skill}) on one criterion:
${rubricText(S.crit)}

Listen to the recording itself. Judge the clarity, relevance, development and organisation of the ideas the student communicates, and their descriptions, supporting details, opinions and personal reflections. A transcript helps you cite evidence, but assess what is actually said in the recording, not the written script. The script is context only.
If the recording is silent, mostly unintelligible, mostly music/noise, not in English, or clearly not a student's spoken blogpost, set "intelligible" to false, explain why in "flags", and give your best cautious suggestion only from what can genuinely be heard.
The file may be a video; assess only the spoken communication.`;
  const ctx = `Class: ${cls}. Project type: ${RUB.projects[sub.cat] || "not stated"}. Title: ${sub.title || "(none)"}. Destination: ${sub.destination || "(none)"}.
Short description by the student: ${sub.desc || "(none)"}
Written script (context only, do not assess it): ${sub.script ? sub.script.slice(0, 4000) : "(none submitted)"}
The recording follows.`;
  const schema = { type: "object", required: ["intelligible", "transcript", "score", "level", "evidence", "strengths", "improvements", "feedback", "flags"], properties: {
    intelligible: { type: "boolean" }, transcript: { type: "string", description: "Close transcript of what the student says; mark unclear parts as [unclear]." },
    score: scoreProp, level: { type: "string", enum: Object.values(RUB.levels) },
    evidence: { type: "string", description: "Why this band fits: compare the recording with the descriptors, citing moments from the recording." },
    strengths: list3, improvements: list3, feedback: { type: "string", description: "Overall feedback paragraph for the student." },
    flags: { type: "array", items: str, description: "Problems the teacher should check (unclear audio, missing content, possible not-own work). Empty if none." } } };
  const { model, out } = await ask(system, [{ text: ctx }, part(f)], schema);
  const score = snap(out.score);
  if (!out.intelligible) flags.push("The AI could not reliably hear or understand all of the recording. Listen before approving.");
  return { model, transcript: String(out.transcript || ""), score, level: levelOf(score), evidence: String(out.evidence || ""),
    strengths: three(out.strengths), improvements: three(out.improvements), feedback: String(out.feedback || ""),
    flags: [...flags, ...(out.flags || []).map(String).filter(Boolean)], intelligible: !!out.intelligible };
}

async function writing(it, cls, media, origin) {
  const W = RUB.writing, flags = [];
  const story = String(it.story || "").trim();
  if (!story) return { unprocessable: "This Trip Diary has no written description to assess." };
  const gallery = (Array.isArray(it.gallery) && it.gallery.length ? it.gallery : it.photo ? [{ ref: it.photo, kind: "image" }] : []).filter(g => g && g.ref);
  const imgs = gallery.filter(g => g.kind !== "video"), vids = gallery.length - imgs.length, photos = [];
  for (const [i, g] of imgs.slice(0, MAX_PHOTOS).entries()) {
    const f = await loadRef(g.ref, media, origin);
    if (f && !f.tooBig && /^image\//.test(f.type)) photos.push({ ...f, n: i + 1 }); else flags.push(`Photo ${i + 1} could not be loaded for the AI. Check it yourself.`);
  }
  if (imgs.length > MAX_PHOTOS) flags.push(`Only the first ${MAX_PHOTOS} of ${imgs.length} photos were checked.`);
  if (vids) flags.push(`${vids} video${vids > 1 ? "s were" : " was"} not checked by the AI (photos only).`);
  const det = it.details && Object.keys(it.details).length ? JSON.stringify(it.details).slice(0, 1500) : "(none)";
  const system = `${COMMON}

Task: assess a student's "${W.title}" (Trip Diary, skill focus: ${W.skill}). Assess the written description on four criteria, each INDEPENDENTLY, using these descriptors:
${rubricText(W.crit)}

Then, SEPARATELY (this is not part of the writing score), check how the photographs relate to the writing:
- Are the photos relevant to the travel experience, food review or adventure described?
- Is the writing consistent with what is visible in the photos?
- Do the photos give meaningful visual support to the information?
- Are there obvious contradictions (for example the text says pho but the photo clearly shows pizza, or a beach trip with photos of snow)?
Do NOT expect every event in the text to appear in a photo; missing coverage is normal and is not a mismatch. Flag "possible_mismatch" only for real contradictions or photos clearly unrelated to the post, and explain the concern. Use "unclear" when photos cannot be reliably interpreted, and "no_photos" when none were provided. Describe only what you can actually see.`;
  const ctx = `Class: ${cls}. Project type: ${RUB.projects[it.cat] || "not stated"}. Title: ${it.title || "(none)"}. Destination: ${it.destination || "(none)"}. Date: ${it.date || "(none)"}.
Structured details the student filled in (context only): ${det}
WRITTEN DESCRIPTION TO ASSESS:
"""
${story.slice(0, 8000)}
"""
${photos.length ? `${photos.length} photo(s) follow, each labelled with its number.` : "No photos were provided."}`;
  const crit = { type: "object", required: ["score", "rationale"], properties: { score: scoreProp, rationale: { type: "string", description: "How the text matches this criterion's descriptors, quoting the student's writing." } } };
  const schema = { type: "object", required: ["criteria", "strengths", "improvements", "feedback", "alignment", "flags"], properties: {
    criteria: { type: "object", required: W.crit.map(c => c.id), properties: Object.fromEntries(W.crit.map(c => [c.id, crit])) },
    strengths: list3, improvements: list3, feedback: { type: "string", description: "Overall feedback paragraph for the student about their writing." },
    alignment: { type: "object", required: ["status", "summary", "photos", "concerns", "studentFeedback"], properties: {
      status: { type: "string", enum: ["consistent", "possible_mismatch", "unclear", "no_photos"] },
      summary: { type: "string", description: "For the teacher: overall relationship between photos and text." },
      photos: { type: "array", items: { type: "object", required: ["n", "seen", "fit"], properties: { n: { type: "integer" }, seen: { type: "string", description: "What is visible." }, fit: { type: "string", description: "How it relates to the text." } } } },
      concerns: { type: "array", items: str, description: "Specific possible mismatches or contradictions. Empty if none." },
      studentFeedback: { type: "string", description: "One or two sentences for the student about how well their photos support their writing." } } },
    flags: { type: "array", items: str, description: "Problems the teacher should check. Empty if none." } } };
  const { model, out } = await ask(system, [{ text: ctx }, ...photos.flatMap(f => [{ text: `Photo ${f.n}:` }, part(f)])], schema);
  const criteria = {};
  for (const c of W.crit) { const x = (out.criteria || {})[c.id] || {}, s = snap(x.score); criteria[c.id] = { score: s, level: levelOf(s), rationale: String(x.rationale || "") }; }
  const al = isObj(out.alignment) ? out.alignment : {};
  const status = photos.length ? (["consistent", "possible_mismatch", "unclear"].includes(al.status) ? al.status : "unclear") : "no_photos";
  if (status === "possible_mismatch") flags.unshift("Possible mismatch between the photos and the writing. Check the photo notes.");
  if (status === "unclear") flags.unshift("The AI could not reliably interpret the photos. Check them yourself.");
  return { model, criteria, total: W.crit.reduce((n, c) => n + criteria[c.id].score, 0), strengths: three(out.strengths), improvements: three(out.improvements),
    feedback: String(out.feedback || ""), flags: [...flags, ...(out.flags || []).map(String).filter(Boolean)],
    alignment: { status, summary: String(al.summary || ""), photos: (al.photos || []).slice(0, MAX_PHOTOS).map(p => ({ n: Number(p.n) || 0, seen: String(p.seen || ""), fit: String(p.fit || "") })),
      concerns: (al.concerns || []).map(String).filter(Boolean), studentFeedback: String(al.studentFeedback || "") } };
}

// The teacher's editable working copy, started from the AI suggestion.
function curFrom(type, ai) {
  if (type === "speak") return { score: ai.score || 0, level: ai.level || "", strengths: ai.strengths || three([]), improvements: ai.improvements || three([]), feedback: ai.feedback || "" };
  const scores = {}; RUB.writing.crit.forEach(c => { scores[c.id] = (ai.criteria && ai.criteria[c.id] && ai.criteria[c.id].score) || 0; });
  return { scores, strengths: ai.strengths || three([]), improvements: ai.improvements || three([]), feedback: ai.feedback || "",
    alignNote: (ai.alignment && ai.alignment.studentFeedback) || "", alignScore: 0 };
}

export default async (req) => {
  const now = Date.now();
  if (req.method !== "POST" || !adminAuth(env).adminOk(req.headers.get("x-tg-admin"))) return;
  const body = await req.json().catch(() => null), id = body && body.id, m = typeof id === "string" && ID.exec(id);
  if (!m) return;
  const store = name => getStore({ name, consistency: "strong" });
  const docs = store("tg-docs"), logs = store("tg-log"), media = store("tg-media");
  const path = "aiassess/" + id, uid = m[1], type = m[2] === "s" ? "speak" : "write", pid = type === "write" ? m[2].slice(2) : "";
  const read = async p => { try { return await docs.get(p, { type: "json" }); } catch (e) { return null; } };
  const save = async patch => {
    const prev = (await read(path)) || {};
    await docs.setJSON(path, { ...prev, ...patch });
    await logs.set(logKey(path), "1");
  };
  try {
    const src = type === "speak" ? await read("subs/" + uid) : ((await read("psubs/" + uid)) || {}).items?.[pid];
    if (!src) { await save({ job: { state: "error", at: now, error: "The submission could not be found." } }); return; }
    const classes = (await read("config/classes")) || {}, k = src.k || ((await read("psubs/" + uid)) || {}).k || "s10";
    const cls = ((classes.list || []).find(c => c.k === k) || {}).name || k;
    const origin = new URL(req.url).origin;
    const res = type === "speak" ? await speaking(src, cls, media, origin) : await writing(src, cls, media, origin);
    if (res.unprocessable) {
      await save({ k, uid, type, pid, job: { state: "flagged", at: Date.now(), error: res.unprocessable } });
      return;
    }
    const prev = (await read(path)) || {};
    const ai = { ...res, at: Date.now(), title: src.title || "", cat: src.cat || "" };
    await save({ k, uid, type, pid, ai, cur: curFrom(type, ai),
      aiHistory: prev.ai ? [prev.ai, ...(prev.aiHistory || [])].slice(0, 5) : (prev.aiHistory || []),
      history: prev.cur ? [{ action: "replaced by new AI suggestion", at: Date.now(), cur: prev.cur }, ...(prev.history || [])].slice(0, 20) : (prev.history || []),
      status: prev.status === "published" ? "published" : "draft", job: { state: "done", at: Date.now(), error: "" } });
  } catch (e) {
    console.error("TravelGram AI assessment", e);
    await save({ job: { state: "error", at: Date.now(), error: "The AI service didn't respond. Try again in a minute." } }).catch(() => { });
  }
};
