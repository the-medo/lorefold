import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db } from "./db/client.js";
import * as schema from "./db/schema.js";
import { resolveTrustedOrigins } from "./origins.js";
import { googleProvider } from "./google-auth.js";

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
const google = googleProvider(process.env);
export const signInProviders = { google: Boolean(google) };
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
  socialProviders: google ? { google } : {},
  account: {
    encryptOAuthTokens: true,
    accountLinking: {
      enabled: true,
      allowDifferentEmails: false,
      // Password accounts are privately provisioned; Google creates new users
      // only after verifying their email. A verified Google identity can also
      // link to an existing password account with the same email.
      // Revisit this policy before enabling public email/password registration.
      requireLocalEmailVerified: false,
      trustedProviders: [],
    },
  },
  user: {
    validateUserInfo({ user, source }) {
      if (source.method === "oauth" && source.oauth?.providerId === "google" && user.emailVerified !== true) {
        return { error: "google_email_unverified", errorDescription: "Use a Google account with a verified email address." };
      }
    },
  },
  onAPIError: { errorURL: `${appOrigin}/sign-in` },
  advanced: { cookiePrefix: process.env.AUTH_COOKIE_PREFIX },
  session: { expiresIn: 60 * 60 * 24 * 7 },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-in/social": { window: 60, max: 10 },
    },
  },
});
