// Embeds the Inter font (from the @fontsource/inter npm package) as base64 @font-face rules, so the
// report looks the same everywhere and needs no network. If the package is missing (for example when
// testing on a machine that has Inter installed) the system font is used instead.
const fs = require('fs');
const path = require('path');

const RANGES = {
  'cyrillic-ext': 'U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F',
  cyrillic: 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116',
  'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
};
const WEIGHTS = [400, 500, 600, 700, 800];

let cache = null;

function findDir() {
  const candidates = [
    path.join(process.cwd(), 'node_modules', '@fontsource', 'inter', 'files'),
    path.join(__dirname, '..', 'node_modules', '@fontsource', 'inter', 'files'),
  ];
  return candidates.find((d) => fs.existsSync(d)) || null;
}

function fontCss() {
  if (cache !== null) return cache;
  const dir = findDir();
  let css = '';
  let found = 0;
  if (dir) {
    for (const w of WEIGHTS) {
      for (const [subset, range] of Object.entries(RANGES)) {
        const file = path.join(dir, `inter-${subset}-${w}-normal.woff2`);
        if (!fs.existsSync(file)) continue;
        found++;
        css += `@font-face{font-family:'Inter';font-style:normal;font-weight:${w};font-display:block;` +
          `src:url(data:font/woff2;base64,${fs.readFileSync(file).toString('base64')}) format('woff2');unicode-range:${range};}\n`;
      }
    }
  }
  cache = css;
  fontCss.found = found;
  fontCss.dir = dir;
  return cache;
}

module.exports = { fontCss };
