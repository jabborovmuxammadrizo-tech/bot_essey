// The report template. Pure functions: data (JSON from the AI) + brand + context -> HTML string.
// Change the look here once, every future report uses it.
//
// Expected data shape (all fields optional, missing ones are skipped):
// {
//   files_total: 2, overview_note: "...",
//   essays: [{
//     files: "1-2", title: "...", topic_summary: "...", level: "O'rta", score: 7.5, score_reason: "...",
//     rubric: { grammar: 7, vocabulary: 6, structure: 8, content: 7 },
//     strengths: [{ point, quote }],
//     mistakes: [{ original, corrected, reason }],
//     vocabulary: [{ weak, better, example }],
//     linking_phrases: ["masalan", ...],
//     structure: { intro, body, conclusion, notes },
//     next_steps: ["..."],
//     improved_version: { about, text }
//   }]
// }
const { fontCss } = require('./fonts');

const esc = (s) =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nl = (s) => esc(s).replace(/\n/g, '<br>');
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp10 = (v) => Math.max(0, Math.min(10, num(v)));
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v == null ? '' : String(v).trim());

function normalize(data) {
  const d = data && typeof data === 'object' ? data : {};
  const essays = arr(d.essays).map((e, i) => {
    e = e || {};
    const r = e.rubric || {};
    return {
      n: i + 1,
      files: str(e.files),
      title: str(e.title) || `${i + 1}-insho`,
      topic_summary: str(e.topic_summary),
      level: str(e.level),
      score: Math.round(clamp10(e.score) * 10) / 10,
      score_reason: str(e.score_reason),
      rubric: [
        ['Grammatika va imlo', clamp10(r.grammar)],
        ["Lug'at boyligi", clamp10(r.vocabulary)],
        ['Tuzilma', clamp10(r.structure)],
        ['Mazmun va fikr', clamp10(r.content)],
      ],
      hasRubric: ['grammar', 'vocabulary', 'structure', 'content'].some((k) => r[k] != null),
      strengths: arr(e.strengths).slice(0, 5).map((s) => ({ point: str(s && s.point) || str(s), quote: str(s && s.quote) })),
      mistakes: arr(e.mistakes).slice(0, 12).map((m) => ({ original: str(m && m.original), corrected: str(m && m.corrected), reason: str(m && m.reason) })),
      vocabulary: arr(e.vocabulary).slice(0, 12).map((v) => ({ weak: str(v && v.weak), better: str(v && v.better), example: str(v && v.example) })),
      linking: arr(e.linking_phrases).slice(0, 8).map(str).filter(Boolean),
      structure: {
        intro: str(e.structure && e.structure.intro),
        body: str(e.structure && e.structure.body),
        conclusion: str(e.structure && e.structure.conclusion),
        notes: str(e.structure && e.structure.notes),
      },
      steps: arr(e.next_steps).slice(0, 6).map(str).filter(Boolean),
      improved: { about: str(e.improved_version && e.improved_version.about), text: str(e.improved_version && e.improved_version.text) },
    };
  });
  return {
    files_total: num(d.files_total, 0),
    note: str(d.overview_note),
    essays,
  };
}

const scoreColor = (s) => (s >= 8 ? '#16A34A' : s >= 6.5 ? '#0D9488' : s >= 5 ? '#D97706' : '#DC2626');

// --- the HTML template (templates/report.html) --------------------------------------------------
const fs = require('fs');
const path = require('path');
const { compile } = require('./tpl');

let compiled = null;
function template() {
  if (!compiled || process.env.TEMPLATE_RELOAD === '1') {
    const file = path.join(__dirname, '..', 'templates', 'report.html');
    compiled = compile(fs.readFileSync(file, 'utf8'));
  }
  return compiled;
}

const RING_C = 2 * Math.PI * 44;
const comma = (n) => String(n).replace('.', ',');

