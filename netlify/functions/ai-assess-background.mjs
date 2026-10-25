// TravelGram AI assessment assistant (background function, runs up to 15 minutes).
// The teacher's dashboard calls it with { id } for one submission:
//   "<uid>~s"        Team Story, speaking, from the recorded audio/video (+ comment questions/answers
//                    when the class's speaking rubric has an interaction criterion, e.g. 9Sc.02)
//   "<uid>~w~<pid>"  Trip Diary, writing, plus a separate photo check
// The rubric is the one chosen for the class in "Change assessment" (rubrics.json "sets").
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
// Rubric chosen for this class and section: teacher's choice, else the class rubric's default.
export function rubricSet(section, classEntry, clsCfg) {
  const sets = RUB.sets[section], d = RUB.defaults[section];
  const id = [clsCfg && clsCfg.axSets && clsCfg.axSets[section], d[(classEntry && classEntry.rubric) || ""], d["*"]].find(x => x && sets[x]);
  const r = sets[id];
  return { ...r, steps: r.steps || RUB.steps, levels: r.levels || RUB.levels, max: r.crit.length * 4 };
}
const snap = (v, R) => { const n = Number(v); if (!(n > 0)) return 0; return R.steps.reduce((b, s) => Math.abs(s - n) < Math.abs(b - n) ? s : b, R.steps[0]); };
const levelOf = (v, R) => R.levels[String(v)] || "";
const three = a => { const out = (Array.isArray(a) ? a : []).map(x => String(x || "").trim()).filter(Boolean).slice(0, 3); while (out.length < 3) out.push(""); return out; };
const rubricText = R => R.crit.map(c => `${c.code} – ${c.title}${c.focus ? ` (focus: ${c.focus})` : ""}\n` + R.steps.map(s => `  ${s} ${R.levels[String(s)]}: ${c.desc[String(s)].join(" ")}`).join("\n")).join("\n\n");
const scaleText = R => R.steps.every(Number.isInteger) ? "Scores are whole numbers from 1 to 4 (no half points)." : "Scores are 1.0 to 4.0 in 0.5 steps; a half band means the work sits between two bands.";
const critSchema = R => { const one = { type: "object", required: ["score", "rationale"], properties: { score: { type: "number", minimum: 1, maximum: 4 }, rationale: { type: "string", description: "How the evidence matches this criterion's descriptors, citing the submission." } } };
  return { type: "object", required: R.crit.map(c => c.id), properties: Object.fromEntries(R.crit.map(c => [c.id, one])) }; };
const critOut = (R, o) => { const out = {}; for (const c of R.crit) { const x = (o || {})[c.id] || {}, v = snap(x.score, R); out[c.id] = { score: v, level: levelOf(v, R), rationale: String(x.rationale || "") }; } return out; };

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
const COMMON = `You are an assessment ASSISTANT for an English teacher. You only suggest; the teacher reviews, edits and decides what students see.
Rules:
- Use ONLY the rubric descriptors supplied. Do not add other criteria (for example, do not mark pronunciation, length or effort unless the descriptors mention it).
- Choose the band whose descriptors best match the evidence. Assess each criterion independently.
- Every strength, improvement and comment must point to something specific in THIS submission (quote or closely paraphrase it). No generic advice.
- Write feedback for a secondary-school English learner: warm, clear, specific and actionable. Address the student as "you".
- Never invent evidence. If something cannot be heard, read or seen reliably, say so and add a flag for the teacher.`;

