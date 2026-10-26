import { test } from "node:test";
import assert from "node:assert/strict";
import { googleProvider } from "../backend/google-auth.js";

test("Google stays optional but partial credentials fail without exposing secrets", () => {
  assert.equal(googleProvider({}), undefined);
  assert.equal(googleProvider({ GOOGLE_CLIENT_ID: " ", GOOGLE_CLIENT_SECRET: "" }), undefined);
  for (const env of [{ GOOGLE_CLIENT_ID: "test-client" }, { GOOGLE_CLIENT_SECRET: "test-secret" }]) {
    assert.throws(() => googleProvider(env), {
      message: "Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or leave both empty.",
    });
  }
  const provider = googleProvider({ GOOGLE_CLIENT_ID: " test-client ", GOOGLE_CLIENT_SECRET: " test-secret " });
  assert.equal(provider?.clientId, "test-client");
  assert.equal(provider?.disableSignUp, false);
});
