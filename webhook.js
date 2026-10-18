// Telegram bot on Vercel.
//
//  - Text message / /start       -> main menu with buttons (Insho yuborish, Profil, Arxiv, Yordam)
//  - Photos / images / PDFs      -> every file the student sends is collected; a few seconds after the
//                                   last one the whole set goes to the AI together. The AI decides
//                                   whether the files are one essay or several and replies in Uzbek.
//  - /tahlil                     -> start the analysis right now (no waiting)
//
// Environment variables:
//   BOT_TOKEN              Telegram bot token (required)
//   WEBHOOK_SECRET         secret checked on every Telegram request
//   GEMINI_API_KEY         essay feedback with Google Gemini
//   GEMINI_MODEL           optional, default gemini-flash-latest
//   ANTHROPIC_API_KEY      essay feedback with Claude (alternative)
//   CLAUDE_MODEL           optional, default claude-sonnet-5-5
//   PROVIDER               optional: gemini | claude (default: gemini if GEMINI_API_KEY is set)
//   REPLY_LANG             optional, default Uzbek (Latin script)
//   ALLOWED_USERS          optional, comma-separated usernames / ids allowed to use essay feedback
//   BLOB_READ_WRITE_TOKEN  Vercel Blob token (shared storage that holds the files until analysis)
//   BATCH_WAIT_MS          optional, seconds to wait for more files, default 8000
const report = require('../lib/report');
const { renderPdf, renderPng } = require('../lib/render');
const SAMPLE = require('../lib/sample.json');

const TOKEN = process.env.BOT_TOKEN;
const SECRET = process.env.WEBHOOK_SECRET;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const PROVIDER = (process.env.PROVIDER || (GEMINI_KEY ? 'gemini' : 'claude')).toLowerCase();
const REPLY_LANG = process.env.REPLY_LANG || 'Uzbek (Latin script)';
const ALLOWED = (process.env.ALLOWED_USERS || '')
  .split(',')
  .map((s) => s.trim().replace(/^@/, '').toLowerCase())
  .filter(Boolean);

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const BLOB_API = 'https://blob.vercel-storage.com';
const BLOB_VERSION = process.env.BLOB_API_VERSION || '11';
const WAIT_MS = Number(process.env.BATCH_WAIT_MS || 8000);

const MAX_FILES = 12; // files analysed together
const MAX_TOTAL_BYTES = 14 * 1024 * 1024; // keeps the AI request under ~20 MB
const MAX_CLAUDE_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a senior Uzbek-language writing teacher and examiner. A student sends photos, scans or PDFs of their handwritten or typed essays. You receive ALL files of one submission, in the order they were sent. They can be:
- several pages of ONE essay (this includes the front and back of one sheet of paper),
- several DIFFERENT essays (each with one or more pages),
- or a mix of both.

STEP 1 - READ AND GROUP (do this carefully before you write anything)
- Read every file completely. Photos may be rotated, upside down, tilted, shadowed or blurry, and the ink from the reverse side of a sheet may show through. Ignore the show-through and read the side facing the camera. A PDF can contain several pages - read them all.
- Decide which pages belong to the same essay. Evidence for "same essay": the text or sentence continues across the page break; one page has an introduction and the other the conclusion; page numbers; the same title or topic; the same handwriting, pen colour and paper; the pages look like the front and back of one sheet. Evidence for "new essay": a new title or topic, a fresh introduction, a finished conclusion followed by a new start, a clearly different handwriting or paper.
- Files may be uploaded out of order. If the content shows a different logical order, read in that order and say so.
- Never merge two clearly different essays and never split one essay into two. If you are not sure, choose the most likely option and say in one sentence what you assumed and why.
- Mention problems: an essay that stops in the middle (a page may be missing), a file you cannot read, or a file that is not an essay (skip it and say so).

STEP 2 - ANALYSE EACH ESSAY SEPARATELY AND SPECIFICALLY
- Quote the student's real words, exactly as written (in their script). Every comment must point to a quote or to a precise place (paragraph number, line). No generic advice that would fit any essay.
- Do not invent text that is not in the essay. If handwriting is unclear, write [?] in the quote and do not guess.
- If the student's note names the topic, exam type or what to focus on, follow it.

OUTPUT FORMAT
Return ONLY one valid JSON object: no markdown, no code fences, no text before or after it. Write all explanations and labels in ${REPLY_LANG}; corrections, suggested words and example sentences must be in Uzbek, in the same script as the essay (Latin or Cyrillic). Use plain text inside the strings (no markdown). Keep every string short and concrete.

{
  "files_total": <number of files received>,
  "overview_note": "<one or two sentences: how you grouped the files and what you assumed, missing pages, unreadable or non-essay files; empty string if nothing to say>",
  "essays": [
    {
      "files": "<which files belong to this essay, e.g. 1-2 or 3>",
      "title": "<essay topic or title, short>",
      "topic_summary": "<2-3 sentences: what the student argues and how convincingly>",
      "level": "<exactly one of: Boshlang'ich | O'rta | Yuqori-o'rta | Yuqori>",
      "score": <approximate overall score from 0 to 10, one decimal>,
      "score_reason": "<one sentence>",
      "rubric": { "grammar": <0-10>, "vocabulary": <0-10>, "structure": <0-10>, "content": <0-10> },
      "strengths": [ { "point": "<specific strength>", "quote": "<exact words from the essay>" } ],
      "mistakes": [ { "original": "<exact words from the essay>", "corrected": "<corrected version>", "reason": "<short rule or reason>" } ],
      "vocabulary": [ { "weak": "<weak, repeated, vague or too colloquial word/phrase FROM THIS ESSAY>", "better": "<stronger alternative>", "example": "<short example sentence>" } ],
      "linking_phrases": [ "<linking phrase that fits this essay>" ],
      "structure": { "intro": "<introduction and thesis>", "body": "<arguments, examples, one idea per paragraph>", "conclusion": "<conclusion>", "notes": "<logic, flow, anything off-topic or missing>" },
      "next_steps": [ "<concrete action for the next essay>" ],
      "improved_version": { "about": "<which part you rewrote, e.g. the weakest paragraph or the introduction>", "text": "<that part rewritten in better Uzbek>" }
    }
  ]
}

