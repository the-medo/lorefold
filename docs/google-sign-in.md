# Google sign-in

Lorefold supports email/password and optional Google sign-in through Better Auth.
Both open the same private library. A first sign-in with a verified Google email
automatically creates an account; no invitation or manual provisioning is needed.
Existing users keep their account and data. Email/password accounts can still be
created with `run -- npm run user:create`; public email/password signup is disabled.

## Google Cloud setup

The Google Cloud project **lorefold** (project ID `lorefold`, number `155376887552`)
was created for this application. Manage its OAuth consent screen and web client
in the [Google Auth Platform](https://console.cloud.google.com/auth/overview?project=lorefold).
No billing account or application hosting is needed for this sign-in integration.

1. Configure branding with app name **Lorefold**, a support email, and developer
   contact email. For personal Gmail accounts, choose an **External** audience;
   start in **Testing** and add the intended readers as test users if required.
2. Under **Clients**, create a **Web application** client. Use a development client
   separately from any future production client. The app requests only `openid`,
   `email`, and `profile`; it does not need Gmail, Drive, or Cloud resource scopes.
3. Get the worktree's **Browser URL** with
   `scripts/worktree-dev/lorefold-worktree-dev status`. Register that exact origin
   plus `/api/auth/callback/google` as an **Authorized redirect URI**. For the
   initial `feature/sign-in` worktree, this is:

   ```text
   https://steamdeck.tail73a93e.ts.net:15184/api/auth/callback/google
   ```

   The server redirect flow does not require Authorized JavaScript origins. If
   adding one, use the Browser URL without a path. Each additional worktree needs
   its own exact redirect URI; wildcards and temporary forwarded ports are not used.
4. Save the client ID and secret in the worktree's ignored, developer-owned `.env`:

   ```dotenv
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   ```

   Do not edit generated `.env.worktree` files or put credentials in `VITE_*`.
   Keep a downloaded client JSON outside Git and readable only by your user.
   To reuse this pair for future Lorefold worktrees, run
   `scripts/worktree-dev/lorefold-worktree-dev configure-google --from-env .env`.
   The private machine profile seeds new `.env` files automatically; existing
   files remain unchanged. See [shared development credentials](../scripts/worktree-dev/README.md#shared-google-development-credentials).
5. Restart with `down`, then `up`, using the worktree launcher. With both values
   set, the sign-in page displays **Continue with Google**. With both empty, email
   sign-in remains available. A partial configuration fails startup with an
   actionable error instead of advertising a broken provider.
6. Sign in through the exact Browser URL with a Google account. A new user should
   reach an empty private library. Reload to confirm the session persists, make
   an authenticated change, sign out, and sign in again to confirm the same data
   is preserved. For an existing password account, also confirm email sign-in
   still opens the same library.

The CLI can create the project, but the supported web OAuth client setup uses
the Cloud Console. `gcloud iam oauth-clients` manages workforce federation clients;
the old IAP OAuth client API is deprecated and is not a general replacement.
See [Google's web client setup](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred)
and [Better Auth's Google integration](https://www.better-auth.com/docs/authentication/google).

## Account and session behavior

Google must report a verified email address. On first sign-in, Better Auth creates
the user, Google account, and session. The new private library starts empty; no
password or demo data is generated. The sample book can be seeded explicitly with
`run -- npm run db:seed -- email`. If the email already belongs to a local user,
Better Auth links the Google identity to that user instead; their user ID, books,
universes, themes, password, and progress remain intact. Later sign-ins use the
linked Google subject. Accounts with different emails cannot be linked.

Password accounts are created only by a trusted private provisioning command.
Because there is no local email-verification flow, automatic linking accepts Google's
verified email without requiring the local row to have been marked verified
beforehand. Revisit this policy before adding public email/password registration.
Unverified Google emails are rejected before account creation, first-time linking,
and returning sign-ins.

Better Auth handles OAuth state, PKCE, callback validation, and HTTP-only session
cookies. The existing exact trusted-origin list and per-worktree cookie prefix
apply to both login methods. OAuth access/refresh tokens are encrypted at rest;
the Google flow requests online access only. No provider credentials are returned
by the public `/api/auth/providers` availability endpoint.

## Verification

`run -- npm test` exercises the real OAuth routes with synthetic Google responses:
automatic account creation, account linking, returning sessions, password
compatibility, ownership, disabled email/password signup, unverified emails,
state validation, and cross-origin rejection.
`run -- npm run test:browser` covers the Google button, redirects, cancellation,
failures, and email fallback. These tests do not call Google or prove that a live
client/consent configuration works. After configuring a client, verify live sign-in
with a reader through the exact Browser URL, including session persistence
and an authenticated write.
