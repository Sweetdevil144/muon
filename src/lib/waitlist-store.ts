import { Client } from "pg";

export type SaveResult = "inserted" | "duplicate";

/**
 * Persists a waitlist signup to the Railway Postgres `waitlist` table.
 *
 * This talks to a STANDALONE `waitlist` table using a dedicated, least-privilege
 * role (`waitlist_writer`), it is fully decoupled from the MUON backend's
 * embedded SQLite "brain" (Prisma) schema. The connection string is provided at
 * runtime via WAITLIST_DATABASE_URL and never shipped to the browser.
 *
 * Dedupe is enforced in Postgres (unique index on the email); a duplicate signup
 * resolves to "duplicate" rather than an error, so re-submitting is idempotent.
 */
export async function saveSignup(
  email: string,
  name: string | null
): Promise<SaveResult> {
  const connectionString = process.env.WAITLIST_DATABASE_URL;
  if (!connectionString) {
    throw new Error("WAITLIST_DATABASE_URL is not configured");
  }

  const client = new Client({
    connectionString,
    // Railway Postgres (postgres-ssl image) terminates TLS at the public proxy;
    // it presents a self-signed cert, so verify-full is not applicable here.
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    query_timeout: 8000,
    statement_timeout: 8000,
  });

  await client.connect();
  try {
    // Plain INSERT + catch the unique_violation (23505), deliberately NOT
    // `ON CONFLICT (email) DO NOTHING`. The writer role is INSERT-only (no
    // SELECT), so it can never read the email list back; `ON CONFLICT` needs
    // extra table privileges and fails with 42501 (permission denied) for an
    // INSERT-only role. A duplicate email raises 23505, which we treat as an
    // idempotent "duplicate", re-submitting the same address is a no-op.
    await client.query(
      `INSERT INTO waitlist (email, name, source) VALUES (lower($1), $2, $3)`,
      [email, name, "marketing_site"]
    );
    return "inserted";
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "23505"
    ) {
      return "duplicate";
    }
    throw err;
  } finally {
    await client.end();
  }
}