Rules for the lists: strengths 2-4 items, each with an exact quote; mistakes at most 10, most important first, grouping repeated error types (for example o' / g' apostrophes, -da/-dan/-ga endings, compound words, commas, word order, wrong word meaning); vocabulary 6-10 items; linking_phrases 3-5 items (masalan, shu bilan birga, xulosa qilib aytganda...); next_steps 3-5 items.
Create exactly one entry in "essays" per essay you identified after grouping the files. A file that is not an essay or cannot be read gets no entry - mention it in overview_note instead. Scores are approximate. STYLE: encouraging but honest and concrete; short sentences.`;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeError(err) {
  let s = String((err && err.message) || err);
  for (const secret of [TOKEN, GEMINI_KEY, ANTHROPIC_KEY, SECRET, BLOB_TOKEN]) {
    if (secret) s = s.split(secret).join('***');
  }
  return s.slice(0, 500);
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------
async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', body });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) console.error(method, 'failed:', JSON.stringify(json));
  return json;
}

function form(fields) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== '') f.append(k, String(v));
  return f;
}

// markup: array of button rows [[{text, callback_data}]] or undefined
const kb = (rows) => (rows ? JSON.stringify({ inline_keyboard: rows }) : undefined);
const sendText = (chatId, text, rows) => tg('sendMessage', form({ chat_id: chatId, text, reply_markup: kb(rows) }));
const editText = (chatId, messageId, text, rows) =>
  tg('editMessageText', form({ chat_id: chatId, message_id: messageId, text, reply_markup: kb(rows) }));
const answerCb = (id, text) => tg('answerCallbackQuery', form({ callback_query_id: id, text }));
const typing = (chatId) => tg('sendChatAction', form({ chat_id: chatId, action: 'typing' }));
const react = (chatId, messageId, emoji = '\u{1F440}') =>
  tg('setMessageReaction', form({ chat_id: chatId, message_id: messageId, reaction: JSON.stringify([{ type: 'emoji', emoji }]) }));

// Telegram messages are limited to 4096 chars: split on paragraph / line boundaries.
async function sendLong(chatId, text, rowsForLast) {
  const LIMIT = 3900;
  let rest = text.trim();
  while (rest.length > 0) {
    if (rest.length <= LIMIT) { await sendText(chatId, rest, rowsForLast); break; }
    let cut = rest.lastIndexOf('\n\n', LIMIT);
    if (cut < LIMIT / 2) cut = rest.lastIndexOf('\n', LIMIT);
    if (cut < LIMIT / 2) cut = LIMIT;
    await sendText(chatId, rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
}

// Upload a generated file (PDF / PNG) as a document
async function sendFile(chatId, buffer, filename, mime, caption, rows) {
  const f = form({ chat_id: chatId, caption, reply_markup: kb(rows) });
  f.append('document', new Blob([buffer], { type: mime }), filename);
  return tg('sendDocument', f);
}

async function downloadTelegramFile(fileId) {
  const info = await fetch(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`).then((r) => r.json());
  if (!info.ok) throw new Error('getFile failed: ' + JSON.stringify(info));
  const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${info.result.file_path}`);
  if (!r.ok) throw new Error('file download failed: ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Shared state (Vercel Blob over its REST API; in-memory fallback)
// One small JSON blob per received file: batch/<chatId>/<zero-padded update_id>.json
// ---------------------------------------------------------------------------
const mem = new Map(); // fallback when Blob is not configured: chatId -> [{uid, item}]

const blobHeaders = (extra = {}) => ({ authorization: `Bearer ${BLOB_TOKEN}`, 'x-api-version': BLOB_VERSION, ...extra });
const uidFromPath = (p) => Number(p.split('/').pop().replace('.json', ''));
const blobPath = (chatId, uid) => `batch/${chatId}/${String(uid).padStart(12, '0')}.json`;

const state = {
  async add(chatId, uid, item) {
    if (BLOB_TOKEN) {
      try {
        const r = await fetch(`${BLOB_API}/?pathname=${encodeURIComponent(blobPath(chatId, uid))}`, {
          method: 'PUT',
          headers: blobHeaders({ 'x-content-type': 'application/json', 'x-add-random-suffix': '0', 'x-allow-overwrite': '1', 'x-cache-control-max-age': '60' }),
          body: JSON.stringify(item),
        });
        if (r.ok) return;
        console.error('blob put failed', r.status, (await r.text()).slice(0, 200));
      } catch (e) { console.error('blob put error', e); }
    }
    const list = mem.get(chatId) || [];
    list.push({ uid, item });
    mem.set(chatId, list);
  },

  // returns [{uid, url?, item?}] sorted by uid
  async refs(chatId) {
    const out = [];
    if (BLOB_TOKEN) {
      try {
        const r = await fetch(`${BLOB_API}/?prefix=${encodeURIComponent(`batch/${chatId}/`)}&limit=100`, { headers: blobHeaders() });
        if (r.ok) {
          const j = await r.json();
          for (const b of j.blobs || []) out.push({ uid: uidFromPath(b.pathname), url: b.url });
        } else console.error('blob list failed', r.status, (await r.text()).slice(0, 200));
      } catch (e) { console.error('blob list error', e); }
    }
    for (const m of mem.get(chatId) || []) out.push({ uid: m.uid, item: m.item });
    return out.sort((a, b) => a.uid - b.uid);
  },

  async load(refs) {
    return Promise.all(refs.map(async (ref) => {
      if (ref.item) return { uid: ref.uid, ...ref.item };
      const r = await fetch(ref.url);
      if (!r.ok) throw new Error('blob read failed ' + r.status);
      return { uid: ref.uid, ...(await r.json()) };
    }));
  },

  async remove(chatId, refs) {
    const urls = refs.filter((r) => r.url).map((r) => r.url);
    if (urls.length && BLOB_TOKEN) {
      try {
        await fetch(`${BLOB_API}/delete`, { method: 'POST', headers: blobHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ urls }) });
      } catch (e) { console.error('blob delete error', e); }
    }
    const taken = new Set(refs.filter((r) => r.item).map((r) => r.uid));
    if (taken.size) mem.set(chatId, (mem.get(chatId) || []).filter((m) => !taken.has(m.uid)));
  },
};

// ---------------------------------------------------------------------------
// Archive: every finished analysis is saved, one blob per analysis
//   archive/<chatId>/<ts13>-<files>-<essays>.json   (a random suffix makes the URL unguessable)
// ---------------------------------------------------------------------------
const TZ_OFFSET_MS = 5 * 3600 * 1000; // Asia/Tashkent
function fmtDate(ts) {
  const d = new Date(Number(ts) + TZ_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const archive = {
  enabled: () => !!BLOB_TOKEN,

  // payload: { report } (structured AI result) or { text } (plain text); returns the entry's ts
  async save(chatId, files, essays, payload) {
    const ts = String(Date.now()).padStart(13, '0');
    const r = await fetch(`${BLOB_API}/?pathname=${encodeURIComponent(`archive/${chatId}/${ts}-${files}-${essays}.json`)}`, {
      method: 'PUT',
      headers: blobHeaders({ 'x-content-type': 'application/json', 'x-add-random-suffix': '1' }),
      body: JSON.stringify({ ts, files, essays, ...payload }),
    });
    if (!r.ok) throw new Error('archive save failed ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return ts;
  },

  // newest first: [{ts, files, essays, url}]
  async list(chatId) {
    const r = await fetch(`${BLOB_API}/?prefix=${encodeURIComponent(`archive/${chatId}/`)}&limit=1000`, { headers: blobHeaders() });
    if (!r.ok) throw new Error('archive list failed ' + r.status);
    const j = await r.json();
    return (j.blobs || [])
      .map((b) => {
        const m = b.pathname.match(/\/(\d{13})-(\d+)-(\d+)/);
        return m ? { ts: m[1], files: Number(m[2]), essays: Number(m[3]), url: b.url } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.ts.localeCompare(a.ts));
  },

  async get(chatId, ts) {
    const e = (await this.list(chatId)).find((x) => x.ts === ts);
    if (!e) return null;
    const r = await fetch(e.url);
    if (!r.ok) return null;
    return { ...e, ...(await r.json()) };
  },

  async del(chatId, ts) {
    const e = (await this.list(chatId)).find((x) => x.ts === ts);
    if (!e) return false;
    const r = await fetch(`${BLOB_API}/delete`, { method: 'POST', headers: blobHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ urls: [e.url] }) });
    return r.ok;
  },
};

// ---------------------------------------------------------------------------
// Menu screens (inline buttons)
//   callback_data  m:<screen>  -> edit the pressed message into that screen
//                  n:<screen>  -> send that screen as a NEW message (used under analysis texts)
//                  a:<ts>      -> show an archived analysis
//                  d:<ts>      -> delete an archived analysis
// ---------------------------------------------------------------------------
const btn = (text, data) => ({ text, callback_data: data });
const HOME_ROWS = [
  [btn('\u{1F4DD} Insho yuborish', 'm:send'), btn('\u{1F464} Profil', 'm:profile')],
  [btn('\u{1F5C2} Arxiv', 'm:archive'), btn('❓ Yordam', 'm:help')],
];
const BACK_ROWS = [[btn('\u{1F3E0} Bosh menyu', 'm:home')]];

async function buildScreen(name, chatId, from) {
  if (name === 'send') {
    return {
      text:
        "\u{1F4DD} Insho yuborish\n\nInsho rasmlarini (JPG, PNG, GIF, WEBP) yoki PDF faylini shu chatga yuboring. " +
        "Bir nechta bet bo'lsa, hammasini ketma-ket yuboring - bot ularni birga o'qiydi va nechta insho ekanini o'zi aniqlaydi.\n\n" +
        "Oxirgi fayldan keyin taxminan 8 soniya kutiladi va tahlil boshlanadi. Kutmasdan boshlash uchun /tahlil deb yozing.",
      rows: BACK_ROWS,
    };
  }
  if (name === 'help') {
    return {
      text:
        "❓ Yordam\n\n" +
        "1. Insho betlarini rasm yoki PDF qilib yuboring - nechta bo'lsa ham.\n" +
        "2. Oxirgi fayldan ~8 soniya o'tgach tahlil o'zi boshlanadi, yoki /tahlil deb yozing.\n" +
        "3. Bir varaqning ikki tomoni - bitta insho. Bot fayllarni birga o'qib, insholarni o'zi ajratadi.\n" +
        "4. Aniq o'qilishi uchun rasmni \"Fayl\" (document) sifatida yuboring, yorug'da va tekis suratga oling.\n" +
        "5. Natija chiroyli PDF hisobot bo'lib keladi (tugma orqali PNG rasm ham olish mumkin). /namuna - dizayn namunasi.\n6. Har bir tahlil Arxivda saqlanadi.\n\n" +
        "Buyruqlar: /menu, /profil, /arxiv, /yordam, /tahlil, /namuna",
      rows: BACK_ROWS,
    };
  }
  if (name === 'profile') {
    const full = [from.first_name, from.last_name].filter(Boolean).join(' ') || '-';
    let stats = "Arxiv sozlanmagan.";
    if (archive.enabled()) {
      try {
        const list = await archive.list(chatId);
        const files = list.reduce((n, e) => n + e.files, 0);
        const essays = list.reduce((n, e) => n + e.essays, 0);
        stats =
          `Tahlillar: ${list.length}\nFayllar: ${files}\nInsholar: ${essays}\n` +
          `Oxirgi tahlil: ${list.length ? fmtDate(list[0].ts) : '-'}`;
      } catch (e) { console.error('profile stats error', e); stats = "Statistikani olib bo'lmadi."; }
    }
    return {
      text:
        `\u{1F464} Profil\n\nIsm: ${full}\nFoydalanuvchi: ${from.username ? '@' + from.username : '-'}\nID: ${from.id}\n\n` +
        `\u{1F4CA} Statistika (arxiv bo'yicha)\n${stats}`,
      rows: [[btn('\u{1F5C2} Arxiv', 'm:archive'), btn('\u{1F3E0} Bosh menyu', 'm:home')]],
    };
  }
  if (name === 'archive') {
    if (!archive.enabled()) return { text: '\u{1F5C2} Arxiv hozircha sozlanmagan.', rows: BACK_ROWS };
    let list = [];
    try { list = await archive.list(chatId); } catch (e) { console.error('archive list error', e); }
    if (list.length === 0) {
      return {
        text: "\u{1F5C2} Arxiv bo'sh.\n\nBirinchi inshoingizni yuboring - tahlil shu yerda saqlanadi.",
        rows: BACK_ROWS,
      };
    }
    const rows = list.slice(0, 8).map((e) => [btn(`${fmtDate(e.ts)} · ${e.files} fayl · ${e.essays || '?'} insho`, `a:${e.ts}`)]);
    rows.push([btn('\u{1F3E0} Bosh menyu', 'm:home')]);
    return {
      text: `\u{1F5C2} Arxiv - oxirgi ${Math.min(8, list.length)} ta tahlil (jami ${list.length}).\nKo'rish uchun birini tanlang:`,
      rows,
    };
  }
  // home
  return {
    text:
      `\u{1F44B} Salom, ${from.first_name || "do'st"}!\n\n` +
      "Men o'zbek tilidagi inshoingizni tahlil qilaman: xatolar, yaxshiroq so'z va iboralar, tuzilma va keyingi qadamlar.\n\n" +
      "Tugmalardan birini tanlang yoki insho rasmlarini / PDF faylini to'g'ridan-to'g'ri yuboring.",
    rows: HOME_ROWS,
  };
}

