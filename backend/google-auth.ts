export function googleProvider(env: NodeJS.ProcessEnv) {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error("Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or leave both empty.");
  }
  if (!clientId || !clientSecret) return undefined;
  return {
    clientId,
    clientSecret,
    disableSignUp: true,
    prompt: "select_account" as const,
    accessType: "online" as const,
  };
}
