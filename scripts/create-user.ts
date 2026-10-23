import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import { provisionUser } from "../backend/provision-user.js";
import { pool } from "../backend/db/client.js";

let hidden = false;
const output = new Writable({
  write(chunk, _encoding, callback) {
    if (!hidden) stdout.write(chunk);
    callback();
  },
});
const rl = createInterface({
  input: stdin,
  output,
  terminal: Boolean(stdin.isTTY),
});
try {
  if (!stdin.isTTY)
    throw new Error(
      "Use an interactive terminal so the password stays out of shell history.",
    );
  const email = await rl.question("Email: ");
  const name = await rl.question("Name: ");
  stdout.write("Password (12–128 characters, hidden): ");
  hidden = true;
  const password = await rl.question("");
  hidden = false;
  stdout.write("\n");
  await provisionUser(email, password, name);
  console.log(
    "Private account created. Run db:seed with this email to add the sample book.",
  );
} catch (error) {
  const code = (error as { cause?: { code?: string } }).cause?.code;
  console.error(
    code === "23505"
      ? "That email already has an account."
      : (error as Error).cause
        ? "Account creation failed. Check the local database and migrations."
        : (error as Error).message,
  );
  process.exitCode = 1;
} finally {
  rl.close();
  await pool.end();
}