async function showScreen(name, chatId, from, editMessageId) {
  const s = await buildScreen(name, chatId, from);
  if (editMessageId) return editText(chatId, editMessageId, s.text, s.rows);
  return sendText(chatId, s.text, s.rows);
}

async function handleCallback(cb) {
  const msg = cb.message;
  const chatId = msg.chat.id;
  const data = cb.data || '';
  if (!isAllowed(cb.from)) return answerCb(cb.id, 'Kechirasiz, bu sizning akkauntingiz uchun mavjud emas.');
  const [kind, arg] = [data.slice(0, 1), data.slice(2)];

  if (kind === 'm') { await answerCb(cb.id); return showScreen(arg, chatId, cb.from, msg.message_id); }
  if (kind === 'n') { await answerCb(cb.id); return showScreen(arg, chatId, cb.from); }

  // a: open an archived analysis (PDF) / g: the same as a PNG picture
  if (kind === 'a' || kind === 'g') {
    await answerCb(cb.id, kind === 'g' ? 'Rasm tayyorlanmoqda...' : 'Hisobot tayyorlanmoqda...');
    const entry = archive.enabled() ? await archive.get(chatId, arg) : null;
    if (!entry) return sendText(chatId, 'Bu tahlil topilmadi (o\'chirilgan bo\'lishi mumkin).', [[btn('\u{1F5C2} Arxiv', 'n:archive')]]);
    if (!entry.report) {
      // old entries were stored as plain text
      const head = `\u{1F5C2} Tahlil - ${fmtDate(entry.ts)} (${entry.files} fayl)\n\n`;
      return sendLong(chatId, head + (entry.text || ''), afterRows(entry.ts));
    }
    const ctx = reportCtx(cb.from, entry.ts);
    try {
      if (kind === 'g') {
        const png = await renderPng(entry.report, ctx);
        return sendFile(chatId, png, pdfName(entry.ts, 'png'), 'image/png', '\u{1F5BC} Insho tahlili (rasm)', afterRows(entry.ts));
      }
      const pdf = await renderPdf(entry.report, ctx);
      return sendFile(chatId, pdf, pdfName(entry.ts), 'application/pdf', report.caption(entry.report), afterRows(entry.ts));
    } catch (e) {
      console.error('render error:', e);
      await sendText(chatId, "Faylni tayyorlab bo'lmadi, matn ko'rinishida yuboraman.\n\nTafsilot: " + safeError(e));
      return sendLong(chatId, report.toPlainText(entry.report), afterRows(entry.ts));
    }
  }

  if (kind === 'd') {
    const ok = archive.enabled() ? await archive.del(chatId, arg) : false;
    await answerCb(cb.id, ok ? "\u{1F5D1} O'chirildi" : 'Topilmadi');
    return showScreen('archive', chatId, cb.from);
  }
  return answerCb(cb.id);
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------
const S = { type: 'STRING' };
const N = { type: 'NUMBER' };
const obj = (properties) => ({ type: 'OBJECT', properties });
const list = (items) => ({ type: 'ARRAY', items });
const REPORT_SCHEMA = obj({
  files_total: { type: 'INTEGER' },
  overview_note: S,
  essays: list(obj({
    files: S, title: S, topic_summary: S, level: S, score: N, score_reason: S,
    rubric: obj({ grammar: N, vocabulary: N, structure: N, content: N }),
    strengths: list(obj({ point: S, quote: S })),
    mistakes: list(obj({ original: S, corrected: S, reason: S })),
    vocabulary: list(obj({ weak: S, better: S, example: S })),
    linking_phrases: list(S),
    structure: obj({ intro: S, body: S, conclusion: S, notes: S }),
    next_steps: list(S),
    improved_version: obj({ about: S, text: S }),
  })),
});

// The AI should return JSON; be tolerant about code fences or text around it.
function parseReport(text) {
  const t = String(text || '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const data = JSON.parse(t.slice(a, b + 1));
    return data && Array.isArray(data.essays) ? data : null;
  } catch (e) { return null; }
}

// Google's free tier has small daily / per-minute quotas. When one model is out of quota we try the next
// model of the chain (every model has its own quota) and remember for a while which ones are exhausted.
const GEMINI_CHAIN = [...new Set([
  GEMINI_MODEL,
  ...(process.env.GEMINI_FALLBACK_MODELS || 'gemini-flash-lite-latest,gemini-2.5-flash,gemini-2.5-flash-lite').split(',').map((x) => x.trim()),
].filter(Boolean))];
const modelBusyUntil = new Map(); // model -> timestamp until which it is known to be unusable

class QuotaError extends Error {
  constructor(message, retrySec) { super(message); this.quota = true; this.retrySec = retrySec; }
}

function retryDelaySec(json) {
  try {
    for (const d of (json && json.error && json.error.details) || []) {
      if (d.retryDelay) return Math.ceil(parseFloat(d.retryDelay));
    }
    const m = JSON.stringify(json).match(/retry in ([\d.]+)s/i);
    if (m) return Math.ceil(Number(m[1]));
  } catch (e) { /* ignore */ }
  return null;
}

async function askGemini(files, userText) {
  const parts = [];
  files.forEach((f, i) => {
    parts.push({ text: `Fayl ${i + 1} / File ${i + 1} (${f.kind === 'pdf' ? 'PDF' : 'rasm/image'}):` });
    parts.push({ inlineData: { mimeType: f.mime, data: f.base64 } });
  });
  parts.push({ text: userText });
  const body = (generationConfig) => JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts }],
    generationConfig,
  });

  const call = async (model, generationConfig) => {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: body(generationConfig),
      signal: AbortSignal.timeout(150000),
    });
    return { r, json: await r.json().catch(() => ({})) };
  };

  // Low "thinking" = faster answers; JSON mode + schema = the answer always fits the report template.
  // If a model rejects one of the settings, retry with fewer settings (a 400 does not use up quota).
  const tryModel = async (model) => {
    const base = { maxOutputTokens: 8192 };
    const withJson = { ...base, responseMimeType: 'application/json', responseSchema: REPORT_SCHEMA };
    let res = await call(model, { ...withJson, thinkingConfig: { thinkingLevel: 'low' } });
    if (res.r.status === 400) res = await call(model, withJson);
    if (res.r.status === 400) res = await call(model, base);
    return res;
  };

  const now = Date.now();
  let chain = GEMINI_CHAIN.filter((m) => (modelBusyUntil.get(m) || 0) <= now);
  if (chain.length === 0) chain = GEMINI_CHAIN; // everything looked exhausted: try again anyway
  let quotaRetry = null;
  let lastErr = null;

  for (const model of chain) {
    const { r, json } = await tryModel(model);
    if (r.ok) {
      const out = (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) || [];
      if (model !== GEMINI_CHAIN[0]) console.log('answered by fallback model', model);
      return out.map((p) => (p.thought ? '' : p.text || '')).join('').trim();
    }
    const detail = `Gemini ${r.status} (${model}): ${JSON.stringify(json).slice(0, 400)}`;
    if (r.status === 429) {
      const daily = /PerDay|per day/i.test(JSON.stringify(json));
      const wait = daily ? 3600 : retryDelaySec(json) || 60;
      modelBusyUntil.set(model, Date.now() + wait * 1000);
      quotaRetry = quotaRetry === null ? wait : Math.min(quotaRetry, wait);
      lastErr = detail;
      continue;
    }
    if (r.status === 404) { modelBusyUntil.set(model, Date.now() + 6 * 3600 * 1000); lastErr = detail; continue; }
    if (r.status >= 500) { modelBusyUntil.set(model, Date.now() + 30 * 1000); lastErr = detail; continue; }
    throw new Error(detail);
  }
  if (quotaRetry !== null) throw new QuotaError(lastErr, quotaRetry);
  throw new Error(lastErr || 'Gemini: no model answered');
}