// Turns the normalised data into exactly the fields the template uses
function viewModel(d, multi) {
  return d.essays.map((e, i) => ({
    ...e,
    page_break: i > 0,
    chip_label: multi ? `${e.n}-INSHO` : 'INSHO',
    short_title: e.title.length > 46 ? e.title.slice(0, 44) + '…' : e.title,
    score_text: comma(e.score),
    score_color: scoreColor(e.score),
    ring_c: RING_C.toFixed(2),
    ring_off: (RING_C * (1 - e.score / 10)).toFixed(2),
    has_rubric: e.hasRubric,
    rubric: e.rubric.map(([label, v]) => ({ label, value_text: comma(v), pct: v * 10, color: scoreColor(v) })),
    has_vocab: e.vocabulary.length > 0 || e.linking.length > 0,
    has_structure: !!(e.structure.intro || e.structure.body || e.structure.conclusion || e.structure.notes),
  }));
}

// data (AI result) + brand + { date, user }  ->  complete HTML page
function build(data, brand, ctx = {}) {
  const d = normalize(data);
  const multi = d.essays.length > 1;
  return template()({
    brand,
    date: ctx.date || '',
    user: ctx.user || '',
    fonts: fontCss(),
    has_essays: d.essays.length > 0,
    essay_count: d.essays.length,
    files_total: d.files_total,
    note: d.note,
    essays: viewModel(d, multi),
  });
}

function footerTemplate(brand) {
  return `<div style="width:100%;font-family:Arial,Helvetica,sans-serif;font-size:7.5px;color:#94A3B8;padding:0 14mm;display:flex;justify-content:space-between;align-items:center;-webkit-print-color-adjust:exact;">
    <span>${esc(brand.name)} · ${esc(brand.handle)}</span>
    <span>Sahifa <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
}

// Plain-text version (used as a fallback if the PDF cannot be produced, and for short captions)
function toPlainText(data) {
  const d = normalize(data);
  const out = [];
  out.push(`FAYLLAR TUZILISHI\n${d.files_total ? d.files_total + ' ta fayl -> ' : ''}${d.essays.length} ta insho`);
  if (d.note) out.push(d.note);
  for (const e of d.essays) {
    const L = [];
    L.push(`=== ${e.n}-INSHO: ${e.title} ===`);
    L.push(`Daraja: ${e.level || '-'} | Ball (taxminiy): ${e.score}/10${e.score_reason ? ' - ' + e.score_reason : ''}`);
    if (e.topic_summary) L.push(e.topic_summary);
    if (e.strengths.length) L.push('KUCHLI TOMONLARI\n' + e.strengths.map((s) => `- ${s.point}${s.quote ? ` ("${s.quote}")` : ''}`).join('\n'));
    if (e.mistakes.length) L.push('XATOLAR VA TUZATISHLAR\n' + e.mistakes.map((m, i) => `${i + 1}. ${m.original} -> ${m.corrected}${m.reason ? ' (' + m.reason + ')' : ''}`).join('\n'));
    if (e.vocabulary.length) L.push("SO'Z VA IBORALAR\n" + e.vocabulary.map((v) => `- ${v.weak} -> ${v.better}${v.example ? ' | ' + v.example : ''}`).join('\n') + (e.linking.length ? `\nBog'lovchi iboralar: ${e.linking.join(', ')}` : ''));
    const s = e.structure;
    if (s.intro || s.body || s.conclusion || s.notes) L.push('TUZILMA VA MAZMUN\n' + [s.intro && `Kirish: ${s.intro}`, s.body && `Asosiy qism: ${s.body}`, s.conclusion && `Xulosa: ${s.conclusion}`, s.notes].filter(Boolean).join('\n'));
    if (e.steps.length) L.push('KEYINGI QADAMLAR\n' + e.steps.map((x, i) => `${i + 1}. ${x}`).join('\n'));
    if (e.improved.text) L.push(`YAXSHILANGAN VARIANT${e.improved.about ? ' (' + e.improved.about + ')' : ''}\n${e.improved.text}`);
    out.push(L.join('\n\n'));
  }
  return out.join('\n\n');
}

// Short summary for the Telegram caption
function caption(data) {
  const d = normalize(data);
  if (!d.essays.length) return '📄 Insho tahlili hisoboti';
  const lines = d.essays.map((e) => `${d.essays.length > 1 ? e.n + '-insho: ' : ''}${e.score}/10${e.level ? ' (' + e.level + ')' : ''} — ${e.title.length > 60 ? e.title.slice(0, 58) + '…' : e.title}`);
  return `📄 Insho tahlili tayyor!\n${lines.join('\n')}`.slice(0, 1000);
}

module.exports = { build, footerTemplate, toPlainText, caption, normalize };
