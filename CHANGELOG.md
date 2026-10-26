# Changelog

## 0.1.0

First release.

- Creates an app version for a new image tag, copying the settings of an existing version (`base-version`, or the newest). The version name defaults to the UTC time. Re-running with the same name and image reuses the version.
- Requires the registry login and secret env vars as inputs, because the Edgegap API returns only placeholders for them. It fails before creating anything when they are missing.
- Optional smoke test: deploys near `smoke-near` and waits for Ready. It then requires `smoke-duration` without a restart and stops the deployment, with a post step that stops it on cancel.
- Optional `promote-version`: points an existing version at the new image after everything passed.
- Job summary, GitHub Deployment record, outputs for the version and the smoke-test deployment.
- Only `*.edgegap.com` API hosts unless `allow-custom-api-url` is set.
