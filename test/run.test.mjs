import { test } from "node:test";
import assert from "node:assert/strict";
import { EdgegapError } from "../src/edgegap.mjs";
import {
  ActionFailure,
  checkTag,
  parseDuration,
  parseEnv,
  parseImage,
  parseNear,
  run,
  timestampVersion,
  versionBody,
} from "../src/run.mjs";

const BASE = {
  name: "20261020-1000",
  create_time: "2026-10-20 10:00:00",
  docker_repository: "registry.edgegap.com",
  docker_image: "proj/game",
  docker_tag: "old",
  private_username: "This value is set and encrypted",
  private_token: "This value is set and encrypted",
  req_cpu: 256,
  req_memory: 512,
  req_video: 0,
  max_duration: 30,
  restart_policy: "always",
  force_cache: false,
  ports: [{ name: "gameport", port: 7777, protocol: "UDP", to_check: true, tls_upgrade: false }],
  envs: [{ key: "MODE", value: "duel", is_secret: false }],
  inject_context_env: true,
};

function fakeCore() {
  const calls = { info: [], warning: [], outputs: {}, state: {}, untrusted: [] };
  return {
    calls,
    info: (m) => calls.info.push(m),
    warning: (m) => calls.warning.push(m),
    setOutput: (k, v) => (calls.outputs[k] = v),
    saveState: (k, v) => (calls.state[k] = v),
    startGroup: () => {},
    endGroup: () => {},
    infoUntrusted: (t) => calls.untrusted.push(t),
  };
}

// statuses: what /v1/status returns on each poll; the last one repeats.
function fakeClient({ versions = [BASE], statuses = [], logs = { logs: "boot\nok", crash: null }, deployError, stopErrors = 0 } = {}) {
  const calls = { created: [], patched: [], deployed: [], stopped: 0, statusPolls: 0 };
  const store = new Map(versions.map((v) => [v.name, v]));
  return {
    calls,
    getVersion: async (_app, name) => store.get(name) ?? null,
    listVersions: async () => [...store.values()],
    createVersion: async (_app, body) => {
      calls.created.push(body);
      store.set(body.name, body);
      return body;
    },
    updateVersion: async (_app, name, body) => calls.patched.push({ name, body }),
    deploy: async (body) => {
      if (deployError) throw deployError;
      calls.deployed.push(body);
      return "abc123";
    },
    status: async () => statuses[Math.min(calls.statusPolls++, statuses.length - 1)],
    logs: async () => logs,
    stop: async () => {
      if (calls.stopped++ < stopErrors) throw new EdgegapError("stop", 503, "busy");
      return "stopped";
    },
  };
}

