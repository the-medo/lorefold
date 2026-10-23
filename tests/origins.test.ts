import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTrustedOrigins } from "../backend/origins.js";

const canonical = "http://localhost:15237";
const development = { NODE_ENV: "development", LOREFOLD_WORKTREE_ID: "test" };

test("forwarding trusts one explicitly configured loopback origin", () => {
  assert.deepEqual(resolveTrustedOrigins(canonical, development), [canonical]);
  assert.deepEqual(
    resolveTrustedOrigins(canonical, {
      ...development,
      LOREFOLD_DEV_BROWSER_ORIGIN: "http://localhost:60204/",
    }),
    [canonical, "http://localhost:60204"],
  );
  assert.deepEqual(
    resolveTrustedOrigins(canonical, {
      ...development,
      LOREFOLD_DEV_BROWSER_ORIGIN: canonical,
    }),
    [canonical],
  );
});

test("forwarded origins cannot enable wildcard, external, or production access", () => {
  for (const value of [
    "*",
    "http://localhost:*",
    "https://external.example",
    "http://localhost.external.example:60204",
    "http://localhost:60204/path",
    "http://user:password@localhost:60204",
    "http://localhost:60204?query",
    "http://localhost:60204#fragment",
  ]) {
    assert.throws(() =>
      resolveTrustedOrigins(canonical, {
        ...development,
        LOREFOLD_DEV_BROWSER_ORIGIN: value,
      }),
    );
  }
  assert.throws(() =>
    resolveTrustedOrigins(canonical, {
      ...development,
      NODE_ENV: "production",
      LOREFOLD_DEV_BROWSER_ORIGIN: "http://localhost:60204",
    }),
  );
  assert.throws(() =>
    resolveTrustedOrigins(canonical, {
      NODE_ENV: "development",
      LOREFOLD_DEV_BROWSER_ORIGIN: "http://localhost:60204",
    }),
  );
});
