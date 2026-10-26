// The job summary on the workflow run page, built from what the run recorded.

function cell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

// A fence longer than any backtick run in the text, so server output can't close it.
function fenced(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

function ports(map) {
  const entries = Object.entries(map ?? {});
  if (!entries.length) return "none";
  return entries.map(([name, p]) => `${name} ${p.internal}→${p.external}/${p.protocol}`).join(", ");
}

export function renderSummary(report, error) {
  const lines = [`### Edgegap deploy: ${error ? "failed" : "passed"}`, ""];
  lines.push(`Application \`${report.application}\`, image tag \`${report.tag}\``, "");
  if (report.baseVersion) lines.push(`- Settings copied from version \`${report.baseVersion}\``);
  if (report.version) {
    lines.push(`- Version \`${report.version.name}\` ${report.version.created ? "created" : "already existed"}: \`${report.image}\``);
  }
  const smoke = report.smoke;
  if (smoke) {
    lines.push(`- Smoke test (deployment \`${smoke.requestId}\`): **${smoke.passed ? "passed" : "failed"}**`);
    if (smoke.fqdn) {
      lines.push(
        `  - Ready after ${Math.round(smoke.readyAfterMs / 1000)}s in ${cell(smoke.location || "an unknown location")} on \`${smoke.fqdn}\``,
        `  - Ports: ${cell(ports(smoke.ports))}`,
      );
    }
  }
  if (report.promoted) lines.push(`- Promoted: version \`${report.promoted}\` now runs this image`);
  if (error) lines.push("", `> ${cell(error.message)}`);
  if (smoke?.logTail?.length) {
    lines.push("", "<details><summary>Last container log lines</summary>", "", fenced(smoke.logTail.join("\n")), "", "</details>");
  }
  return `${lines.join("\n")}\n`;
}
