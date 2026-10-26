// Runs after the job's steps, including when the job was cancelled during the smoke test.
import * as core from "./core.mjs";
import { createClient, resolveOrigin } from "./edgegap.mjs";
import { stopDeployment } from "./run.mjs";

const requestId = core.getState("request-id");
if (requestId) {
  try {
    const client = createClient({
      origin: resolveOrigin(core.getInput("api-url"), core.getInput("allow-custom-api-url") === "true"),
      token: core.getInput("api-token"),
    });
    await stopDeployment(requestId, {
      client,
      core,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
    });
  } catch (error) {
    core.warning(`Could not stop deployment ${requestId}: ${error.message}. Stop it in the dashboard.`);
  }
}
