import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Pool } from "pg";
import { createApp } from "../frontend/server";

const applications: ReturnType<typeof createApp>[] = [];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function application(databaseUrl?: string) {
  const app = createApp(databaseUrl);
  applications.push(app);
  return app;
}

function offlineApplication() {
  const original = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    return application();
  } finally {
    if (original !== undefined) process.env.DATABASE_URL = original;
  }
}

function request(path: string, payload?: unknown) {
  return new Request(`http://localhost${path}`, {
    ...(payload === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
  });
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

describe("guide availability and input validation", () => {
  test("guide and liveness work without a database", async () => {
    const app = offlineApplication();
    const page = await app.fetch(request("/"));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toStartWith("text/html");
    expect(await page.text()).toContain("Vers");
    const health = await app.fetch(request("/health/live"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
  });

  test.each(["/health/ready", "/api/state", "/api/notes"])(
    "%s reports unavailable when no database is configured",
    async (path) => {
      const app = offlineApplication();
      const response = await app.fetch(
        request(path, path === "/api/notes" ? { body: "A note" } : undefined),
      );
      expect(response.status).toBe(503);
      const data = await response.json();
      expect(typeof data.detail).toBe("string");
      expect(data.detail.length).toBeGreaterThan(0);
    },
  );

  test("an unreachable database does not expose connection credentials", async () => {
    const password = "must-not-appear-in-public-errors";
    const databaseUrl = `postgresql://guide:${password}@127.0.0.1:1/vers_guide`;
    const app = application(databaseUrl);
    expect((await app.fetch(request("/"))).status).toBe(200);
    expect((await app.fetch(request("/health/live"))).status).toBe(200);
    for (const path of ["/health/ready", "/api/state", "/api/notes"]) {
      const response = await app.fetch(
        request(path, path === "/api/notes" ? { body: "A note" } : undefined),
      );
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(text).not.toContain(password);
      expect(text).not.toContain(databaseUrl);
      expect(text).not.toContain("127.0.0.1");
      expect(typeof JSON.parse(text).detail).toBe("string");
    }
  }, 15_000);

  test.each([
    {},
    { body: "" },
    { body: " \t\n " },
    { body: "x".repeat(181) },
    { body: 123 },
    { body: null },
    { body: ["not a string"] },
    { body: "A note", unexpected: "field" },
  ])("rejects invalid note %j before using the database", async (payload) => {
    const app = offlineApplication();
    const response = await app.fetch(request("/api/notes", payload));
    expect(response.status).toBe(422);
  });

  test("rejects an oversized body before JSON parsing", async () => {
    const app = offlineApplication();
    const response = await app.fetch(
      new Request("http://localhost/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{${" ".repeat(2048)}`,
      }),
    );
    expect(response.status).toBe(413);
  });

  test("malformed JSON is rejected without a database connection", async () => {
    const app = offlineApplication();
    const response = await app.fetch(
      new Request("http://localhost/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"body":',
      }),
    );
    expect(response.status).toBe(400);
  });

  test("streamed request bodies have the same size limit", async () => {
    const app = offlineApplication();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"body":"'));
        controller.enqueue(encoder.encode("x".repeat(1500)));
        controller.enqueue(encoder.encode("x".repeat(1500)));
        controller.enqueue(encoder.encode('"}'));
        controller.close();
      },
    });
    const response = await app.fetch(
      new Request("http://localhost/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    expect(response.status).toBe(413);
  });
});

interface Note {
  id: string;
  body: string;
  created_at: string;
}

function expectNote(note: Note, body: string) {
  expect(note.id).toMatch(uuidPattern);
  expect(note.body).toBe(body);
  expect(Number.isNaN(Date.parse(note.created_at))).toBe(false);
  expect(note.created_at).toMatch(/(?:Z|[+-]\d\d:\d\d)$/);
}

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("real PostgreSQL integration", () => {
  beforeAll(async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const { rows: [state] } = await pool.query(`
        SELECT current_user AS role, to_regclass('public.notes') AS notes,
          to_regclass('public.stack_identity') AS identity
      `);
      expect(state.role).toBe("guide");
      expect(state.notes).toBeTruthy();
      expect(state.identity).toBeTruthy();
    } finally {
      await pool.end();
    }
  });

  test("notes and database identity survive frontend recreation", async () => {
    const body = `Hello from a new frontend ${crypto.randomUUID()}`;
    const firstApp = application(databaseUrl);
    expect((await firstApp.fetch(request("/health/ready"))).status).toBe(200);
    const initial = await (await firstApp.fetch(request("/api/state"))).json();
    const createdResponse = await firstApp.fetch(request("/api/notes", { body: ` \n${body}\t ` }));
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expectNote(created, body);
    await firstApp.close();
    applications.splice(applications.indexOf(firstApp), 1);

    const secondApp = application(databaseUrl);
    const stateResponse = await secondApp.fetch(request("/api/state"));
    expect(stateResponse.status).toBe(200);
    const state = await stateResponse.json();
    expect(state.total_notes).toBe(initial.total_notes + 1);
    expect(state.notes[0].id).toBe(created.id);
    expectNote(state.notes[0], body);
    expect(Date.parse(state.notes[0].created_at)).toBe(Date.parse(created.created_at));
    expect(state.database.status).toBe("connected");
    expect(state.database.instance_id).toMatch(uuidPattern);
    expect(state.database.instance_id).toBe(initial.database.instance_id);
    expect(typeof state.database.latency_ms).toBe("number");
    expect(Number.isFinite(state.database.latency_ms)).toBe(true);
    expect(state.database.latency_ms).toBeGreaterThanOrEqual(0);
  });

  test("state returns the latest eight notes and total count", async () => {
    const app = application(databaseUrl);
    const initial = await (await app.fetch(request("/api/state"))).json();
    const created: Note[] = [];
    for (let index = 0; index < 10; index++) {
      const response = await app.fetch(
        request("/api/notes", { body: `Ordered note ${index} ${crypto.randomUUID()}` }),
      );
      expect(response.status).toBe(201);
      created.push(await response.json());
    }
    const state = await (await app.fetch(request("/api/state"))).json();
    expect(state.total_notes).toBe(initial.total_notes + 10);
    const expected = created.slice(-8).reverse();
    expect(state.notes.map((note: Note) => note.id)).toEqual(expected.map((note) => note.id));
    for (const [index, note] of (state.notes as Note[]).entries()) {
      expectNote(note, expected[index]!.body);
      expect(Date.parse(note.created_at)).toBe(Date.parse(expected[index]!.created_at));
    }
  });

  test("SQL-like and HTML-like note content is stored literally", async () => {
    const body = `'); DROP TABLE notes; -- <script>alert('hello')</script> ${crypto.randomUUID()}`;
    const app = application(databaseUrl);
    const response = await app.fetch(request("/api/notes", { body }));
    expect(response.status).toBe(201);
    const note = await response.json();
    expectNote(note, body);
    const state = await (await app.fetch(request("/api/state"))).json();
    expect(state.notes[0].body).toBe(body);
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const { rows: [saved] } = await pool.query("SELECT body FROM notes WHERE id = $1", [note.id]);
      expect(saved.body).toBe(body);
    } finally {
      await pool.end();
    }
  });

  test("validation and request limits do not insert notes", async () => {
    const app = application(databaseUrl);
    const initial = await (await app.fetch(request("/api/state"))).json();
    for (const payload of [
      { body: "   " },
      { body: "x".repeat(181) },
      { body: "Valid text", id: crypto.randomUUID() },
      { body: 42 },
    ]) {
      expect((await app.fetch(request("/api/notes", payload))).status).toBe(422);
    }
    expect((await app.fetch(request("/api/notes", { body: "x".repeat(3000) }))).status).toBe(413);
    const final = await (await app.fetch(request("/api/state"))).json();
    expect(final.total_notes).toBe(initial.total_notes);
  });

  test("180 Unicode characters and an exact 2048-byte request are accepted", async () => {
    const body = "🌱".repeat(180);
    const payload = JSON.stringify({ body });
    const exactLimit = payload + " ".repeat(2048 - new TextEncoder().encode(payload).length);
    const app = application(databaseUrl);
    const accepted = await app.fetch(
      new Request("http://localhost/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: exactLimit,
      }),
    );
    expect(accepted.status).toBe(201);
    expectNote(await accepted.json(), body);
    const rejected = await app.fetch(
      new Request("http://localhost/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `${exactLimit} `,
      }),
    );
    expect(rejected.status).toBe(413);
  });

  test("the database role cannot modify or delete existing data", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const { rows: [role] } = await pool.query(`
        SELECT rolsuper, rolcreatedb, rolcreaterole
        FROM pg_roles WHERE rolname = current_user
      `);
      expect(role).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false });
      for (const statement of [
        "DELETE FROM notes WHERE false",
        "UPDATE notes SET body = 'changed' WHERE false",
        "UPDATE stack_identity SET instance_id = gen_random_uuid() WHERE false",
        "DELETE FROM stack_identity WHERE false",
        "CREATE TABLE public.should_not_be_allowed (id integer)",
        "CREATE TEMPORARY TABLE should_not_be_allowed (id integer)",
      ]) {
        await expect(pool.query(statement)).rejects.toHaveProperty("code", "42501");
      }
    } finally {
      await pool.end();
    }
  });
});
