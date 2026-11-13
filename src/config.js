import { readFileSync } from 'node:fs';
import { AgentError } from './domain.js';

export function loadConfig(env = process.env) {
  const bool = (name, fallback = false) => {
    if (env[name] === undefined || env[name] === '') return fallback;
    if (!['true', 'false'].includes(env[name])) throw new AgentError(`invalid_${name}`);
    return env[name] === 'true';
  };
  const c = {
    port: Number(env.PORT || 3000), databaseUrl: env.DATABASE_URL || '',
    databaseCa: env.DATABASE_CA_FILE ? readFileSync(env.DATABASE_CA_FILE, 'utf8') : undefined,
    databaseTls: !bool('LOCAL_DATABASE_NO_TLS'),
    internalToken: env.INTERNAL_API_TOKEN || '', telegramToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramSecret: env.TELEGRAM_WEBHOOK_SECRET || '', telegramChat: env.TELEGRAM_CHAT_ID || '',
    telegramUsers: (env.TELEGRAM_ALLOWED_USER_IDS || '').split(',').map(x => x.trim()).filter(Boolean),
    geminiKey: env.GEMINI_API_KEY || '', geminiModel: env.GEMINI_MODEL || '',
    freeTierConfirmed: bool('GEMINI_FREE_TIER_CONFIRMED'),
    dryRun: bool('DRY_RUN', true), publishingEnabled: bool('PUBLISHING_ENABLED'),
    xCostAccepted: bool('X_COST_APPROVED'), xConsumerKey: env.X_CONSUMER_KEY || '',
    xConsumerSecret: env.X_CONSUMER_SECRET || '', xAccessToken: env.X_ACCESS_TOKEN || '', xAccessSecret: env.X_ACCESS_TOKEN_SECRET || '',
    style: JSON.parse(readFileSync(new URL('../config/style.json', import.meta.url))),
    sources: JSON.parse(readFileSync(new URL('../config/sources.json', import.meta.url)))
  };
  if (c.internalToken.length < 32 || c.telegramSecret.length < 32) throw new AgentError('configure_strong_internal_and_webhook_secrets');
  if (!c.databaseUrl) throw new AgentError('missing_database_url');
  if (c.geminiModel && !/^[a-zA-Z0-9._-]+$/.test(c.geminiModel)) throw new AgentError('invalid_model');
  return c;
}
