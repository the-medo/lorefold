import { spawn } from "node:child_process";
import { createServer } from "node:net";

if (!process.env.LOREFOLD_WORKTREE_ID) {
  throw new Error(
    "Launch with scripts/worktree-dev/lorefold-worktree-dev run -- npm run dev",
  );
}
// Fail before starting either watcher if a reserved port has been claimed.
// Watchers intentionally remain alive after a code error, so process exit alone
// cannot detect a failed initial API bind.
const reservations = [];
try {
  for (const [host, port] of [
    [process.env.HOST, Number(process.env.PORT)],
    [process.env.VITE_HOST, Number(process.env.VITE_PORT)],
  ]) {
    if (
      host !== "127.0.0.1" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new Error(
        "Development requires assigned loopback hosts and valid worktree ports.",
      );
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
    reservations.push(server);
  }
} finally {
  await Promise.all(
    reservations.map(
      (server) => new Promise((resolve) => server.close(resolve)),
    ),
  );
}
const children = ["dev:api", "dev:web"].map((script) =>
  spawn("npm", ["run", script], {
    stdio: "inherit",
    env: process.env,
    detached: true,
  }),
);
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already exited */
    }
  }
  process.exitCode = code;
}
for (const child of children) {
  child.on("error", () => stop(1));
  child.on("exit", (code) => stop(code ?? 1));
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
