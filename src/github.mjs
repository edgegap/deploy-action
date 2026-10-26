// Records the run as a GitHub Deployment, so the repository shows what is on Edgegap.
// Optional: a failure here is a warning and never fails the job.

export function createDeploymentRecorder({ env = process.env, fetch = globalThis.fetch, core, token, environment, report }) {
  const api = env.GITHUB_API_URL || "https://api.github.com";
  const repo = env.GITHUB_REPOSITORY;
  const logUrl = `${env.GITHUB_SERVER_URL || "https://github.com"}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`;
  let id;

  async function post(path, body) {
    const response = await fetch(`${api}/repos/${repo}${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const hint = [403, 404].includes(response.status) ? " Give the job `permissions: deployments: write`." : "";
      throw new Error(`GitHub answered HTTP ${response.status}.${hint}`);
    }
    return response.json();
  }

  async function status(state, description) {
    if (!id) return;
    try {
      await post(`/deployments/${id}/statuses`, { state, log_url: logUrl, description: description.slice(0, 140) });
    } catch (error) {
      core.warning(`Could not update the GitHub deployment: ${error.message}`);
    }
  }

  return {
    async start() {
      try {
        const deployment = await post("/deployments", {
          ref: env.GITHUB_SHA,
          environment,
          auto_merge: false,
          required_contexts: [],
          description: `${report.application}:${report.tag} on Edgegap`.slice(0, 140),
          payload: { application: report.application, tag: report.tag },
        });
        id = deployment.id;
        await status("in_progress", "Deploying to Edgegap");
      } catch (error) {
        core.warning(`Could not create a GitHub deployment: ${error.message}`);
      }
    },
    finish(error) {
      const done = report.promoted
        ? `${report.promoted} now runs ${report.tag}`
        : `version ${report.version?.name ?? "?"} ready on Edgegap`;
      return status(error ? "failure" : "success", error ? error.message : done);
    },
  };
}
