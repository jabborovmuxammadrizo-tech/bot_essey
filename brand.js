// Brand settings for the PDF/PNG report. Everything can be changed from Vercel env vars
// (no code change needed), the logo by replacing assets/logo.png (or logo.svg / logo.jpg).
//
//   BRAND_NAME      organisation / bot name shown in the header and footer
//   BRAND_TAGLINE   small line under the name
//   BRAND_HANDLE    @username, link or phone shown in the footer
//   BRAND_COLOR     main colour (hex)
//   BRAND_COLOR2    second colour of the header gradient (hex)
//   BRAND_ACCENT    accent colour (hex)
const fs = require('fs');
const path = require('path');

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp' };

function loadLogo() {
  for (const ext of Object.keys(MIME)) {
    const p = path.join(__dirname, '..', 'assets', 'logo.' + ext);
    try {
      if (fs.existsSync(p)) return `data:${MIME[ext]};base64,${fs.readFileSync(p).toString('base64')}`;
    } catch (e) { /* ignore */ }
  }
  return null;
}

module.exports = function getBrand() {
  return {
    name: process.env.BRAND_NAME || 'Insho Tahlili',
    tagline: process.env.BRAND_TAGLINE || "O'zbek tilidagi insholar uchun ustoz-yordamchi",
    handle: process.env.BRAND_HANDLE || '@new_test_teacher_bot',
    color: process.env.BRAND_COLOR || '#4F46E5',
    color2: process.env.BRAND_COLOR2 || '#7C3AED',
    accent: process.env.BRAND_ACCENT || '#F59E0B',
    logo: loadLogo(), // data URI or null (then the built-in mark is drawn)
  };
};