async function speaking(sub, cls, media, origin, S, inter) {
  const flags = [];
  const f = await loadRef(sub.media, media, origin);
  if (!sub.media) return { unprocessable: "No recording is attached to this Team Story." };
  if (!f) return { unprocessable: "The recording could not be loaded. It may have been removed or the upload did not finish." };
  if (f.tooBig) return { unprocessable: `The recording is ${(f.size / 1048576).toFixed(1)} MB, too large for the AI to process (limit about 14 MB). Please listen and assess it yourself.` };
  const ic = S.crit.filter(c => c.interaction);
  const system = `${COMMON}
- ${scaleText(S)}

Task: assess a student's "${S.title}" (Team Stories, skill focus: ${S.skill}) on ${S.crit.length} criteria, maximum ${S.max} points:
${rubricText(S)}

Listen to the recording itself. Judge the clarity, relevance, development and organisation of the ideas the student communicates, and their descriptions, supporting details, opinions and personal reflections. A transcript helps you cite evidence, but assess what is actually said in the recording, not the written script. The script is context only.
${ic.length ? `For ${ic.map(c => c.code).join(", ")} (questioning and interaction), use BOTH any questions or interaction in the recording AND the written class interaction supplied below: questions the student asked on classmates' posts, and the student's replies to questions on their own post. If there is little or no interaction evidence, say so in the rationale, score only from what exists, and add a flag for the teacher.` : ""}
If the recording is silent, mostly unintelligible, mostly music/noise, not in English, or clearly not a student's spoken blogpost, set "intelligible" to false, explain why in "flags", and give your best cautious suggestion only from what can genuinely be heard.
The file may be a video; assess only the spoken communication.`;
  const ctx = `Class: ${cls}. Project type: ${RUB.projects[sub.cat] || "not stated"}. Title: ${sub.title || "(none)"}. Destination: ${sub.destination || "(none)"}.
Short description by the student: ${sub.desc || "(none)"}
Written script (context only, do not assess it): ${sub.script ? sub.script.slice(0, 4000) : "(none submitted)"}
${ic.length ? `CLASS INTERACTION EVIDENCE (written comments on TravelGram):\n${inter}` : ""}
The recording follows.`;
  const schema = { type: "object", required: ["intelligible", "transcript", "criteria", "strengths", "improvements", "feedback", "flags"], properties: {
    intelligible: { type: "boolean" }, transcript: { type: "string", description: "Close transcript of what the student says; mark unclear parts as [unclear]." },
    criteria: critSchema(S), strengths: list3, improvements: list3, feedback: { type: "string", description: "Overall feedback paragraph for the student." },
    flags: { type: "array", items: str, description: "Problems the teacher should check (unclear audio, missing content, little interaction evidence). Empty if none." } } };
  const { model, out } = await ask(system, [{ text: ctx }, part(f)], schema);
  const criteria = critOut(S, out.criteria), total = S.crit.reduce((n, c) => n + criteria[c.id].score, 0);
  if (!out.intelligible) flags.push("The AI could not reliably hear or understand all of the recording. Listen before approving.");
  return { model, set: S.id, transcript: String(out.transcript || ""), criteria, total, level: S.crit.length === 1 ? criteria[S.crit[0].id].level : "",
    evidence: S.crit.length === 1 ? criteria[S.crit[0].id].rationale : "",
    strengths: three(out.strengths), improvements: three(out.improvements), feedback: String(out.feedback || ""),
    flags: [...flags, ...(out.flags || []).map(String).filter(Boolean)], intelligible: !!out.intelligible };
}

// Questions the student asked on classmates' posts, and their replies on their own Team Story / Trip Diaries.
async function interaction(docs, uid, read) {
  const author = pid => String(pid || "").split("~")[0];
  const all = [];
  const { blobs } = await docs.list({ prefix: "comments/" });
  for (let i = 0; i < blobs.length; i += 25) (await Promise.all(blobs.slice(i, i + 25).map(b => read(b.key)))).forEach(c => c && all.push({ ...c }));
  const pc = await docs.list({ prefix: "pcomments/" });
  for (const b of pc.blobs) { const d = await read(b.key); Object.values((d && d.items) || {}).forEach(c => { if (c && (c.status === "live" || !c.status)) all.push({ ...c, authorUid: b.key.slice(10) }); }); }
  all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const line = c => `- ${String(c.text || "").replace(/\s+/g, " ").slice(0, 300)}`;
  const asked = all.filter(c => c.authorUid === uid && author(c.postId) !== uid).slice(0, 30);
  const mine = all.filter(c => author(c.postId) === uid).slice(0, 40);
  return `Questions/comments the student wrote on classmates' posts (${asked.length}):\n${asked.map(line).join("\n") || "(none)"}\n\nConversation on the student's own posts, in order (${mine.length}):\n${mine.map(c => `${c.authorUid === uid ? "STUDENT" : "Classmate " + (c.name || "")}: ${String(c.text || "").replace(/\s+/g, " ").slice(0, 300)}`).join("\n") || "(none)"}`;
}

