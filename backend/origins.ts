export function resolveTrustedOrigins(
  appOrigin: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const origins = [new URL(appOrigin).origin];
  const forwarded = env.LOREFOLD_DEV_BROWSER_ORIGIN?.trim();
  if (!forwarded) return origins;
  if (env.NODE_ENV !== "development" || !env.LOREFOLD_WORKTREE_ID) {
    throw new Error(
      "LOREFOLD_DEV_BROWSER_ORIGIN is only supported in a development worktree.",
    );
  }
  const url = new URL(forwarded);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "LOREFOLD_DEV_BROWSER_ORIGIN must be an exact HTTP loopback origin, such as http://localhost:60204.",
    );
  }
  return [...new Set([...origins, url.origin])];
}
