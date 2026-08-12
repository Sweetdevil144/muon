import { randomUUID } from "node:crypto";
import { Client } from "pg";

export type EnterpriseContactInput = {
  fullName: string;
  role: string;
  company: string;
  companyEmail: string;
  phoneNumber: string | null;
  problemDescription: string;
};

/**
 * Persists an enterprise contact inquiry.
 *
 * Table shape is owned by `EnterpriseContact` in
 * `backend/prisma/schema.prisma`. The marketing site writes to Railway
 * Postgres via WAITLIST_DATABASE_URL (same least-privilege writer path as
 * the waitlist), not the embedded SQLite brain.
 */
export async function saveEnterpriseContact(
  input: EnterpriseContactInput
): Promise<void> {
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
    const now = new Date();
    await client.query(
      `INSERT INTO "EnterpriseContact"
        ("id", "fullName", "role", "company", "companyEmail", "phoneNumber",
         "problemDescription", "source", "status", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        randomUUID(),
        input.fullName,
        input.role,
        input.company,
        input.companyEmail,
        input.phoneNumber,
        input.problemDescription,
        "marketing_site",
        "new",
        now,
        now,
      ]
    );
  } finally {
    await client.end();
  }
}