function deps(client) {
  let t = Date.parse("2026-10-26T15:04:00Z");
  return {
    client,
    core: fakeCore(),
    report: {},
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

const INPUTS = {
  application: "game",
  tag: "sha-1234567",
  image: "",
  baseVersion: "",
  version: "",
  registryUsername: "robot",
  registryToken: "real-token",
  verifyImage: true,
  smokeTest: false,
  near: parseNear("40.7,-74.0"),
  smokeDurationMs: 20_000,
  startupTimeoutMs: 60_000,
  env: [],
  secrets: [],
  showLogs: "on-failure",
  promoteVersion: "",
  runId: "42",
};

const READY = { current_status: "Status.READY", running: true, fqdn: "abc123.pr.edgegap.net", public_ip: "192.0.2.1", ports: { gameport: { internal: 7777, external: 31000, protocol: "UDP" } }, location: { city: "Newark", country: "United States" } };

test("parsers", () => {
  assert.equal(parseDuration("1h30m", "x"), 5_400_000);
  assert.equal(parseDuration("45s", "x"), 45_000);
  assert.throws(() => parseDuration("5 minutes", "x"), ActionFailure);
  assert.deepEqual(parseNear("203.0.113.9"), { user_type: "ip_address", user_data: { ip_address: "203.0.113.9" } });
  assert.deepEqual(parseNear(" 48.85, 2.35 ").user_data, { latitude: 48.85, longitude: 2.35 });
  assert.throws(() => parseNear("Paris"), ActionFailure);
  assert.throws(() => parseNear("91,0"), ActionFailure);
  assert.deepEqual(parseImage("registry.edgegap.com/proj/game"), { repository: "registry.edgegap.com", image: "proj/game" });
  assert.deepEqual(parseImage("localhost:5000/game"), { repository: "localhost:5000", image: "game" });
  assert.throws(() => parseImage("proj/game"), /registry host/);
  assert.throws(() => parseImage("registry.edgegap.com/proj/game:1"), /tag or digest/);
  assert.throws(() => checkTag("latest"), /latest/);
  assert.throws(() => checkTag("bad tag"), ActionFailure);
  assert.deepEqual(parseEnv("A=1\nB = x=y\n"), [{ key: "A", value: "1" }, { key: "B", value: " x=y" }]);
  assert.throws(() => parseEnv("ARBITRIUM_X=1"), /reserved/);
  assert.equal(timestampVersion(new Date("2026-01-02T03:04:59Z")), "20260102-0304");
});

test("versionBody copies settings and swaps the image", () => {
  const body = versionBody(BASE, {
    name: "v",
    repository: "registry.edgegap.com",
    image: "proj/game",
    tag: "new",
    registry: { username: "robot", token: "secret-token" },
    verifyImage: true,
  });
  assert.equal(body.docker_tag, "new");
  assert.equal(body.req_cpu, 256);
  assert.equal(body.max_duration, 30);
  assert.equal(body.private_token, "secret-token");
  assert.deepEqual(body.ports, BASE.ports);
  assert.deepEqual(body.envs, BASE.envs);
  assert.equal(body.inject_context_env, undefined);
  assert.equal(body.create_time, undefined);
});

test("creates a timestamped version from the newest version", async () => {
  const older = { ...BASE, name: "first", create_time: "2026-01-01 00:00:00", req_cpu: 1024 };
  const client = fakeClient({ versions: [older, BASE] });
  const d = deps(client);
  await run(INPUTS, d);
  assert.equal(client.calls.created.length, 1);
  const body = client.calls.created[0];
  assert.equal(body.name, "20261026-1504");
  assert.equal(body.req_cpu, 256);
  assert.equal(body.docker_image, "proj/game");
  assert.equal(body.docker_tag, "sha-1234567");
  assert.equal(body.private_username, "robot");
  assert.equal(body.private_token, "real-token");
  assert.equal(d.core.calls.outputs.version, "20261026-1504");
  assert.equal(d.core.calls.outputs.image, "registry.edgegap.com/proj/game:sha-1234567");
  assert.equal(d.report.baseVersion, BASE.name);
  assert.equal(client.calls.deployed.length, 0);
});

test("a registry login is required, never copied", async () => {
  const client = fakeClient();
  await assert.rejects(run({ ...INPUTS, registryUsername: "", registryToken: "" }, deps(client)), /registry login, which Edgegap never returns/);
  assert.equal(client.calls.created.length, 0);
  await run({ ...INPUTS, registryUsername: "", registryToken: "", image: "ghcr.io/me/game" }, deps(client));
  const body = client.calls.created[0];
  assert.equal(body.docker_repository, "ghcr.io");
  assert.equal(body.private_username, undefined);
  assert.equal(body.private_token, undefined);
});

test("reuses an existing version with the same image, refuses a different one", async () => {
  const same = { ...BASE, name: "rerun", docker_tag: "sha-1234567" };
  const client = fakeClient({ versions: [BASE, same] });
  const d = deps(client);
  await run({ ...INPUTS, version: "rerun" }, d);
  assert.equal(client.calls.created.length, 0);
  assert.equal(d.report.version.created, false);
  await assert.rejects(run({ ...INPUTS, version: BASE.name }, deps(fakeClient())), /already exists with image/);
});

test("fails before creating anything when base or promote version is missing", async () => {
  const client = fakeClient();
  await assert.rejects(run({ ...INPUTS, baseVersion: "nope" }, deps(client)), /base-version "nope"/);
  await assert.rejects(run({ ...INPUTS, promoteVersion: "prod" }, deps(client)), /promote-version "prod"/);
  await assert.rejects(run(INPUTS, deps(fakeClient({ versions: [] }))), /no version to copy/);
  assert.equal(client.calls.created.length, 0);
});

test("smoke test passes, stops the deployment, then promotes", async () => {
  const prod = { ...BASE, name: "prod" };
  const client = fakeClient({ versions: [BASE, prod], statuses: [null, { current_status: "Status.DEPLOYING" }, READY] });
  const d = deps(client);
  await run({ ...INPUTS, smokeTest: true, promoteVersion: "prod", env: [{ key: "MAP", value: "test" }] }, d);
  const deployed = client.calls.deployed[0];
  assert.equal(deployed.version, "20261026-1504");
  assert.deepEqual(deployed.tags, ["github-action", "gh-run-42"]);
  assert.deepEqual(deployed.users, [INPUTS.near]);
  assert.deepEqual(deployed.environment_variables, [{ key: "MAP", value: "test", is_hidden: true }]);
  assert.equal(client.calls.stopped, 1);
  assert.equal(d.core.calls.state["request-id"], "");
  assert.equal(d.core.calls.outputs.fqdn, "abc123.pr.edgegap.net");
  assert.equal(d.core.calls.outputs.location, "Newark, United States");
  assert.equal(d.report.smoke.passed, true);
  assert.deepEqual(client.calls.patched, [
    {
      name: "prod",
      body: {
        docker_repository: "registry.edgegap.com",
        docker_image: "proj/game",
        docker_tag: "sha-1234567",
        private_username: "robot",
        private_token: "real-token",
      },
    },
  ]);
  assert.equal(d.core.calls.untrusted.length, 0);
});

test("a deployment error fails, prints logs, stops and does not promote", async () => {
  const prod = { ...BASE, name: "prod" };
  const client = fakeClient({
    versions: [BASE, prod],
    statuses: [{ current_status: "Status.ERROR", error: true, error_detail: "image pull failed" }],
    logs: { logs: "::add-mask::x\ncrash", crash: null },
  });
  const d = deps(client);
  await assert.rejects(run({ ...INPUTS, smokeTest: true, promoteVersion: "prod" }, d), /Status.ERROR: image pull failed/);
  assert.equal(client.calls.stopped, 1);
  assert.equal(client.calls.patched.length, 0);
  assert.match(d.core.calls.untrusted[0], /crash/);
  assert.deepEqual(d.report.smoke.logTail, ["::add-mask::x", "crash"]);
});

test("missing logs after a failed start are explained, not warned", async () => {
  const client = fakeClient({ statuses: [{ current_status: "Status.ERROR", error: true }] });
  client.logs = async () => {
    throw new EdgegapError("container-logs", 404, "Deployment logs not found");
  };
  const d = deps(client);
  await assert.rejects(run({ ...INPUTS, smokeTest: true }, d), /Status.ERROR\./);
  assert.equal(d.core.calls.warning.length, 0);
  assert.ok(d.core.calls.info.some((m) => /Endpoint Storage/.test(m)));
});

test("a restart during the smoke test fails it", async () => {
  const client = fakeClient({ statuses: [READY], logs: { logs: "", crash: { restart_count: 2, exit_code: 139 } } });
  await assert.rejects(run({ ...INPUTS, smokeTest: true }, deps(client)), /restarted 2 time\(s\).*exit code 139/);
  assert.equal(client.calls.stopped, 1);
});

test("startup timeout", async () => {
  const client = fakeClient({ statuses: [{ current_status: "Status.DEPLOYING" }] });
  await assert.rejects(run({ ...INPUTS, smokeTest: true }, deps(client)), /not Ready within startup-timeout \(still Status.DEPLOYING\)/);
  assert.equal(client.calls.stopped, 1);
});

test("transient status errors are retried; stop retries on 503", async () => {
  const client = fakeClient({ statuses: [READY], stopErrors: 2 });
  const original = client.status;
  let first = true;
  client.status = async (id) => {
    if (first) {
      first = false;
      throw new EdgegapError("status", 503, "busy");
    }
    return original(id);
  };
  const d = deps(client);
  await run({ ...INPUTS, smokeTest: true }, d);
  assert.equal(client.calls.stopped, 3);
});

test("API errors get a hint", async () => {
  const client = fakeClient({ deployError: new EdgegapError("deploy", 422, "no capacity") });
  await assert.rejects(run({ ...INPUTS, smokeTest: true }, deps(client)), /422.*vCPU and memory/);
  const bad = fakeClient();
  bad.listVersions = async () => {
    throw new EdgegapError("list-versions", 401, "Unauthorized");
  };
  await assert.rejects(run(INPUTS, deps(bad)), /token was rejected/);
});

test("secret env vars need version-secrets, never the placeholder", async () => {
  const base = { ...BASE, envs: [...BASE.envs, { key: "API_KEY", value: "This value is set and encrypted", is_secret: true }] };
  const client = fakeClient({ versions: [base] });
  await assert.rejects(run(INPUTS, deps(client)), /secret env vars Edgegap never returns: API_KEY/);
  assert.equal(client.calls.created.length, 0);
  await run({ ...INPUTS, secrets: [{ key: "API_KEY", value: "real" }, { key: "NEW", value: "n" }] }, deps(client));
  assert.deepEqual(client.calls.created[0].envs, [
    { key: "MODE", value: "duel", is_secret: false },
    { key: "API_KEY", value: "real", is_secret: true },
    { key: "NEW", value: "n", is_secret: true },
  ]);
});

test("Websocket ports are sent as WS", () => {
  const body = versionBody({ ...BASE, ports: [{ name: "ws", port: 80, protocol: "Websocket", tls_upgrade: true }] }, {
    name: "v", repository: "r.io", image: "i", tag: "t", registry: {}, verifyImage: false,
  });
  assert.equal(body.ports[0].protocol, "WS");
});

test("promote-version cannot be the new version", async () => {
  await assert.rejects(run({ ...INPUTS, version: "prod", promoteVersion: "prod" }, deps(fakeClient())), /another version/);
});
