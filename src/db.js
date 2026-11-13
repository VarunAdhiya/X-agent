import pg from 'pg';

export function connectDatabase(config) {
  // Do not put sslmode in the URL: pg URL options can override explicit TLS options.
  if (/[?&]ssl/i.test(config.databaseUrl)) throw new Error('Remove SSL query parameters; use DATABASE_CA_FILE instead');
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 3,
    ssl: config.databaseTls ? { rejectUnauthorized: true, ca: config.databaseCa } : false,
    connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000,
    statement_timeout: 20000, application_name: 'x-content-agent' });
  return {
    async command(op, payload = {}) {
      const { rows } = await pool.query('select agent.command($1,$2::jsonb) as result', [op, JSON.stringify(payload)]);
      return rows[0].result;
    },
    close: () => pool.end()
  };
}