async function askClaude(files, userText) {
  const content = [];
  files.forEach((f, i) => {
    content.push({ type: 'text', text: `File ${i + 1}:` });
    content.push(f.kind === 'pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.base64 } }
      : { type: 'image', source: { type: 'base64', media_type: f.mime, data: f.base64 } });
  });
  content.push({ type: 'text', text: userText });

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 12000, system: SYSTEM_PROMPT, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(170000),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${JSON.stringify(json)}`);
  return (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// ---------------------------------------------------------------------------
// Progress bar (one message that is edited every few seconds)
// ---------------------------------------------------------------------------
function bar(pct) {
  const total = 10;
  const filled = Math.max(0, Math.min(total, Math.round((pct / 100) * total)));
  return '▰'.repeat(filled) + '▱'.repeat(total - filled);
}

async function startProgress(chatId, count) {
  const t0 = Date.now();
  let stage = 'Fayllar yuklab olinmoqda';
  let forced = null; // set by progress.stage() for the final steps
  const title = count > 1 ? `${count} ta fayl o'qilmoqda...` : "Insho o'qilmoqda...";
  const render = (pct, secs) => `⏳ ${title}\n${bar(pct)} ${pct}%\n${stage} (${secs}s)`;
  const sent = await sendText(chatId, render(2, 0));
  const messageId = sent && sent.result && sent.result.message_id;
  const edit = (text) => (messageId ? tg('editMessageText', form({ chat_id: chatId, message_id: messageId, text })) : null);

  const stages = [
    [0, 'Fayllar yuklab olinmoqda'],
    [3, "Matn o'qilmoqda va betlar tartiblanmoqda"],
    [12, 'Insholar aniqlanmoqda'],
    [22, 'Grammatika va imlo tekshirilmoqda'],
    [34, "Yaxshiroq so'z va iboralar qidirilmoqda"],
    [48, 'Tahlil yozilmoqda'],
    [75, 'Javob tayyorlanmoqda'],
  ];
  const timer = setInterval(() => {
    const secs = Math.round((Date.now() - t0) / 1000);
    stage = forced || stages.filter(([t]) => secs >= t).pop()[1];
    const pct = Math.min(97, Math.max(forced ? 92 : 0, Math.round(100 * (1 - Math.exp(-secs / 35))) + 2));
    Promise.resolve(edit(render(pct, secs))).catch(() => {});
    typing(chatId).catch(() => {});
  }, 3000);

  return {
    stage(text) { forced = text; },
    async done(ok) {
      clearInterval(timer);
      const secs = Math.round((Date.now() - t0) / 1000);
      await edit(ok ? `✅ Tahlil tayyor!\n${bar(100)} 100% (${secs}s)` : `⚠️ Tugallab bo'lmadi.\n${bar(0)}`);
    },
  };
}

