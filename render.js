// HTML -> PDF / PNG with headless Chromium (works on Vercel through @sparticuz/chromium).
const { build, footerTemplate } = require('./report');
const getBrand = require('./brand');

async function launch() {
  const chromiumMod = await import('@sparticuz/chromium');
  const chromium = chromiumMod.default || chromiumMod;
  const ppMod = await import('puppeteer-core');
  const puppeteer = ppMod.default || ppMod;

  const executablePath = await chromium.executablePath();
  let args = chromium.args || [];
  try { args = await puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }); } catch (e) { /* keep chromium.args */ }
  return puppeteer.launch({
    args,
    executablePath,
    headless: 'shell',
    defaultViewport: { width: 794, height: 1123, deviceScaleFactor: 2 },
  });
}

// kind: 'pdf' | 'png'  ->  Buffer
async function render(data, ctx, kind) {
  const html = build(data, getBrand(), ctx);
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(() => (document.fonts && document.fonts.ready) || null);
    if (kind === 'png') {
      await page.emulateMediaType('screen');
      return Buffer.from(await page.screenshot({ type: 'png', fullPage: true }));
    }
    return Buffer.from(await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: footerTemplate(getBrand()),
      margin: { top: '14mm', bottom: '16mm', left: '14mm', right: '14mm' },
    }));
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { renderPdf: (d, c) => render(d, c, 'pdf'), renderPng: (d, c) => render(d, c, 'png') };
