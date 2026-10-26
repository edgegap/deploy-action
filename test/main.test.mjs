import { test } from "node:test";
import assert from "node:assert/strict";
import { readInputs } from "../src/main.mjs";
import { renderSummary } from "../src/summary.mjs";

const env = (inputs) => Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v]));

test("readInputs defaults and validation", () => {
  const inputs = readInputs(env({ "api-token": "t", application: "game", tag: "sha-1", "smoke-test": "true" }));
  assert.equal(inputs.origin, "https://api.edgegap.com");
  assert.equal(inputs.verifyImage, true);
  assert.equal(inputs.smokeDurationMs, 60_000);
  assert.equal(inputs.startupTimeoutMs, 300_000);
  assert.equal(inputs.near.user_type, "geo_coordinates");
  assert.throws(() => readInputs(env({ "api-token": "t", application: "game" })), /tag is required/);
  assert.throws(() => readInputs(env({ "api-token": "t", application: "g", tag: "x", "show-logs": "sometimes" })), /show-logs/);
  assert.throws(() => readInputs(env({ "api-token": "t", application: "g", tag: "x", "registry-username": "u" })), /together/);
  assert.throws(() => readInputs(env({ "api-token": "t", application: "g", tag: "x", "api-url": "https://evil.example" })), /edgegap.com host/);
});

test("summary", () => {
  const md = renderSummary(
    {
      application: "game",
      tag: "sha-1",
      baseVersion: "old",
      image: "registry.edgegap.com/p/game:sha-1",
      version: { name: "20261026-1504", created: true },
      smoke: {
        requestId: "r1",
        passed: false,
        fqdn: "r1.pr.edgegap.net",
        readyAfterMs: 12_400,
        location: "Newark | US",
        ports: { gameport: { internal: 7777, external: 31000, protocol: "UDP" } },
        logTail: ["```", "boom"],
      },
    },
    new Error("it broke"),
  );
  assert.match(md, /### Edgegap deploy: failed/);
  assert.match(md, /Version `20261026-1504` created/);
  assert.match(md, /Ready after 12s in Newark \\\| US/);
  assert.match(md, /gameport 7777→31000\/UDP/);
  assert.match(md, /> it broke/);
  assert.match(md, /````text\n```\nboom\n````/);
});