// Buttons under a finished report: ts is the archive entry id (null when nothing was saved)
function afterRows(ts) {
  const rows = [];
  if (ts) rows.push([btn('\u{1F5BC} PNG rasm', `g:${ts}`), btn("\u{1F5D1} O'chirish", `d:${ts}`)]);
  rows.push([btn('\u{1F3E0} Bosh menyu', 'n:home'), btn('\u{1F5C2} Arxiv', 'n:archive')]);
  return rows;
}

const pdfName = (ts, ext = 'pdf') => {
  const d = new Date((ts ? Number(ts) : Date.now()) + TZ_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `Insho_tahlili_${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}_${p(d.getUTCHours())}-${p(d.getUTCMinutes())}.${ext}`;
};

function reportCtx(from, ts) {
  return { date: fmtDate(ts || Date.now()).slice(0, 10), user: from ? [from.first_name, from.last_name].filter(Boolean).join(' ') : '' };
}

// Only ONE invocation may analyse a given batch (Telegram can deliver an update twice, and the webhook can
// run on several instances at once). The first one creates a marker blob; the others find it and stop.
async function claimBatch(chatId, key) {
  if (!BLOB_TOKEN) return { ok: true, url: null };
  try {
    const r = await fetch(`${BLOB_API}/?pathname=${encodeURIComponent(`claim/${chatId}/${String(key).padStart(12, '0')}.json`)}`, {
      method: 'PUT',
      headers: blobHeaders({ 'x-content-type': 'application/json', 'x-add-random-suffix': '0' }),
      body: '1',
    });
    if (r.ok) { const j = await r.json().catch(() => ({})); return { ok: true, url: j.url || null }; }
    const t = await r.text().catch(() => '');
    if (r.status === 409 || /exist/i.test(t)) return { ok: false, url: null };
    console.error('claim failed (continuing):', r.status, t.slice(0, 200));
  } catch (e) { console.error('claim error (continuing):', e); }
  return { ok: true, url: null };
}

async function releaseClaim(claim) {
  if (!claim || !claim.url || !BLOB_TOKEN) return;
  try {
    await fetch(`${BLOB_API}/delete`, { method: 'POST', headers: blobHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ urls: [claim.url] }) });
  } catch (e) { console.error('release error', e); }
}

