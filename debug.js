// Diagnostics: https://<your-domain>/api/debug?key=<WEBHOOK_SECRET>
// Shows Telegram webhook status and does a tiny live test of the AI key.
module.exports = async (req, res) => {
  const TOKEN = process.env.BOT_TOKEN;
  const SECRET = process.env.WEBHOOK_SECRET;
  if (!SECRET || req.query.key !== SECRET) return res.status(401).send('Wrong key.');

  const out = {
    env: {
      BOT_TOKEN: !!TOKEN,
      FILE_ID: !!process.env.FILE_ID,
      GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
      ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
      PROVIDER: process.env.PROVIDER || '(auto)',
      GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-flash-latest',
      GEMINI_FALLBACK_MODELS: process.env.GEMINI_FALLBACK_MODELS || '(default chain)',
    },
  };

  try {
    const w = await fetch(`https://api.telegram.org/bot${TOKEN}/getWebhookInfo`).then((r) => r.json());
    const i = w.result || {};
    out.telegram = {
      url: i.url,
      pending_update_count: i.pending_update_count,
      last_error_date: i.last_error_date ? new Date(i.last_error_date * 1000).toISOString() : null,
      last_error_message: i.last_error_message || null,
    };
  } catch (e) {
    out.telegram = { error: String(e).slice(0, 300) };
  }

  // Round-trip test of the shared storage: ?blob=1
  if (req.query.blob === '1') {
    const BT = process.env.BLOB_READ_WRITE_TOKEN;
    const ver = process.env.BLOB_API_VERSION || '11';
    const H = (extra = {}) => ({ authorization: `Bearer ${BT}`, 'x-api-version': ver, ...extra });
    const steps = {};
    try {
      const put = await fetch('https://blob.vercel-storage.com/?pathname=' + encodeURIComponent('debug/test/000000000001.json'), {
        method: 'PUT',
        headers: H({ 'x-content-type': 'application/json', 'x-add-random-suffix': '0', 'x-allow-overwrite': '1', 'x-cache-control-max-age': '60' }),
        body: JSON.stringify({ hello: 'world' }),
      });
      const putText = await put.text();
      steps.put = { status: put.status, body: putText.slice(0, 200) };
      const list = await fetch('https://blob.vercel-storage.com/?prefix=debug%2Ftest%2F&limit=10', { headers: H() });
      const listJson = await list.json().catch(() => ({}));
      steps.list = { status: list.status, count: (listJson.blobs || []).length, first: listJson.blobs && listJson.blobs[0] && listJson.blobs[0].pathname };
      const url = listJson.blobs && listJson.blobs[0] && listJson.blobs[0].url;
      if (url) {
        const got = await fetch(url);
        steps.read = { status: got.status, body: (await got.text()).slice(0, 100) };
        const del = await fetch('https://blob.vercel-storage.com/delete', { method: 'POST', headers: H({ 'content-type': 'application/json' }), body: JSON.stringify({ urls: [url] }) });
        steps.delete = { status: del.status };
        const list2 = await fetch('https://blob.vercel-storage.com/?prefix=debug%2Ftest%2F&limit=10', { headers: H() });
        const l2 = await list2.json().catch(() => ({}));
        steps.list_after_delete = { count: (l2.blobs || []).length };
      }
    } catch (e) {
      steps.error = String(e).slice(0, 300);
    }
    out.blob = { token_set: !!BT, api_version: ver, steps };
  }

  // Test of the PDF engine: ?render=1
  if (req.query.render === '1') {
    const t0 = Date.now();
    const r = {};
    try {
      const fonts = require('../lib/fonts');
      fonts.fontCss();
      r.fonts = { dir: fonts.fontCss.dir, files_loaded: fonts.fontCss.found };
      const fs = require('fs');
      const path = require('path');
      const chromiumDir = [path.join(process.cwd(), 'node_modules', '@sparticuz', 'chromium'), path.join(__dirname, '..', 'node_modules', '@sparticuz', 'chromium')].find((x) => fs.existsSync(x));
      r.chromium_pkg = chromiumDir ? { dir: chromiumDir, entries: fs.readdirSync(chromiumDir).slice(0, 12), bin: fs.existsSync(path.join(chromiumDir, 'bin')) ? fs.readdirSync(path.join(chromiumDir, 'bin')) : null } : null;
      const { renderPdf } = require('../lib/render');
      const pdf = await renderPdf(require('../lib/sample.json'), { date: 'test', user: 'Test' });
      r.pdf_bytes = pdf.length;
      r.pdf_head = pdf.slice(0, 8).toString('latin1');
      r.pdf_pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    } catch (e) {
      r.error = String((e && e.stack) || e).slice(0, 1800);
    }
    r.ms = Date.now() - t0;
    out.render = r;
  }

  const KEY = process.env.GEMINI_API_KEY;

  // List of models this key can use: ?models=1   (does not use quota)
  if (KEY && req.query.models === '1') {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': KEY } });
      const j = await r.json().catch(() => ({}));
      out.models = {
        http_status: r.status,
        names: (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace('models/', '')),
        error: j.error ? String(j.error.message || '').slice(0, 300) : null,
      };
    } catch (e) { out.models = { error: String(e).slice(0, 300) }; }
  }

  // Tiny AI ping (uses a little quota): default model, or ?model=name,name2 ; skip with ?ai=0
  if (KEY && req.query.ai !== '0') {
    const list = req.query.model
      ? String(req.query.model).split(',').map((x) => x.trim()).filter(Boolean)
      : [process.env.GEMINI_MODEL || 'gemini-flash-latest'];
    out.gemini = [];
    for (const model of list.slice(0, 6)) {
      const t0 = Date.now();
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: OK' }] }],
            generationConfig: { maxOutputTokens: 200 },
          }),
        });
        const j = await r.json().catch(() => ({}));
        const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
        out.gemini.push({
          model,
          http_status: r.status,
          ms: Date.now() - t0,
          reply: parts.map((q) => q.text || '').join('').slice(0, 100),
          error: j.error ? String(j.error.message || '').slice(0, 400) : null,
          quota_scope: j.error && /PerDay/i.test(JSON.stringify(j.error)) ? 'DAILY' : j.error && /PerMinute/i.test(JSON.stringify(j.error)) ? 'PER-MINUTE' : null,
        });
      } catch (e) {
        out.gemini.push({ model, error: String(e).slice(0, 300), ms: Date.now() - t0 });
      }
    }
  }

  return res.status(200).json(out);
};
