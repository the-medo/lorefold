import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { homedir } from "node:os";
import { join } from "node:path";
import { PlanAuth, type Profile } from "../backend/chatgpt/auth.js";
import { emptyState, FilePlanAuthStore, type PlanAuthStore } from "../backend/chatgpt/store.js";

// Intentionally imports no database, dotenv, benchmark profile or web account.
// The selected session exists only in memory until the VM accepts the transfer.
const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
async function main() {
  if (args.includes("--help")) {
    console.log("Usage: npm run chatgpt:connect -- --server https://your-lorefold-host [--port 15190]\nRun on your browser's computer, then paste the setup code from AI & connections when prompted.");
    return;
  }
  const origin = new URL(option("--server") ?? "");
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
    throw new Error("Pass --server with your Lorefold HTTPS origin.");
  const port = Number(option("--port") ?? 15190);
  if (!Number.isInteger(port) || port < 15184 || port > 15190) throw new Error("Choose a free callback port in 15184–15190.");
  // Git Bash/MinTTY can expose native Windows stdin as a pipe. readline can
  // still read the setup code; isTTY is not a reliable interactivity test.
  const terminal = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY && stdout.isTTY) });
  console.log(`Connecting only to ${origin.origin}. The setup code expires after 20 minutes.`);
  let code: string;
  try {
    code = (await new Promise<string>((resolve, reject) => {
      terminal.once("line", resolve);
      const cancelled = () => reject(new Error("No setup code was entered. Run the helper again and paste the code when prompted."));
      terminal.once("close", cancelled); terminal.once("SIGINT", cancelled);
      terminal.setPrompt("Paste the setup code shown in Lorefold: "); terminal.prompt();
    })).trim();
  }
  finally { terminal.close(); }
  if (!/^[a-zA-Z0-9_-]{43}$/.test(code)) throw new Error("Invalid setup code. Start again in Lorefold.");
  const endpoint = new URL("/api/connections/chatgpt/provision", origin);
  async function request(profile?: Profile): Promise<Response> {
    let response;
    try { response = await fetch(endpoint, { method: profile ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(60000),
      headers: { authorization: `Bearer ${code}`, ...(profile ? { "content-type": "application/json" } : {}) },
      ...(profile ? { body: JSON.stringify(profile) } : {}) }); }
    catch { throw new Error("Could not confirm the transfer. Check the connection status in Lorefold before starting again."); }
    if (!response.ok) { await response.body?.cancel(); throw new Error("Lorefold did not accept this setup request. Check its connection status and start again if needed."); }
    return response;
  }
  const { registration } = await (await request()).json() as { registration: Profile | null };
  // Persist only the helper's opaque host ID. It remains distinct from the VM
  // and stable across restarts, without ever saving a second set of tokens.
  const hostStore = new FilePlanAuthStore(join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "lorefold", "chatgpt-connect-host"));
  const state = emptyState();
  state.hostId = await hostStore.locked(async saved => saved.hostId);
  if (registration) state.profiles.account = { clientId: registration.clientId, subject: registration.subject, email: registration.email, tokens: null };
  const store: PlanAuthStore = { read: async () => state, locked: async action => action(state, async next => { Object.assign(state, next); }) };
  const auth = new PlanAuth(undefined, fetch, store);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    await auth.login("account", port, url => {
      console.log(`\nOpen this URL in your browser:\n${url}\n`);
      console.log(`If the browser is on another computer, forward its 127.0.0.1:${port} to this computer's 127.0.0.1:${port} over SSH first.`);
    }, controller.signal);
    if (!state.profiles.account.tokens || !state.profiles.account.tokens.scopes.includes("chatgpt.tokens.use.direct")) {
      await auth.logout("account"); throw new Error("ChatGPT plan permission was not granted. Start again in Lorefold.");
    }
    const response = await request(state.profiles.account);
    let result;
    try { result = await response.json(); } catch { /* Treat an unreadable acknowledgement as uncertain. */ }
    if (result?.connected !== true) throw new Error("Could not confirm the transfer. Check the connection status in Lorefold before starting again.");
    state.profiles.account.tokens = null; // Do not revoke: the VM now owns refreshes.
    console.log("Connected. Return to Lorefold. The encrypted connection is now stored on your server.");
  } finally {
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    // Never retain a second refresh owner, including after an uncertain response.
    if (state.profiles.account) state.profiles.account.tokens = null;
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Connection failed."); process.exitCode = 1; });