// Put the files back into the waiting list so the student can retry with /tahlil without re-sending them
async function restoreFiles(chatId, items) {
  await Promise.all(items.map((it) =>
    state.add(chatId, it.uid, { fileId: it.fileId, kind: it.kind, mime: it.mime, name: it.name || '', caption: it.caption || '' }).catch(() => {})));
}

function waitText(sec) {
  if (sec == null) return 'birozdan keyin';
  if (sec >= 3000) return 'bir necha soatdan keyin (kunlik limit)';
  if (sec >= 90) return `taxminan ${Math.ceil(sec / 60)} daqiqadan keyin`;
  return `taxminan ${Math.max(10, sec)} soniyadan keyin`;
}

// ---------------------------------------------------------------------------
// Analysis of one collected batch
// ---------------------------------------------------------------------------
async function analyseBatch(chatId, refs, from) {
  const hasKey = PROVIDER === 'gemini' ? GEMINI_KEY : ANTHROPIC_KEY;
  if (!hasKey) return sendText(chatId, "Insho tahlili hali sozlanmagan (API kalit yo'q).");

  // claim the batch first so nobody analyses it twice
  const claim = await claimBatch(chatId, refs.length ? refs[refs.length - 1].uid : 0);
  if (!claim.ok) return;
  const loaded = await state.load(refs);
  await state.remove(chatId, refs);
  const items = loaded.slice(0, MAX_FILES);
  if (loaded.length > MAX_FILES) {
    await sendText(chatId, `Juda ko'p fayl: faqat birinchi ${MAX_FILES} tasi tahlil qilinadi.`);
  }

  const progress = await startProgress(chatId, items.length);
  let ok = false;
  try {
    const buffers = await Promise.all(items.map((it) => downloadTelegramFile(it.fileId)));
    const total = buffers.reduce((n, b) => n + b.length, 0);
    if (total > MAX_TOTAL_BYTES) {
      await progress.done(false);
      return sendText(chatId, "Fayllar hajmi juda katta (jami 14 MB dan oshmasin). Iltimos, kamroq fayl yoki siqilgan rasm yuboring.");
    }
    if (PROVIDER !== 'gemini' && items.some((it, i) => it.kind === 'image' && buffers[i].length > MAX_CLAUDE_IMAGE_BYTES)) {
      await progress.done(false);
      return sendText(chatId, "Rasm 5 MB dan katta. Iltimos, uni siqilgan rasm yoki PDF ko'rinishida yuboring.");
    }

    const files = items.map((it, i) => ({ kind: it.kind, mime: it.mime, base64: buffers[i].toString('base64') }));
    const notes = items.map((it, i) => (it.caption ? `- Fayl ${i + 1}: ${it.caption}` : '')).filter(Boolean);
    const userText =
      `Quyidagi ${files.length} ta fayl bitta yuborilishda keldi (yuborilgan tartibda). ` +
      "Avval ularning nechta insho ekanini aniqlang, so'ng har bir inshoni alohida tahlil qiling.\n" +
      'These ' + files.length + ' files were sent together, in the order received. First decide how many essays they contain, then analyse each essay separately.' +
      (notes.length ? `\n\nStudent notes:\n${notes.join('\n')}` : '');

    const answer = PROVIDER === 'gemini' ? await askGemini(files, userText) : await askClaude(files, userText);
    ok = true;
    const data = parseReport(answer);

    // The answer was cut off in the middle of the JSON: keep the files so the student can retry.
    if (!data && /^\s*[{[]/.test(answer || '')) {
      await progress.done(false);
      await restoreFiles(chatId, items);
      await releaseClaim(claim);
      return sendText(chatId, "AI javobi to'liq kelmadi. Fayllaringiz saqlandi - /tahlil deb qayta urinib ko'ring.");
    }

    // The model did not return the expected JSON: show its text as before.
    if (!data) {
      await progress.done(true);
      if (answer && archive.enabled()) {
        try { await archive.save(chatId, items.length, 0, { text: answer }); } catch (e) { console.error('archive save error', e); }
      }
      return sendLong(chatId, answer || "Fayllardan hech narsa o'qiy olmadim. Aniqroq rasm yuboring.", afterRows(null));
    }

    // Save to the archive first (the stored JSON can be turned into PDF / PNG again at any time) ...
    let ts = null;
    if (archive.enabled()) {
      try { ts = await archive.save(chatId, items.length, data.essays.length, { report: data }); } catch (e) { console.error('archive save error', e); }
    }
    // ... then design the report and send it.
    progress.stage('Hisobot dizayni tayyorlanmoqda');
    try {
      const pdf = await renderPdf(data, reportCtx(from, ts));
      await progress.done(true);
      await sendFile(chatId, pdf, pdfName(ts), 'application/pdf', report.caption(data), afterRows(ts));
    } catch (e) {
      console.error('pdf error:', e);
      await progress.done(true);
      await sendText(chatId, "Hisobot faylini tayyorlab bo'lmadi, natijani matn ko'rinishida yuboraman.\n\nTafsilot: " + safeError(e));
      await sendLong(chatId, report.toPlainText(data), afterRows(ts));
    }
  } catch (err) {
    console.error('essay error:', err);
    if (!ok) await progress.done(false);
    if (err && err.quota) {
      await restoreFiles(chatId, items);
      await releaseClaim(claim);
      return sendText(chatId,
        "\u23F3 Google AI limiti hozircha tugadi (bepul tarif cheklovi).\n\n" +
        `Fayllaringiz saqlandi - ${waitText(err.retrySec)} /tahlil deb yozing, qayta yuborish shart emas.\n\n` +
        "Doimiy yechim: Google AI Studio'da to'lov rejasini yoqish yoki boshqa API kalit qo'yish.");
    }
    await sendText(chatId, "Kechirasiz, inshoni tahlil qilishda xatolik yuz berdi. Qaytadan urinib ko'ring.\n\nTafsilot: " + safeError(err));
  }
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------
function isAllowed(from) {
  if (ALLOWED.length === 0) return true;
  const username = (from.username || '').toLowerCase();
  return ALLOWED.includes(username) || ALLOWED.includes(String(from.id));
}

// Returns { fileId, kind: 'image'|'pdf', mime, name } | { unsupported: true } | null
function detectMedia(msg) {
  if (msg.photo && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1];
    return { fileId: largest.file_id, kind: 'image', mime: 'image/jpeg', name: 'photo.jpg' };
  }
  const d = msg.document;
  if (!d) return null;
  const name = d.file_name || '';
  const ext = name.split('.').pop().toLowerCase();
  const mime = (d.mime_type || '').toLowerCase();
  if (mime === 'application/pdf' || ext === 'pdf') return { fileId: d.file_id, kind: 'pdf', mime: 'application/pdf', name };
  if (IMAGE_TYPES[mime.replace('image/', '')] === mime) return { fileId: d.file_id, kind: 'image', mime, name };
  if (IMAGE_TYPES[ext]) return { fileId: d.file_id, kind: 'image', mime: IMAGE_TYPES[ext], name };
  return { unsupported: true };
}

// A file arrived: store it, wait for more, and let the LAST arrival run the analysis.
async function handleMedia(update, msg, media) {
  const chatId = msg.chat.id;
  const uid = update.update_id;

  await react(chatId, msg.message_id).catch(() => {});
  await state.add(chatId, uid, {
    fileId: media.fileId, kind: media.kind, mime: media.mime, name: media.name || '', caption: msg.caption || '',
  });

  await sleep(WAIT_MS);

  const refs = await state.refs(chatId);
  if (refs.length === 0) return; // already analysed (e.g. by /tahlil)
  if (refs[refs.length - 1].uid !== uid) return; // a later file will start the analysis
  return analyseBatch(chatId, refs, msg.from);
}

async function handleMessage(update, msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim().toLowerCase();

  // Helper: send a document with caption /fileid to get its Telegram file_id.
  if (msg.document && (msg.caption || '').trim() === '/fileid') {
    return sendText(chatId, `file_id:\n${msg.document.file_id}`);
  }

  // Start the analysis immediately
  if (/^\/(tahlil|tayyor|analyze)(@\w+)?$/.test(text)) {
    if (!isAllowed(msg.from)) return sendText(chatId, 'Kechirasiz, insho tahlili sizning akkauntingiz uchun mavjud emas.');
    const refs = await state.refs(chatId);
    if (refs.length === 0) return sendText(chatId, "Hozircha fayl yo'q. Avval insho rasmlarini yoki PDF faylini yuboring.");
    return analyseBatch(chatId, refs, msg.from);
  }

  // Demo of the report design with made-up data
  if (/^\/(namuna|demo)(@\w+)?$/.test(text)) {
    if (!isAllowed(msg.from)) return sendText(chatId, 'Kechirasiz, bu bot sizning akkauntingiz uchun mavjud emas.');
    await sendText(chatId, '⏳ Namuna hisobot tayyorlanmoqda...');
    try {
      const pdf = await renderPdf(SAMPLE, reportCtx(msg.from, null));
      return sendFile(chatId, pdf, 'Namuna_hisobot.pdf', 'application/pdf',
        "\u{1F4C4} Namuna hisobot (ma'lumotlar o'ylab topilgan). Haqiqiy inshoingizni yuboring - xuddi shunday dizaynda tayyorlayman.",
        [[btn('\u{1F3E0} Bosh menyu', 'n:home')]]);
    } catch (e) {
      console.error('sample error:', e);
      return sendText(chatId, "Namuna hisobotni tayyorlab bo'lmadi.\n\nTafsilot: " + safeError(e));
    }
  }

  const media = detectMedia(msg);
  if (media && media.unsupported) {
    return sendText(chatId, "Iltimos, inshoni rasm (JPG, PNG, GIF, WEBP) yoki PDF ko'rinishida yuboring.");
  }
  if (media) {
    if (!isAllowed(msg.from)) return sendText(chatId, 'Kechirasiz, insho tahlili sizning akkauntingiz uchun mavjud emas.');
    return handleMedia(update, msg, media);
  }

  // Plain text / commands -> menu screens
  if (!isAllowed(msg.from)) return sendText(chatId, 'Kechirasiz, bu bot sizning akkauntingiz uchun mavjud emas.');
  const cmd = (text.match(/^\/(\w+)/) || [])[1];
  const screens = { profil: 'profile', profile: 'profile', arxiv: 'archive', archive: 'archive', yordam: 'help', help: 'help' };
  return showScreen(screens[cmd] || 'home', chatId, msg.from);
}

// Insurance: ask the platform to keep the function alive until the work is finished.
function keepAlive(promise) {
  try {
    const ctx = globalThis[Symbol.for('@vercel/request-context')];
    const waitUntil = ctx && typeof ctx.get === 'function' && ctx.get() && ctx.get().waitUntil;
    if (typeof waitUntil === 'function') waitUntil(promise);
  } catch (e) { /* ignore */ }
}

const seen = new Set(); // best-effort protection against Telegram re-delivering the same update

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('Bot is running.');
  if (!TOKEN) return res.status(500).send('BOT_TOKEN is not set');
  if (SECRET && req.headers['x-telegram-bot-api-secret-token'] !== SECRET) {
    return res.status(401).send('Unauthorized');
  }

  const update = req.body || {};
  const cb = update.callback_query;
  const msg = update.message || update.edited_message;
  const valid = cb ? !!(cb.message && cb.message.chat && cb.from) : !!(msg && msg.chat && msg.from && !msg.from.is_bot);
  if (valid) {
    const chatId = cb ? cb.message.chat.id : msg.chat.id;
    if (update.update_id !== undefined) {
      if (seen.has(update.update_id)) return res.status(200).json({ ok: true, duplicate: true });
      seen.add(update.update_id);
      if (seen.size > 200) seen.delete(seen.values().next().value);
    }
    const work = (cb ? handleCallback(cb) : handleMessage(update, msg)).catch(async (err) => {
      console.error('handler error:', err);
      await sendText(chatId, 'Kechirasiz, xatolik yuz berdi.\n\nTafsilot: ' + safeError(err)).catch(() => {});
    });
    keepAlive(work);
    await work; // answer Telegram only after we are done
  }
  return res.status(200).json({ ok: true });
};
