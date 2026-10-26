import { test } from "node:test";
import assert from "node:assert/strict";
import { authorization, createClient, EdgegapError, isTransient, resolveOrigin } from "../src/edgegap.mjs";

test("resolveOrigin allows only Edgegap hosts by default", () => {
  assert.equal(resolveOrigin(""), "https://api.edgegap.com");
  assert.equal(resolveOrigin("https://staging-api.edgegap.com/"), "https://staging-api.edgegap.com");
  assert.throws(() => resolveOrigin("http://api.edgegap.com"), /https/);
  assert.throws(() => resolveOrigin("https://api.edgegap.com.evil.io"), /edgegap.com host/);
  assert.throws(() => resolveOrigin("https://notedgegap.com"), /edgegap.com host/);
  assert.equal(resolveOrigin("https://localhost:8443", true), "https://localhost:8443");
});

test("authorization accepts the token with or without the prefix", () => {
  assert.equal(authorization("abc"), "token abc");
  assert.equal(authorization("token abc"), "token abc");
  assert.equal(authorization(" Token  abc "), "token abc");
});

test("isTransient", () => {
  assert.equal(isTransient(new EdgegapError("x", 0)), true);
  assert.equal(isTransient(new EdgegapError("x", 429)), true);
  assert.equal(isTransient(new EdgegapError("x", 502)), true);
  assert.equal(isTransient(new EdgegapError("x", 400)), false);
  assert.equal(isTransient(new Error("x")), false);
});

function fakeFetch(routes) {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, init });
    const key = `${init.method} ${new URL(url).pathname}`;
    const [status, body] = routes[key] ?? [404, { message: "not found" }];
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
  return { fetch, seen };
}

test("client requests", async () => {
  const { fetch, seen } = fakeFetch({
    "GET /v1/app/my%20game/version/v1": [200, { name: "v1" }],
    "POST /v2/deployments": [202, { request_id: "r1" }],
    "DELETE /v1/stop/r1": [410, { message: "gone" }],
    "GET /v1/deployment/r1/container-logs": [200, { logs: "a\nb", crash_data: { restart_count: 1 } }],
    "POST /v1/app/game/version": [400, { message: "Unable to pull image.", secret: "never shown" }],
  });
  const client = createClient({ origin: "https://api.edgegap.com", token: "t0k", fetch });
  assert.deepEqual(await client.getVersion("my game", "v1"), { name: "v1" });
  assert.equal(await client.getVersion("my game", "v2"), null);
  assert.equal(await client.deploy({}), "r1");
  assert.equal(await client.stop("r1"), "already-stopped");
  assert.deepEqual(await client.logs("r1"), { logs: "a\nb", crash: { restart_count: 1 } });
  await assert.rejects(client.createVersion("game", {}), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.message, "create-version failed with HTTP 400: Unable to pull image");
    return true;
  });
  assert.equal(seen[0].init.headers.Authorization, "token t0k");
  assert.equal(seen[0].init.redirect, "error");
});

test("network errors become status 0", async () => {
  const client = createClient({
    origin: "https://api.edgegap.com",
    token: "t",
    fetch: async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
    },
  });
  await assert.rejects(client.status("r"), (error) => error.status === 0 && /ECONNRESET/.test(error.message));
});
