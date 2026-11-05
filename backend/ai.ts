import { importMode } from "./imports/provider.js";
import { and, eq, gt } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { analysisEfforts, analysisModels, defaultAnalysisPreference, type AnalysisPreference } from "../shared/ai.js";
import { db } from "./db/client.js";
import { session, user, userAiPreferences } from "./db/schema.js";
import { PersonalChatGPTConnections, personalConnectionConfiguration } from "./chatgpt/connections.js";
import { VMChatGPTConnections } from "./chatgpt/vm-connections.js";
import { ownerAllowed } from "./personal-installation.js";

const configuration = personalConnectionConfiguration(process.env);
async function sessionIsActive(userId: string, sessionId: string) {
  const [active] = await db.select({ email: user.email }).from(session).innerJoin(user, eq(session.userId, user.id))
    .where(and(eq(session.id, sessionId), eq(session.userId, userId), gt(session.expiresAt, new Date())));
  return Boolean(active && ownerAllowed(active.email));
}
export const chatgptConnections = configuration.transfer
  ? new VMChatGPTConnections(new URL(process.env.APP_ORIGIN!).origin, sessionIsActive)
  : new PersonalChatGPTConnections(configuration, undefined, sessionIsActive);
export async function aiSettings(userId: string) {
  const [saved] = await db.select({ model: userAiPreferences.model, effort: userAiPreferences.effort }).from(userAiPreferences).where(eq(userAiPreferences.userId, userId));
  return { importMode: importMode(), preference: saved ?? defaultAnalysisPreference, chatgpt: await chatgptConnections.status(userId) };
}
export async function saveAnalysisPreference(userId: string, input: Record<string, unknown>) {
  if (Object.keys(input).some(k => !["model", "effort"].includes(k)) ||
    !analysisModels.some(m => m.id === input.model) || !analysisEfforts.some(e => e.id === input.effort))
    throw new HTTPException(400, { message: "Choose a supported model and reasoning effort." });
  const preference = input as AnalysisPreference;
  await db.insert(userAiPreferences).values({ userId, ...preference }).onConflictDoUpdate({ target: userAiPreferences.userId, set: preference });
  return preference;
}
