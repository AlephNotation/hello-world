import { describe, expect, test } from "bun:test";

const image = process.env.TEST_FRONTEND_IMAGE;

async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`docker ${args[0]} failed: ${stderr}`);
  return stdout.trim();
}

async function withFrontend(check: (id: string) => Promise<void>) {
  const id = await docker("run", "-d", image!);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await docker("exec", id, "bun", "-e",
          "const r = await fetch('http://127.0.0.1:8080/health/live'); process.exit(r.ok ? 0 : 1)");
        ready = true;
        break;
      } catch { await Bun.sleep(200); }
    }
    if (!ready) throw new Error(`Frontend did not start: ${await docker("logs", id)}`);
    await check(id);
  } finally {
    await docker("rm", "-f", id);
  }
}

describe.skipIf(!image)("frontend image", () => {
  test("serves IPv4 and IPv6 as a non-root user and stops cleanly", async () => {
    await withFrontend(async (id) => {
      expect(await docker("exec", id, "id", "-u")).toBe("1000");
      await docker("exec", id, "bun", "-e", `
        for (const host of ['127.0.0.1', '[::1]']) {
          const r = await fetch('http://' + host + ':8080/health/live');
          if (!r.ok || (await r.json()).status !== 'ok') process.exit(1);
        }
      `);
      await docker("stop", "--time", "8", id);
      expect(await docker("inspect", "--format", "{{.State.ExitCode}}", id)).toBe("0");
    });
  }, 20_000);

  for (const processName of ["bun", "nginx"]) {
    test(`exits when ${processName} dies`, async () => {
      await withFrontend(async (id) => {
        await docker("exec", id, "bun", "-e", `
          import { readdirSync, readFileSync } from 'node:fs';
          const target = ${JSON.stringify(processName)};
          const pid = target === 'nginx'
            ? Number(readFileSync('/tmp/hello-vers-nginx/nginx.pid', 'utf8'))
            : readdirSync('/proc').filter(x => /^\\d+$/.test(x)).map(Number).find(pid => {
                if (pid === process.pid) return false;
                try { return readFileSync('/proc/' + pid + '/comm', 'utf8').trim() === 'bun'; }
                catch { return false; }
              });
          if (!pid) throw new Error('Process not found');
          process.kill(pid, 'SIGTERM');
        `);
        const exitCode = await docker("wait", id);
        expect(Number(exitCode)).toBeGreaterThan(0);
      });
    }, 20_000);
  }
});
