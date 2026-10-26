import { isIP } from "node:net";
import { EdgegapError, isTransient } from "./edgegap.mjs";

const POLL_MS = 5_000;
// A new deployment can answer 404 on status for a moment.
const UNKNOWN_GRACE_MS = 60_000;
const STOP_RETRY_MS = 60_000;
const LOG_LINES = 200;
const SUMMARY_LOG_LINES = 50;
const FAILED = ["ERROR", "TERMINATED", "TERMINATING"];

// Version fields POST /v1/app/{app}/version accepts, copied from the base version.
const COPIED_FIELDS = [
  "req_cpu",
  "req_memory",
  "req_video",
  "force_cache",
  "time_to_deploy",
  "max_duration",
  "restart_policy",
  "termination_grace_period_seconds",
  "will_deploy_in_mainland_china",
  "dns_config",
  "endpoint_storage",
];

export class ActionFailure extends Error {}

export function parseDuration(value, name) {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!value || !match) throw new ActionFailure(`${name} must look like 90s, 5m or 1h30m (got "${value}").`);
  const [, h = 0, m = 0, s = 0] = match;
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000;
}

export function parseBoolean(value, name) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ActionFailure(`${name} must be true or false (got "${value}").`);
}

export function parseEnv(value, name = "smoke-env") {
  const env = [];
  for (const line of value.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const at = line.indexOf("=");
    if (at <= 0) throw new ActionFailure(`${name} lines must be KEY=VALUE.`);
    const key = line.slice(0, at).trim();
    if (/^(ARBITRIUM_|MM_)/i.test(key)) throw new ActionFailure(`${name}: ${key} is reserved by Edgegap.`);
    env.push({ key, value: line.slice(at + 1) });
  }
  return env;
}

// "45.5,-73.6" or a public IP address, as a v2 deployment user.
export function parseNear(value) {
  const near = value.trim();
  if (isIP(near)) return { user_type: "ip_address", user_data: { ip_address: near } };
  const match = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(near);
  const [lat, long] = match ? [Number(match[1]), Number(match[2])] : [NaN, NaN];
  if (!match || Math.abs(lat) > 90 || Math.abs(long) > 180) {
    throw new ActionFailure(`smoke-near must be "latitude,longitude" or an IP address (got "${value}").`);
  }
  return { user_type: "geo_coordinates", user_data: { latitude: lat, longitude: long } };
}

// "registry.edgegap.com/project/game" -> { repository, image }.
export function parseImage(ref) {
  const value = ref.trim();
  const [first, ...rest] = value.split("/");
  if (value.includes("@") || rest.at(-1)?.includes(":")) {
    throw new ActionFailure(`image must not include a tag or digest; pass the tag in tag (got "${value}").`);
  }
  if (!rest.length || !(first.includes(".") || first.includes(":") || first === "localhost")) {
    throw new ActionFailure(`image must start with the registry host, e.g. registry.edgegap.com/my-project/my-game (got "${value}").`);
  }
  return { repository: first, image: rest.join("/") };
}

export function checkTag(tag) {
  if (!/^[\w][\w.-]{0,127}$/.test(tag)) throw new ActionFailure(`tag "${tag}" is not a valid image tag.`);
  if (tag === "latest") {
    throw new ActionFailure("tag must not be latest: Edgegap caches images by tag, so latest can deploy an old build. Push a unique tag.");
  }
}

export function timestampVersion(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}`;
}

function newest(versions) {
  return [...versions].sort((a, b) => String(b.create_time).localeCompare(String(a.create_time)))[0];
}

export function imageRef({ docker_repository, docker_image, docker_tag }) {
  return `${docker_repository}/${docker_image}:${docker_tag}`;
}

// The version body: the base version's settings with the new image.
// The API never returns secret env values (only a placeholder), so they come from `secrets`.
export function versionBody(base, { name, repository, image, tag, registry, verifyImage, secrets = {} }) {
  const body = { name, is_active: true, docker_repository: repository, docker_image: image, docker_tag: tag, verify_image: verifyImage };
  for (const field of COPIED_FIELDS) if (base[field] !== undefined && base[field] !== null) body[field] = base[field];
  body.ports = (base.ports ?? []).map((p) => ({
    name: p.name,
    port: p.port,
    // The API returns "Websocket" but only documents "WS" for creating.
    protocol: /^websocket$/i.test(p.protocol) ? "WS" : p.protocol,
    to_check: p.to_check ?? true,
    tls_upgrade: p.tls_upgrade ?? false,
  }));
  body.envs = (base.envs ?? []).map((e) =>
    e.is_secret ? { key: e.key, value: secrets[e.key], is_secret: true } : { key: e.key, value: e.value ?? "", is_secret: false },
  );
  for (const [key, value] of Object.entries(secrets)) {
    if (!body.envs.some((e) => e.key === key)) body.envs.push({ key, value, is_secret: true });
  }
  if (registry.username) {
    body.private_username = registry.username;
    body.private_token = registry.token;
  }
  return body;
}

function explain(error, inputs) {
  if (!(error instanceof EdgegapError)) return error;
  const hints = {
    401: "The API token was rejected. Check the secret (Edgegap dashboard, User Settings > Tokens).",
    403: "The token's organization may not have access to this, or the plan does not allow it.",
    404: `Application "${inputs.application}" or a version was not found for this token's organization.`,
    422: "Edgegap could not allocate a server for this version near smoke-near: check the version's vCPU and memory against your plan, then retry.",
    429: "Rate limited by Edgegap. Retry the job in a minute.",
  };
  if (error.operation === "create-version" && error.status === 400) {
    return new ActionFailure(
      `${error.message}. If it mentions the image, check that the tag was pushed and that the version's registry login can pull it.`,
    );
  }
  const hint = hints[error.status];
  return new ActionFailure(hint ? `${error.message}. ${hint}` : error.message);
}

