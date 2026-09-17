import { Pool } from "pg";
import { join } from "node:path";

const STATIC = join(import.meta.dir, "static");
const MAX_BODY_BYTES = 2048;
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/static/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/static/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/static/favicon.svg", ["favicon.svg", "image/svg+xml"]],
  ["/static/brand/vers-wordmark.svg", ["brand/vers-wordmark.svg", "image/svg+xml"]],
]);

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function readNote(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new HttpError(413, "Request is too large.");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  let input: unknown;
  try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "Enter a valid JSON request."); }
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).length !== 1 || !("body" in input) || typeof input.body !== "string") {
    throw new HttpError(422, "Send a note with a text body.");
  }
  const body = input.body.trim();
  // Count Unicode code points, as PostgreSQL char_length does.
  if (!body || [...body].length > 180) {
    throw new HttpError(422, "Write between 1 and 180 characters.");
  }
  return body;
}

export function createApp(
  databaseUrl = process.env.DATABASE_URL,
  canvasOrigin = process.env.VERS_CANVAS_ORIGIN,
) {
  const frameAncestors = ["'self'", "https://vers.sh", "https://www.vers.sh", "http://localhost:3000"];
  if (canvasOrigin) {
    const url = new URL(canvasOrigin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== canvasOrigin || url.hostname.includes("*")) {
      throw new Error("VERS_CANVAS_ORIGIN must be an exact HTTP(S) origin without a path or credentials.");
    }
    frameAncestors.push(url.origin);
  }
  const contentSecurityPolicy = `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors ${frameAncestors.join(" ")}; form-action 'self'`;
  const pool = databaseUrl ? new Pool({
    connectionString: databaseUrl,
    max: 4,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 3000,
    query_timeout: 5000,
  }) : null;

  pool?.on("error", () => console.warn("An idle Postgres connection closed; reconnecting on demand."));

  function database() {
    if (!pool) throw new HttpError(503, "The database connection has not been configured.");
    return pool;
  }

  async function route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const asset = STATIC_FILES.get(path);
    if (asset && (request.method === "GET" || request.method === "HEAD")) {
      const [name, contentType] = asset;
      return new Response(request.method === "HEAD" ? null : Bun.file(join(STATIC, name)), {
        headers: { "Content-Type": contentType },
      });
    }
    if (request.method === "GET" && path === "/health/live") {
      return Response.json({ status: "ok" });
    }
    if (request.method === "GET" && path === "/health/ready") {
      const result = await database().query("SELECT instance_id FROM public.stack_identity WHERE id = 1");
      if (!result.rowCount) throw new HttpError(503, "The database has not been initialized.");
      return Response.json({ status: "ok" });
    }
    if (request.method === "GET" && path === "/api/state") {
      const start = performance.now();
      // One statement gives the count, notes and identity one consistent snapshot.
      const { rows: [row] } = await database().query(`
        SELECT instance_id,
          (SELECT COUNT(*)::integer FROM public.notes) AS total_notes,
          COALESCE((SELECT json_agg(recent ORDER BY created_at DESC, id DESC)
            FROM (SELECT id, body, created_at FROM public.notes
                  ORDER BY created_at DESC, id DESC LIMIT 8) recent), '[]') AS notes
        FROM public.stack_identity WHERE id = 1
      `);
      if (!row) throw new HttpError(503, "The database has not been initialized.");
      return Response.json({
        database: {
          status: "connected",
          latency_ms: Math.round((performance.now() - start) * 10) / 10,
          instance_id: row.instance_id,
        },
        notes: row.notes,
        total_notes: row.total_notes,
      });
    }
    if (request.method === "POST" && path === "/api/notes") {
      const body = await readNote(request);
      const { rows: [note] } = await database().query(
        "INSERT INTO public.notes (body) VALUES ($1) RETURNING id, body, created_at", [body],
      );
      return Response.json(note, { status: 201 });
    }
    return Response.json({ detail: "Not found." }, { status: 404 });
  }

  return {
    async fetch(request: Request): Promise<Response> {
      let response: Response;
      try { response = await route(request); }
      catch (error) {
        if (error instanceof HttpError) {
          response = Response.json({ detail: error.message }, { status: error.status });
        } else {
          // Never expose a connection URL, SQL statement, or driver error to visitors.
          console.warn("A request could not reach Postgres.");
          response = Response.json(
            { detail: "Postgres is unavailable. Please try again shortly." }, { status: 503 },
          );
        }
      }
      response.headers.set("X-Content-Type-Options", "nosniff");
      response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
      response.headers.set("Content-Security-Policy", contentSecurityPolicy);
      response.headers.set("Cache-Control", "no-store");
      return response;
    },
    async close() { await pool?.end(); },
  };
}

if (import.meta.main) {
  const app = createApp();
  const port = Number(process.env.PORT ?? 8080);
  const server = Bun.serve({ hostname: "0.0.0.0", port, maxRequestBodySize: MAX_BODY_BYTES, fetch: app.fetch });
  console.log(`Hello, Vers is listening on port ${server.port}`);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop();
    await app.close();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
