import { pathToFileURL } from "node:url";
import * as core from "./core.mjs";
import { createClient, resolveOrigin } from "./edgegap.mjs";
import { createDeploymentRecorder } from "./github.mjs";
import { ActionFailure, parseBoolean, parseDuration, parseEnv, parseNear, run } from "./run.mjs";
import { renderSummary } from "./summary.mjs";

export function readInputs(env = process.env) {
  const input = (name) => core.getInput(name, env);
  for (const name of ["api-token", "application", "tag"]) {
    if (!input(name)) throw new ActionFailure(`Input ${name} is required.`);
  }
  const showLogs = input("show-logs") || "on-failure";
  if (!["on-failure", "always", "never"].includes(showLogs)) {
    throw new ActionFailure(`show-logs must be on-failure, always or never (got "${showLogs}").`);
  }
  if (Boolean(input("registry-username")) !== Boolean(input("registry-token"))) {
    throw new ActionFailure("Set registry-username and registry-token together.");
  }
  const smokeTest = parseBoolean(input("smoke-test") || "false", "smoke-test");
  return {
    token: input("api-token"),
    origin: resolveOrigin(input("api-url"), parseBoolean(input("allow-custom-api-url") || "false", "allow-custom-api-url")),
    application: input("application"),
    tag: input("tag"),
    image: input("image"),
    baseVersion: input("base-version"),
    version: input("version"),
    registryUsername: input("registry-username"),
    registryToken: input("registry-token"),
    verifyImage: parseBoolean(input("verify-image") || "true", "verify-image"),
    smokeTest,
    near: smokeTest ? parseNear(input("smoke-near") || "40.7128,-74.0060") : undefined,
    smokeDurationMs: parseDuration(input("smoke-duration") || "60s", "smoke-duration"),
    startupTimeoutMs: parseDuration(input("startup-timeout") || "5m", "startup-timeout"),
    env: parseEnv(input("smoke-env")),
    secrets: parseEnv(input("version-secrets"), "version-secrets"),
    showLogs,
    promoteVersion: input("promote-version"),
    githubDeployment: input("github-deployment"),
    githubToken: input("github-token"),
    runId: env.GITHUB_RUN_ID ?? "",
  };
}

async function main() {
  let report;
  let deployment;
  try {
    core.setSecret(core.getInput("api-token"));
    core.setSecret(core.getInput("registry-token"));
    const inputs = readInputs();
    // Masking short values like "1" would garble the whole log.
    [...inputs.env, ...inputs.secrets].map((e) => e.value).filter((v) => v.length >= 4).forEach(core.setSecret);
    report = { application: inputs.application, tag: inputs.tag };
    if (inputs.githubDeployment) {
      deployment = createDeploymentRecorder({ core, token: inputs.githubToken, environment: inputs.githubDeployment, report });
      await deployment.start();
    }
    await run(inputs, {
      client: createClient({ origin: inputs.origin, token: inputs.token }),
      core,
      report,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
    });
    await finish(report, deployment);
  } catch (error) {
    core.error(error.message);
    process.exitCode = 1;
    if (report) await finish(report, deployment, error);
  }
}

async function finish(report, deployment, error) {
  try {
    core.appendSummary(renderSummary(report, error));
  } catch (summaryError) {
    core.warning(`Could not write the job summary: ${summaryError.message}`);
  }
  await deployment?.finish(error);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
