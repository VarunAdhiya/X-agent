import { loadConfig } from '../src/config.js';
import { connectDatabase } from '../src/db.js';

let db;
try {
  const config = loadConfig();
  db = connectDatabase(config);
  const settings = await db.command('settings');
  console.log(JSON.stringify({ database_connected: true, tls_verified: config.databaseTls,
    publishing_enabled: settings.publishing_enabled, paused: settings.paused,
    timezone: settings.timezone, daily_post_limit: settings.daily_post_limit }));
} catch (error) {
  // Do not expose connection strings, passwords, or query text in diagnostics.
  console.error(JSON.stringify({ database_connected: false, error_code: error.code || error.name }));
  process.exitCode = 1;
} finally {
  await db?.close();
}
