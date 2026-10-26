import { and, eq, gt } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { analysisEfforts, analysisModels, defaultAnalysisPreference, type AnalysisPreference } from "../shared/ai.js";
import { db } from "./db/client.js";
import { session, userAiPreferences } from "./db/schema.js";
import { PersonalChatGPTConnections, personalConnectionConfiguration } from "./chatgpt/connections.js";

export const chatgptConnections = new PersonalChatGPTConnections(personalConnectionConfiguration(process.env), undefined, async (userId, sessionId) => {
  const [active] = await db.select({ id: session.id }).from(session).where(and(eq(session.id, sessionId), eq(session.userId, userId), gt(session.expiresAt, new Date())));
  return Boolean(active);
});
export async function aiSettings(userId: string) {
  const [saved] = await db.select({ model: userAiPreferences.model, effort: userAiPreferences.effort }).from(userAiPreferences).where(eq(userAiPreferences.userId, userId));
  return { preference: saved ?? defaultAnalysisPreference, chatgpt: await chatgptConnections.status(userId) };
}
export async function saveAnalysisPreference(userId: string, input: Record<string, unknown>) {
  if (Object.keys(input).some(k => !["model", "effort"].includes(k)) ||
    !analysisModels.some(m => m.id === input.model) || !analysisEfforts.some(e => e.id === input.effort))
    throw new HTTPException(400, { message: "Choose a supported model and reasoning effort." });
  const preference = input as AnalysisPreference;
  await db.insert(userAiPreferences).values({ userId, ...preference }).onConflictDoUpdate({ target: userAiPreferences.userId, set: preference });
  return preference;
}
