# Bot_for_preview

Telegram bot on Vercel. Anyone who messages the bot receives every file in `files/`.

## Setup
1. In Telegram, talk to @BotFather -> `/newbot` -> copy the token.
2. Vercel project -> Settings -> Environment Variables:
   - `BOT_TOKEN` = token from BotFather
   - `WEBHOOK_SECRET` = any long random string (letters/digits)
   - `CAPTION` (optional) = text sent with the file
3. Put your file(s) in `files/` (delete the placeholder) and deploy.
4. Open once in a browser: `https://<your-project>.vercel.app/api/setup?key=<WEBHOOK_SECRET>`
   You should see `"ok": true`.
5. Message your bot - it sends the file.

Limit: Telegram bots can upload files up to 50 MB.
