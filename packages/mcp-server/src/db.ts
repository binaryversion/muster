import pg from "pg";

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await pool.query(text, params);
  return rows as T[];
}

export async function emit(projectId: string, kind: string, actor: string, payload: unknown) {
  await query(
    "INSERT INTO events (project_id, kind, actor, payload) VALUES ($1,$2,$3,$4)",
    [projectId, kind, actor, JSON.stringify(payload)]
  );
}