export async function run(inputs, deps) {
  try {
    return await steps(inputs, deps);
  } catch (error) {
    throw explain(error, inputs);
  }
}

async function steps(inputs, deps) {
  const { client, core, report } = deps;
  const { application, tag } = inputs;
  checkTag(tag);
  const name = inputs.version || timestampVersion(new Date(deps.now()));
  if (inputs.promoteVersion && inputs.promoteVersion === name) {
    throw new ActionFailure("promote-version must name another version than the one this run creates.");
  }

  // Check everything this run depends on before creating anything.
  let base;
  if (inputs.baseVersion) {
    base = await client.getVersion(application, inputs.baseVersion);
    if (!base) throw new ActionFailure(`base-version "${inputs.baseVersion}" does not exist in application "${application}".`);
  } else {
    base = newest(await client.listVersions(application));
    if (!base) {
      throw new ActionFailure(
        `Application "${application}" has no version to copy settings from. Create the first one in the dashboard ` +
          "(or with the Edgegap MCP or plugin), then let this action create the next ones.",
      );
    }
  }
  const secrets = Object.fromEntries(inputs.secrets.map((e) => [e.key, e.value]));
  const missing = (base.envs ?? []).filter((e) => e.is_secret && !(e.key in secrets)).map((e) => e.key);
  if (missing.length) {
    throw new ActionFailure(
      `Version ${base.name} has secret env vars Edgegap never returns: ${missing.join(", ")}. ` +
        "Pass their values in version-secrets (KEY=VALUE lines, from your repository secrets).",
    );
  }
  core.info(`Copying ports, resources and settings from version ${base.name}.`);
  report.baseVersion = base.name;

  if (inputs.promoteVersion && !(await client.getVersion(application, inputs.promoteVersion))) {
    throw new ActionFailure(`promote-version "${inputs.promoteVersion}" does not exist in application "${application}".`);
  }

  const { repository, image } = inputs.image
    ? parseImage(inputs.image)
    : { repository: base.docker_repository, image: base.docker_image };
  // Like secret env vars, the API only returns a placeholder for the registry login.
  const registry = inputs.registryUsername ? { username: inputs.registryUsername, token: inputs.registryToken } : {};
  if (!registry.username && base.private_username && repository === base.docker_repository) {
    throw new ActionFailure(
      `Version ${base.name} pulls from ${repository} with a registry login, which Edgegap never returns. ` +
        "Set registry-username and registry-token from your repository secrets (for registry.edgegap.com: " +
        "dashboard > Container Registry).",
    );
  }
  if (!registry.username) core.info(`No registry login: ${repository} must allow anonymous pulls.`);
  const target = { docker_repository: repository, docker_image: image, docker_tag: tag };
  report.image = imageRef(target);
  core.setOutput("image", report.image);

  const existing = await client.getVersion(application, name);
  if (existing) {
    if (imageRef(existing) !== report.image) {
      throw new ActionFailure(
        `Version ${name} already exists with image ${imageRef(existing)}. Set version to a new name ` +
          "(two runs in the same minute get the same default name).",
      );
    }
    core.info(`Version ${name} already exists with this image; reusing it.`);
    report.version = { name, created: false };
  } else {
    await client.createVersion(
      application,
      versionBody(base, { name, repository, image, tag, registry, verifyImage: inputs.verifyImage, secrets }),
    );
    core.info(`Created version ${name} with ${report.image}.`);
    report.version = { name, created: true };
  }
  core.setOutput("version", name);

  if (inputs.smokeTest) await smokeTest(name, inputs, deps);

  if (inputs.promoteVersion) {
    const patch = registry.username
      ? { ...target, private_username: registry.username, private_token: registry.token }
      : { ...target };
    await client.updateVersion(application, inputs.promoteVersion, patch);
    report.promoted = inputs.promoteVersion;
    core.info(`Promoted: version ${inputs.promoteVersion} now runs ${report.image}.`);
  }
}

