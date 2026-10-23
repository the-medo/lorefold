import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

if (!process.env.LOREFOLD_WORKTREE_ID)
  throw new Error("Use the isolated worktree launcher.");
const apiPort = Number(process.env.PORT);
const webPort = Number(process.env.VITE_PORT);
async function occupy(port: number) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}
const close = (server: Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));
function launch() {
  const child = spawn(process.execPath, ["scripts/dev.mjs"], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { child, exited, output: () => output };
}
async function until<T>(promise: Promise<T>, ms = 15_000): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Application lifecycle timed out.")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

test(
  "development starts on assigned ports, proxies the API, and stops both children",
  { timeout: 25_000 },
  async () => {
    // A running developer app should be stopped before this lifecycle suite.
    const apiReservation = await occupy(apiPort);
    await close(apiReservation);
    const webReservation = await occupy(webPort);
    await close(webReservation);
    const running = launch();
    let stopping = false;
    try {
      await until(
        (async () => {
          while (!stopping) {
            try {
              const health = await fetch(
                `http://127.0.0.1:${webPort}/api/health`,
                { signal: AbortSignal.timeout(1000) },
              );
              if (health.ok && (await health.json()).status === "ok") break;
            } catch {
              /* starting */
            }
            await delay(100);
          }
        })(),
      );
      const frontend = await fetch(`http://127.0.0.1:${webPort}`);
      assert.match(await frontend.text(), /Lorefold/);
    } finally {
      stopping = true;
      running.child.kill("SIGTERM");
      await until(running.exited);
    }
    const api = await occupy(apiPort);
    await close(api);
    const web = await occupy(webPort);
    await close(web);
  },
);

for (const [label, port, otherPort] of [
  ["API", apiPort, webPort],
  ["frontend", webPort, apiPort],
] as const) {
  test(
    `an occupied ${label} port fails without starting or stopping another service`,
    { timeout: 15_000 },
    async () => {
      const blocker = await occupy(port);
      const running = launch();
      try {
        assert.notEqual(await until(running.exited), 0);
        assert.match(running.output(), /EADDRINUSE/);
        assert.equal(blocker.listening, true);
        const other = await occupy(otherPort);
        await close(other);
      } finally {
        running.child.kill("SIGTERM");
        await close(blocker);
      }
    },
  );
}
