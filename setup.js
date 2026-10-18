// One-time helper: open  https://<your-domain>/api/setup?key=<WEBHOOK_SECRET>
// It tells Telegram to send all bot messages to /api/webhook on this deployment.
module.exports = async (req, res) => {
  const TOKEN = process.env.BOT_TOKEN;
  const SECRET = process.env.WEBHOOK_SECRET;

  if (!TOKEN || !SECRET) {
    return res.status(500).send('Set BOT_TOKEN and WEBHOOK_SECRET in Vercel first.');
  }
  if (req.query.key !== SECRET) {
    return res.status(401).send('Wrong key.');
  }

  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || req.headers['x-forwarded-host'];
  const url = `https://${host}/api/webhook`;

  const form = new FormData();
  form.append('url', url);
  form.append('secret_token', SECRET);
  form.append('allowed_updates', JSON.stringify(['message', 'callback_query']));
  form.append('drop_pending_updates', 'true');

  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
    method: 'POST',
    body: form,
  });
  const json = await r.json();

  // command list shown in Telegram's "Menu" button
  const cmdForm = new FormData();
  cmdForm.append('commands', JSON.stringify([
    { command: 'menu', description: 'Bosh menyu' },
    { command: 'profil', description: 'Mening profilim' },
    { command: 'arxiv', description: 'Tahlillar arxivi' },
    { command: 'tahlil', description: 'Yuborilgan fayllarni hozir tahlil qilish' },
    { command: 'namuna', description: 'Hisobot dizayni namunasi' },
    { command: 'yordam', description: 'Yordam' },
  ]));
  const commands = await fetch(`https://api.telegram.org/bot${TOKEN}/setMyCommands`, { method: 'POST', body: cmdForm })
    .then((x) => x.json()).catch(() => ({}));

  const me = await fetch(`https://api.telegram.org/bot${TOKEN}/getMe`).then((x) => x.json()).catch(() => ({}));
  const username = me && me.result && me.result.username;
  return res.status(200).json({
    webhook: url,
    telegram: json,
    commands,
    bot_link: username ? `https://t.me/${username}` : null,
  });
};
