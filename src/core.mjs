// The few @actions/core functions this action needs, so it ships with no dependencies.
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export function getInput(name, env = process.env) {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

function escape(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function writeFileCommand(file, name, value) {
  const delimiter = `edgegap_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export function setOutput(name, value, env = process.env) {
  if (env.GITHUB_OUTPUT) writeFileCommand(env.GITHUB_OUTPUT, name, value);
}

export function saveState(name, value, env = process.env) {
  if (env.GITHUB_STATE) writeFileCommand(env.GITHUB_STATE, name, value);
}

export function getState(name, env = process.env) {
  return env[`STATE_${name}`] ?? "";
}

export function appendSummary(markdown, env = process.env) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
}

export function setSecret(value) {
  if (value) process.stdout.write(`::add-mask::${escape(value)}\n`);
}

export function info(message) {
  process.stdout.write(`${message}\n`);
}

export function warning(message) {
  process.stdout.write(`::warning::${escape(message)}\n`);
}

export function error(message) {
  process.stdout.write(`::error::${escape(message)}\n`);
}

export function startGroup(title) {
  process.stdout.write(`::group::${escape(title)}\n`);
}

export function endGroup() {
  process.stdout.write("::endgroup::\n");
}

// Prints text that came from the game server without letting it run workflow commands.
export function infoUntrusted(text) {
  const token = randomUUID();
  process.stdout.write(`::stop-commands::${token}\n${text}\n::${token}::\n`);
}
