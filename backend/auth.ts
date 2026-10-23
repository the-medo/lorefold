import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db } from "./db/client.js";
import * as schema from "./db/schema.js";
import { resolveTrustedOrigins } from "./origins.js";

const secret = process.env.BETTER_AUTH_SECRET;
const baseURL = process.env.BETTER_AUTH_URL;
if (
  !secret ||
  secret.length < 32 ||
  !baseURL ||
  !process.env.AUTH_COOKIE_PREFIX
) {
  throw new Error(
    "Set BETTER_AUTH_SECRET (32+ characters), BETTER_AUTH_URL, and AUTH_COOKIE_PREFIX.",
  );
}
export const appOrigin = new URL(process.env.APP_ORIGIN ?? baseURL).origin;
export const trustedOrigins = resolveTrustedOrigins(appOrigin);
export const auth = betterAuth({
  appName: "Lorefold",
  baseURL,
  secret,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  trustedOrigins,
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
  },
  advanced: { cookiePrefix: process.env.AUTH_COOKIE_PREFIX },
  session: { expiresIn: 60 * 60 * 24 * 7 },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: { "/sign-in/email": { window: 60, max: 10 } },
  },
});
