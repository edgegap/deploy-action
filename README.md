# Edgegap Deploy Action

This action takes the game server image your workflow just pushed and makes it deployable on [Edgegap](https://edgegap.com). It can also prove the build boots on a real server before anyone plays it, and then switch your live version to it.

1. **Create a version.** It creates an app version for the new image tag, copying ports, resources, env vars, max duration and restart policy from an existing version, so nothing else changes. Edgegap first checks it can pull the image.
2. **Smoke test** (optional). It deploys the new version near a location you choose and waits until the deployment is Ready. The deployment must then stay up for `smoke-duration` without restarting, and the action stops it afterwards. If the server crashes or never starts, the job fails with Edgegap's reason and the container logs.
3. **Promote** (optional). Once everything passed, it points a version name your matchmaker or backend already deploys (for example `prod`) at the new image. Rolling back means running the action again with the previous tag.

The action only calls the public Edgegap API and has no dependencies.

## Usage

```yaml
- uses: edgegap/deploy-action@v0
  with:
    api-token: ${{ secrets.EDGEGAP_API_TOKEN }}
    application: my-game
    tag: ${{ steps.image.outputs.tag }}           # the tag you just pushed
    registry-username: ${{ secrets.EDGEGAP_REGISTRY_USERNAME }}
    registry-token: ${{ secrets.EDGEGAP_REGISTRY_TOKEN }}
    smoke-test: true
    promote-version: prod
```

[`examples/deploy.yml`](examples/deploy.yml) is a complete workflow. It builds the server image, pushes it to the Edgegap registry, then creates, smoke-tests and promotes the version.

`@v0` moves to each new 0.x release. Because this action receives your Edgegap API token, you may prefer to review changes before they run. Pin a release (`edgegap/deploy-action@v0.1.0`) or, as GitHub recommends for third-party actions, a full commit SHA. Dependabot keeps either up to date.

### Before the first run

- **One version must exist.** Create the first version in the dashboard, or with the Edgegap plugin or MCP, and deploy it once by hand. The action copies its settings into every new version. Pick the source with `base-version`; without it, the action uses the application's newest version.
- **Registry login.** Edgegap never returns a version's registry login through the API, so the action can't copy it. Pass `registry-username` and `registry-token` whenever the image is private. Edgegap's own registry is always private. For `registry.edgegap.com`, copy the username and token from the dashboard's **Container Registry** page into repository secrets. The same login works for `docker login` in the build step.
- **Secret env vars.** For the same reason, a secret env var on the base version must come from `version-secrets`. If one is missing, the action fails before creating anything rather than storing a placeholder.

## Inputs

| Input | Default | Description |
|---|---|---|
| `api-token` | required | Edgegap API token, with or without the `token ` prefix. Keep it in a secret. |
| `application` | required | Edgegap application name. |
| `tag` | required | Image tag you just pushed. `latest` is refused. |
| `image` | base version's image | Image reference without the tag, starting with the registry host, e.g. `registry.edgegap.com/my-project/my-game`. |
| `base-version` | newest version | Version whose settings are copied. |
| `version` | UTC time, `YYYYMMDD-HHMM` | Name of the version to create. If it already exists with the same image, the action reuses it, so re-running a job is safe. If it exists with a different image, the action fails. |
| `registry-username`, `registry-token` | | Registry login for the image. Required for private images. |
| `version-secrets` | | Secret env vars for the new version, one `KEY=VALUE` per line. Masked in the log. |
| `verify-image` | `true` | Have Edgegap check it can pull the image before creating the version. |
| `smoke-test` | `false` | Deploy the version, check it stays up, then stop it. |
| `smoke-near` | `40.7128,-74.0060` | Where to deploy the smoke test: `latitude,longitude` or a public IP. Edgegap picks the closest location with capacity. |
| `smoke-duration` | `60s` | How long the deployment must stay Ready, in one stretch, to pass. |
| `startup-timeout` | `5m` | How long it may take to become Ready. The first deployment of a large image is the slowest. |
| `smoke-env` | | Extra env vars for the smoke-test deployment only, one `KEY=VALUE` per line. Sent hidden and masked in the log. |
| `show-logs` | `on-failure` | When to print the container logs: `on-failure`, `always` or `never`. |
| `promote-version` | | Existing version to point at the new image once everything passed. |
| `api-url` | `https://api.edgegap.com` | Must be `https` and an `*.edgegap.com` host, because the token is sent to it. |
| `allow-custom-api-url` | `false` | Set to `true` to allow another host. |
| `github-deployment` | | Record the run as a GitHub Deployment to this environment, e.g. `edgegap-production`. Needs `permissions: deployments: write`. |
| `github-token` | `${{ github.token }}` | Token for the GitHub Deployment. |

## Outputs

| Output | Description |
|---|---|
| `version` | The created (or reused) version name. |
| `image` | The full image reference of that version. |
| `request-id`, `fqdn`, `public-ip`, `ports` (JSON), `location` | From the smoke-test deployment. |

## On the run page

Every run writes a job summary with these parts:
- The version and the version its settings came from.
- The smoke-test result, with how long the deployment took to become Ready, where it ran, and its ports.
- Whether the action promoted a version.
- On failure, Edgegap's error and the last 50 log lines.

When `github-deployment` is set, the repository's Deployments list also shows each run, linked to its log.

## Good to know

- **What the smoke test proves.** The container started, Edgegap marked it Ready, and it didn't exit or restart during `smoke-duration`. The action reads the container's restart count, so a crash loop hidden by `restart_policy: always` still fails. It doesn't connect to your game: add a client test step after the action, using the `fqdn` and `ports` outputs, and set `smoke-duration` long enough for that step.
- **A failed build still leaves a version.** The new version exists even when its smoke test fails. Without `promote-version`, nothing deploys it unless someone asks for it by name, and the next run creates a new one.
- **Cleanup.** The action stops the smoke-test deployment when the test ends. If the job is cancelled, a post step stops it. If the runner dies, the version's max duration ends it, so keep a max duration set on the base version.
- **Cost.** A smoke test is a real deployment and is billed like one, for about a minute. On the free tier it counts toward the one deployment you can run at a time.
- **Logs are your server's output.** If your repository's Actions logs are public, don't let your server print secrets. While printing them, the action turns workflow commands off, so server output can't run commands such as `::add-mask::`.
- **Retries.** While watching a deployment or stopping it, the action retries timeouts, rate limits and server errors. It fails straight away on authentication errors.
- **What promoting changes.** It changes the image of `promote-version` and nothing else. Ports, resources and env vars stay as they are on that version, so change them in the dashboard or the base version first. Matchmakers that deploy that version name pick up the new image on their next deployment.

## Development

```sh
npm test
```

[`.github/workflows/e2e.yml`](.github/workflows/e2e.yml) runs the action against a real Edgegap organization. It is started by hand and needs an `EDGEGAP_API_TOKEN` secret.

## About Edgegap

[Edgegap](https://edgegap.com) hosts multiplayer game servers. It starts a dedicated server near the players for each match, across 600+ locations.

- Docs: [docs.edgegap.com](https://docs.edgegap.com)
- Edgegap for coding agents: [edgegap/llm-mcp-server](https://github.com/edgegap/llm-mcp-server) and [edgegap/llm-agent-skills](https://github.com/edgegap/llm-agent-skills)