async function writing(it, cls, media, origin, W) {
  const flags = [];
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

- ${scaleText(W)}

Task: assess a student's "${W.title}" (Trip Diary, skill focus: ${W.skill}). Assess the written description on ${W.crit.length} criteria, each INDEPENDENTLY, maximum ${W.max} points, using these descriptors:
${rubricText(W)}

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
  const schema = { type: "object", required: ["criteria", "strengths", "improvements", "feedback", "alignment", "flags"], properties: {
    criteria: critSchema(W),
    strengths: list3, improvements: list3, feedback: { type: "string", description: "Overall feedback paragraph for the student about their writing." },
    alignment: { type: "object", required: ["status", "summary", "photos", "concerns", "studentFeedback"], properties: {
      status: { type: "string", enum: ["consistent", "possible_mismatch", "unclear", "no_photos"] },
      summary: { type: "string", description: "For the teacher: overall relationship between photos and text." },
      photos: { type: "array", items: { type: "object", required: ["n", "seen", "fit"], properties: { n: { type: "integer" }, seen: { type: "string", description: "What is visible." }, fit: { type: "string", description: "How it relates to the text." } } } },
      concerns: { type: "array", items: str, description: "Specific possible mismatches or contradictions. Empty if none." },
      studentFeedback: { type: "string", description: "One or two sentences for the student about how well their photos support their writing." } } },
    flags: { type: "array", items: str, description: "Problems the teacher should check. Empty if none." } } };
  const { model, out } = await ask(system, [{ text: ctx }, ...photos.flatMap(f => [{ text: `Photo ${f.n}:` }, part(f)])], schema);
  const criteria = critOut(W, out.criteria);
  const al = isObj(out.alignment) ? out.alignment : {};
  const status = photos.length ? (["consistent", "possible_mismatch", "unclear"].includes(al.status) ? al.status : "unclear") : "no_photos";
  if (status === "possible_mismatch") flags.unshift("Possible mismatch between the photos and the writing. Check the photo notes.");
  if (status === "unclear") flags.unshift("The AI could not reliably interpret the photos. Check them yourself.");
  return { model, set: W.id, criteria, total: W.crit.reduce((n, c) => n + criteria[c.id].score, 0), strengths: three(out.strengths), improvements: three(out.improvements),
    feedback: String(out.feedback || ""), flags: [...flags, ...(out.flags || []).map(String).filter(Boolean)],
    alignment: { status, summary: String(al.summary || ""), photos: (al.photos || []).slice(0, MAX_PHOTOS).map(p => ({ n: Number(p.n) || 0, seen: String(p.seen || ""), fit: String(p.fit || "") })),
      concerns: (al.concerns || []).map(String).filter(Boolean), studentFeedback: String(al.studentFeedback || "") } };
}

// The teacher's editable working copy, started from the AI suggestion.
function curFrom(type, ai) {
  const scores = Object.fromEntries(Object.entries(ai.criteria || {}).map(([k, v]) => [k, v.score || 0]));
  const base = { set: ai.set, scores, strengths: ai.strengths || three([]), improvements: ai.improvements || three([]), feedback: ai.feedback || "" };
  return type === "speak" ? { ...base, level: ai.level || "" } : { ...base, alignNote: (ai.alignment && ai.alignment.studentFeedback) || "", alignScore: 0 };
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
    const entry = (classes.list || []).find(c => c.k === k) || { k, rubric: { "9e6": "s9" }[k] || "" }, cls = entry.name || k;
    const R = rubricSet(type === "speak" ? "speaking" : "writing", entry, await read("config/" + (k === "s10" ? "class" : "class-" + k)));
    const origin = new URL(req.url).origin;
    const res = type === "speak" ? await speaking(src, cls, media, origin, R, R.crit.some(c => c.interaction) ? await interaction(docs, uid, read) : "")
      : await writing(src, cls, media, origin, R);
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
