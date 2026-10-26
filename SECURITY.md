# Security

This action receives your Edgegap API token, and optionally your registry login and secret env vars.

- It sends them only to the Edgegap API host in `api-url` (`*.edgegap.com` unless you opt out) and never to GitHub, except that the GitHub token goes to the GitHub API for `github-deployment`.
- It masks them in the job log.
- It has no dependencies, so the code you pin is all the code that runs.

To report a vulnerability, use **Report a vulnerability** on this repository's **Security** tab. Please don't open a public issue for it. Problems with the Edgegap platform or API itself go to Edgegap directly.
