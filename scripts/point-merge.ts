import { open, readFile, unlink } from "node:fs/promises";
import { parseArgs } from "node:util";

const usage = `npm run point-merge -- suggest --owner EMAIL --book BOOK_ID --plan FILE
npm run point-merge -- apply --owner EMAIL --book BOOK_ID --plan FILE --accept 1,3

suggest writes a private, numbered JSON plan using the configured AI mode.
Review the two passages and reveal chapter for each suggestion before applying its number.`;

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help") { console.log(usage); return; }
  const options = { owner: { type: "string" }, book: { type: "string" }, plan: { type: "string" } } as const;
  const { values } = parseArgs({ args, options: { ...options, accept: { type: "string" } } });
  const { owner, book, plan, accept } = values;
  if (!owner || !book || !plan || !["suggest", "apply"].includes(command) ||
      (command === "suggest" ? accept !== undefined : !accept || !/^[1-9]\d*(,[1-9]\d*)*$/.test(accept))) throw new Error(usage);

  const { pool, db } = await import("../backend/db/client.js");
  try {
    const { applyPointMerges, suggestPointMerges } = await import("../backend/point-merges.js");
    const { user } = await import("../backend/db/schema.js");
    const { eq } = await import("drizzle-orm");
    const [account] = await db.select({ id: user.id }).from(user).where(eq(user.email, owner.trim().toLowerCase()));
    if (!account) throw new Error("Book not found for this owner.");
    if (command === "apply") {
      const count = await applyPointMerges(account.id, book, JSON.parse(await readFile(plan, "utf8")), accept!.split(",").map(Number));
      console.log(`Applied ${count} new point merge(s).`);
    } else {
      const file = await open(plan, "wx", 0o600);
      let result;
      try {
        result = await suggestPointMerges(account.id, book);
        await file.writeFile(JSON.stringify(result, null, 2) + "\n");
      } catch (error) {
        await unlink(plan);
        throw error;
      } finally { await file.close(); }
      console.log(`Saved ${result.suggestions.length} suggestion(s) from ${result.provider} to ${plan}.`);
      for (const match of result.suggestions)
        console.log(`${match.number}. ${JSON.stringify(match.first.label)} + ${JSON.stringify(match.second.label)} (chapter ${match.fromChapter})`);
    }
  } finally { await pool.end(); }
}
main().catch(error => {
  console.error(error.cause ? "Point merge failed. Check the database and migrations." : error.message);
  process.exitCode = 1;
});