async function smokeTest(version, inputs, deps) {
  const { client, core, report } = deps;
  const tags = ["github-action", ...(inputs.runId ? [`gh-run-${inputs.runId}`.slice(0, 40)] : [])];
  const requestId = await client.deploy({
    application: inputs.application,
    version,
    users: [inputs.near],
    tags,
    ...(inputs.env.length
      ? { environment_variables: inputs.env.map((e) => ({ key: e.key, value: e.value, is_hidden: true })) }
      : {}),
  });
  // Saved at once, so the post step stops it if the job is cancelled.
  core.saveState("request-id", requestId);
  core.setOutput("request-id", requestId);
  core.info(`Started smoke-test deployment ${requestId}.`);
  report.smoke = { requestId, passed: false };

  let failure;
  try {
    const ready = await watch(requestId, inputs, deps);
    Object.assign(report.smoke, ready);
    core.setOutput("fqdn", ready.fqdn ?? "");
    core.setOutput("public-ip", ready.publicIp ?? "");
    core.setOutput("ports", JSON.stringify(ready.ports ?? {}));
    core.setOutput("location", ready.location ?? "");
  } catch (error) {
    failure = error;
  }

  // Restarts hide behind a Ready status when the restart policy brings the server back.
  const logs = await readLogs(requestId, deps, Boolean(failure));
  if (!failure && logs?.crash?.restart_count > 0) {
    failure = new ActionFailure(
      `The server restarted ${logs.crash.restart_count} time(s) during the smoke test` +
        (logs.crash.exit_code !== undefined ? ` (last exit code ${logs.crash.exit_code})` : "") +
        ".",
    );
  }
  if (logs && (inputs.showLogs === "always" || (failure && inputs.showLogs === "on-failure"))) {
    const lines = logs.logs.split("\n").slice(-LOG_LINES);
    core.startGroup(`Deployment ${requestId} logs (last ${lines.length} lines)`);
    core.infoUntrusted(lines.join("\n"));
    core.endGroup();
    if (failure) report.smoke.logTail = lines.slice(-SUMMARY_LOG_LINES);
  }
  report.smoke.passed = !failure;
  if (!failure) core.info("Smoke test passed.");

  await stopDeployment(requestId, deps);
  if (failure) throw failure;
}

async function watch(requestId, { startupTimeoutMs, smokeDurationMs }, { client, core, sleep, now }) {
  const startedAt = now();
  let readySince;
  let ready;
  for (;;) {
    let status;
    let known = true;
    try {
      status = await client.status(requestId);
    } catch (error) {
      if (!isTransient(error)) throw error;
      core.info(`Could not read the status (${error.message}); retrying.`);
      known = false;
    }
    const t = now();
    if (known && !status) {
      if (t - startedAt > UNKNOWN_GRACE_MS) throw new ActionFailure(`Deployment ${requestId} disappeared.`);
    } else if (known) {
      const current = String(status.current_status ?? "").toUpperCase();
      if (status.error || FAILED.some((s) => current.includes(s))) {
        throw new ActionFailure(
          `Deployment ${requestId} went to ${status.current_status}` +
            (status.error_detail ? `: ${String(status.error_detail).slice(0, 300).replace(/\.+$/, "")}` : "") +
            ".",
        );
      }
      if (status.running || current.includes("READY")) {
        if (readySince === undefined) {
          readySince = t;
          const loc = status.location ?? {};
          ready = {
            fqdn: status.fqdn,
            publicIp: status.public_ip,
            ports: status.ports ?? {},
            location: [loc.city, loc.country].filter(Boolean).join(", "),
            readyAfterMs: t - startedAt,
          };
          core.info(`Ready after ${Math.round((t - startedAt) / 1000)}s on ${status.fqdn} (${ready.location || "unknown location"}).`);
        }
        if (t - readySince >= smokeDurationMs) return ready;
      } else if (readySince !== undefined) {
        throw new ActionFailure(`Deployment ${requestId} left Ready (now ${status.current_status}).`);
      }
    }
    if (readySince === undefined && t - startedAt > startupTimeoutMs) {
      throw new ActionFailure(
        `Deployment ${requestId} was not Ready within startup-timeout` +
          (status?.current_status ? ` (still ${status.current_status})` : "") +
          ". A large image downloads slowly the first time; raise startup-timeout or turn on image caching.",
      );
    }
    await sleep(POLL_MS);
  }
}

async function readLogs(requestId, { client, core }, failed) {
  try {
    return await client.logs(requestId);
  } catch (error) {
    if (failed && error.status === 404) {
      core.info("No container logs: Edgegap drops them when a deployment fails, unless the version has Endpoint Storage.");
      return undefined;
    }
    core.warning(`Could not read the container logs of ${requestId}: ${error.message}`);
    return undefined;
  }
}

// Never throws: a failed stop is a warning, and the version's max duration is the backstop.
export async function stopDeployment(requestId, { client, core, sleep, now }) {
  const deadline = now() + STOP_RETRY_MS;
  for (;;) {
    try {
      const outcome = await client.stop(requestId);
      core.saveState("request-id", "");
      core.info(outcome === "stopped" ? `Stopped deployment ${requestId}.` : `Deployment ${requestId} was already stopped.`);
      return true;
    } catch (error) {
      if (!isTransient(error) || now() >= deadline) {
        core.warning(
          `Could not stop deployment ${requestId}: ${error.message}. Stop it in the dashboard; ` +
            "otherwise the version's max duration ends it.",
        );
        return false;
      }
    }
    await sleep(POLL_MS);
  }
}
