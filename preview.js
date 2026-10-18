// Design preview: open https://<your-domain>/api/preview in a browser to see the report template
// filled with sample data (edit templates/report.html, redeploy, refresh).
module.exports = (req, res) => {
  const { build } = require('../lib/report');
  const brand = require('../lib/brand')();
  const html = build(require('../lib/sample.json'), brand, { date: '18.10.2026', user: 'Namuna O‘quvchi' });
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.status(200).send(html);
};
