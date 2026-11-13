// Run from the trusted VPS after Workflow C has been activated.
import { request } from '../src/http.js';
const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret, PUBLIC_HOST: host } = process.env;
if (!token || !secret || !host || !/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error('Configure bot token, webhook secret, and public hostname');
const r = await request(`https://api.telegram.org/bot${token}/setWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: { url: `https://${host}/webhook/telegram-approval`, secret_token: secret,
    allowed_updates: ['message', 'callback_query'], max_connections: 2, drop_pending_updates: false } });
const result = JSON.parse(r.text);
if (!result.ok) throw new Error('Webhook registration failed; inspect bot configuration');
console.log('Telegram webhook registered; pending updates retained.');
