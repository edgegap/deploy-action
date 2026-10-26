// A small client for the Edgegap API (https://docs.edgegap.com/docs/api), only what this action calls.

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_LOG_CHARS = 256 * 1024;

export class EdgegapError extends Error {
  constructor(operation, status, message) {
    super(`${operation} failed${status ? ` with HTTP ${status}` : ""}${message ? `: ${message}` : ""}`);
    this.operation = operation;
    // 0 means no response arrived.
    this.status = status;
  }
}

// Worth retrying while polling: no response, rate limited, or an Edgegap server error.
export function isTransient(error) {
  return error instanceof EdgegapError && (error.status === 0 || error.status === 429 || error.status >= 500);
}

// The token is sent to api-url, so only Edgegap hosts are allowed unless the workflow opts in.
export function resolveOrigin(apiUrl, allowCustom = false) {
  const url = new URL(apiUrl || "https://api.edgegap.com");
  if (url.protocol !== "https:") throw new Error("api-url must use https.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!allowCustom && host !== "edgegap.com" && !host.endsWith(".edgegap.com")) {
    throw new Error(
      `api-url must be an *.edgegap.com host (got ${host}), because the API token is sent to it. ` +
        "Set allow-custom-api-url: true to use another host.",
    );
  }
  return url.origin;
}

// Edgegap expects "token <value>"; accept the secret with or without the prefix.
export function authorization(token) {
  const value = token.trim().replace(/^token\s+/i, "");
  return `token ${value}`;
}

// Error bodies carry a `message`; never echo anything else from them.
async function errorMessage(response) {
  try {
    const body = await response.json();
    return typeof body?.message === "string" ? body.message.slice(0, 300).replace(/\.+$/, "") : "";
  } catch {
    return "";
  }
}

export function createClient({ origin, token, fetch = globalThis.fetch, userAgent = "edgegap-deploy-action" }) {
  const headers = { Authorization: authorization(token), Accept: "application/json", "User-Agent": userAgent };

  async function request(operation, method, path, { body, expect = [200] } = {}) {
    let response;
    try {
      response = await fetch(`${origin}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: body ? { ...headers, "Content-Type": "application/json" } : headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new EdgegapError(operation, 0, `could not reach ${origin} (${error.cause?.code ?? error.message})`);
    }
    if (!expect.includes(response.status)) {
      throw new EdgegapError(operation, response.status, await errorMessage(response));
    }
    return response;
  }

  const seg = encodeURIComponent;
  const versionPath = (app, version) => `/v1/app/${seg(app)}/version/${seg(version)}`;

  return {
    // null when the version does not exist.
    async getVersion(app, version) {
      const response = await request("get-version", "GET", versionPath(app, version), { expect: [200, 404] });
      return response.status === 404 ? null : response.json();
    },

    async listVersions(app) {
      const versions = [];
      for (let page = 1; page <= 20; page++) {
        const response = await request("list-versions", "GET", `/v1/app/${seg(app)}/versions?page=${page}&limit=100`);
        const body = await response.json();
        versions.push(...(body.versions ?? []));
        if (!body.pagination?.next_page_number) break;
      }
      return versions;
    },

    async createVersion(app, body) {
      const response = await request("create-version", "POST", `/v1/app/${seg(app)}/version`, { body });
      return (await response.json()).version;
    },

    async updateVersion(app, version, body) {
      const response = await request("update-version", "PATCH", versionPath(app, version), { body });
      return (await response.json()).version;
    },

    async deploy(body) {
      const response = await request("deploy", "POST", "/v2/deployments", { body, expect: [200, 201, 202] });
      return (await response.json()).request_id;
    },

    // null while the deployment is not visible yet, or after it is gone.
    async status(requestId) {
      const response = await request("status", "GET", `/v1/status/${seg(requestId)}`, { expect: [200, 404] });
      return response.status === 404 ? null : response.json();
    },

    // "stopped", or "already-stopped" (404, 409 or 410: gone, stopping, or terminated).
    async stop(requestId) {
      const response = await request("stop", "DELETE", `/v1/stop/${seg(requestId)}`, { expect: [200, 202, 404, 409, 410] });
      return [200, 202].includes(response.status) ? "stopped" : "already-stopped";
    },

    // { logs, crash_data } from the running container.
    async logs(requestId) {
      const response = await request("container-logs", "GET", `/v1/deployment/${seg(requestId)}/container-logs?format=text`);
      const body = await response.json();
      const logs = typeof body.logs === "string" ? body.logs : "";
      return { logs: logs.length > MAX_LOG_CHARS ? logs.slice(-MAX_LOG_CHARS) : logs, crash: body.crash_data ?? null };
    },
  };
}
