import type { Db } from '@/server/db/client'

/** Hashed one-time codes. All state changes are single atomic statements (safe under concurrency). */
export function otpRepository(db: Db) {
  return {
    async save(email: string, codeHash: string, ttlSeconds: number): Promise<void> {
      await db.query(
        `INSERT INTO app.otp_codes (email, code_hash, expires_at, attempts, created_at)
         VALUES ($1, $2, now() + make_interval(secs => $3::float8), 0, now())
         ON CONFLICT (email) DO UPDATE
           SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, created_at = now()`,
        [email, codeHash, ttlSeconds],
      )
    },

    /** Counts an attempt and returns the stored hash, or null if missing, expired or exhausted. */
    async registerAttempt(email: string, maxAttempts: number): Promise<{ codeHash: string } | null> {
      const [row] = await db.query<{ code_hash: string }>(
        `UPDATE app.otp_codes SET attempts = attempts + 1
         WHERE email = $1 AND expires_at > now() AND attempts < $2
         RETURNING code_hash`,
        [email, maxAttempts],
      )
      return row ? { codeHash: row.code_hash } : null
    },

    /** Deletes the code only if it is still the one that was verified — exactly one caller wins. */
    async consume(email: string, codeHash: string): Promise<boolean> {
      const rows = await db.query(`DELETE FROM app.otp_codes WHERE email = $1 AND code_hash = $2 RETURNING email`, [email, codeHash])
      return rows.length > 0
    },

    async purgeExpired(): Promise<void> {
      await db.query(`DELETE FROM app.otp_codes WHERE expires_at < now() - interval '1 day'`)
    },
  }
}

export function rateLimitRepository(db: Db) {
  return {
    /** Fixed-window counter; increments atomically and returns the count within the current window. */
    async hit(key: string, windowSeconds: number): Promise<{ count: number; resetAt: Date }> {
      const [row] = await db.query<{ count: number; reset_at: Date | string }>(
        `INSERT INTO app.rate_limits AS rl (key, window_start, count)
         VALUES ($1, now(), 1)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN rl.window_start <= now() - make_interval(secs => $2::float8) THEN 1 ELSE rl.count + 1 END,
           window_start = CASE WHEN rl.window_start <= now() - make_interval(secs => $2::float8) THEN now() ELSE rl.window_start END
         RETURNING count, window_start + make_interval(secs => $2::float8) AS reset_at`,
        [key, windowSeconds],
      )
      if (!row) throw new Error('Rate limit upsert returned no row')
      return { count: Number(row.count), resetAt: new Date(row.reset_at) }
    },

    async purgeStale(): Promise<void> {
      await db.query(`DELETE FROM app.rate_limits WHERE window_start < now() - interval '1 day'`)
    },
  }
}
