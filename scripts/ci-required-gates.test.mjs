import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const workflow = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const gates = [
  "rust-lint",
  "unit-tests",
  "windows-rust",
  "desktop",
  "desktop-build-macos",
  "desktop-e2e-relay",
  "desktop-e2e-integration",
  "backend-integration",
  "postgres-tests",
  "relay-e2e",
  "web",
  "mobile",
  "security",
];
for (const gate of gates) {
  const body = workflow.match(
    new RegExp(`^  ${gate}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, "m"),
  )[1];
  const condition = body.match(/^ {4}if: (.+)$/m)[1];
  const command = body.match(/^ {8}run: (.+)$/m)[1];
  function shouldRun(
    selection,
    selected = false,
    event = "pull_request",
    artifacts = "skipped",
  ) {
    // These workflow conditions use only booleans, string equality and grouping.
    // Evaluate the actual expression after substituting its GitHub context values.
    assert.match(
      condition,
      /\balways\(\)/,
      "Required wrapper must override GitHub implicit success()",
    );
    const expression = condition
      .replace(/always\(\)/g, "true")
      .replace(
        /github\.event_name|needs\.[\w-]+\.(?:result|outputs\.[\w-]+)/g,
        (key) => {
          if (key === "github.event_name") return JSON.stringify(event);
          if (key === "needs.changes.result") return JSON.stringify(selection);
          if (key === "needs.relay-artifacts-domain.result")
            return JSON.stringify(artifacts);
          assert.match(key, /^needs\.changes\.outputs\./);
          return JSON.stringify(selected ? "true" : "false");
        },
      );
    return runInNewContext(expression, {}, { timeout: 100 });
  }
  function check(selection, result) {
    assert.match(body, /SELECTION_RESULT: \$\{\{ needs.changes.result \}\}/);
    assert.match(body, /RESULT: \$\{\{ needs\.[\w-]+\.outputs\.[\w_]+ \}\}/);
    return spawnSync("bash", ["-c", command], {
      env: { ...process.env, SELECTION_RESULT: selection, RESULT: result },
      timeout: 1000,
    }).status;
  }
  test(`${gate}: selector failures run and fail the required check`, () => {
    for (const selection of ["failure", "cancelled", "skipped"]) {
      for (const artifacts of ["skipped", "success"]) {
        assert.equal(
          shouldRun(selection, false, "pull_request", artifacts),
          true,
        );
      }
      for (const result of ["", "skipped", "success"]) {
        assert.notEqual(check(selection, result), 0);
      }
    }
  });
  test(`${gate}: successful selection preserves path gating and suite results`, () => {
    assert.equal(shouldRun("success"), false);
    assert.equal(shouldRun("success", true, "pull_request", "success"), true);
    assert.equal(shouldRun("success", false, "push", "success"), true);
    assert.equal(check("success", "success"), 0);
    for (const result of ["", "failure", "cancelled", "skipped"]) {
      assert.notEqual(check("success", result), 0);
    }
  });
}

// The Desktop gate re-derives which of its needs were selected. Each job's
// `if:` must match the gate's expression, or a selected job could be skipped
// (or an unselected one run) with the gate's expectation out of step.
const desktopWorkflow = readFileSync(
  new URL("../.github/workflows/_ci-desktop.yml", import.meta.url),
  "utf8",
);
function desktopJob(name) {
  return desktopWorkflow.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, "m"),
  )[1];
}
const desktopGate = desktopJob("desktop");
const gateSelection = (key) =>
  desktopGate.match(new RegExp(`^ {10}${key}: \\$\\{\\{ (.+) \\}\\}$`, "m"))[1];
const desktopJobs = {
  "desktop-js": "JS_SELECTED",
  "desktop-tauri": "RUST_SELECTED",
  "desktop-smoke-e2e": "FRONTEND_SELECTED",
  "desktop-windows-build": "FRONTEND_SELECTED",
};
function evaluate(expression, event, inputs) {
  const substituted = expression.replace(
    /github\.event_name|inputs\.([\w_]+)/g,
    (key, input) =>
      input === undefined
        ? JSON.stringify(event)
        : String(inputs[input] === true),
  );
  return runInNewContext(substituted, {}, { timeout: 100 });
}
test("desktop gate selection matches each job's if: condition", () => {
  for (const [job, key] of Object.entries(desktopJobs)) {
    const condition = desktopJob(job).match(/^ {4}if: (.+)$/m)[1];
    assert.equal(condition, gateSelection(key), `${job} vs ${key}`);
  }
});
test("desktop gate selects jobs per changed-path input", () => {
  const selected = (event, inputs) =>
    Object.keys(desktopJobs)
      .filter((job) => evaluate(gateSelection(desktopJobs[job]), event, inputs))
      .sort();
  // Rust-only: Desktop JS still runs, because node:test pins relay/DB constants.
  assert.deepEqual(selected("pull_request", { rust: true }), [
    "desktop-js",
    "desktop-tauri",
  ]);
  assert.deepEqual(selected("pull_request", { desktop: true }), [
    "desktop-js",
    "desktop-smoke-e2e",
    "desktop-windows-build",
  ]);
  assert.deepEqual(
    selected("pull_request", { desktop: true, desktop_rust: true }),
    Object.keys(desktopJobs).sort(),
  );
  assert.deepEqual(selected("push", {}), Object.keys(desktopJobs).sort());
  assert.deepEqual(selected("pull_request", {}), []);
});

const securityWorkflow = readFileSync(
  new URL("../.github/workflows/_ci-security.yml", import.meta.url),
  "utf8",
);
const jobBody = (source, name) =>
  source.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, "m"),
  )[1];
test("security checks select both root-only and desktop-only Rust changes", () => {
  const domain = jobBody(workflow, "security-domain");
  const wrapper = jobBody(workflow, "security");
  const worker = jobBody(securityWorkflow, "security");
  const forwarded = domain.match(/^ {6}rust: \$\{\{ (.+) \}\}$/m)[1];
  for (const event of ["pull_request", "push"]) {
    for (const root of [false, true]) {
      for (const desktop of [false, true]) {
        const evalSelection = (expression) =>
          runInNewContext(
            expression
              .replace(/always\(\)/g, "true")
              .replace(/github\.event_name/g, JSON.stringify(event))
              .replace(/needs\.changes\.result/g, '"success"')
              .replace(
                /needs\.changes\.outputs\.desktop-rust/g,
                JSON.stringify(String(desktop)),
              )
              .replace(
                /needs\.changes\.outputs\.rust/g,
                JSON.stringify(String(root)),
              ),
            {},
            { timeout: 100 },
          );
        const expected = event === "push" || root || desktop;
        for (const body of [domain, wrapper]) {
          assert.equal(
            evalSelection(body.match(/^ {4}if: (.+)$/m)[1]),
            expected,
          );
        }
        assert.equal(
          evaluate(worker.match(/^ {4}if: (.+)$/m)[1], event, {
            rust: evalSelection(forwarded),
          }),
          expected,
        );
      }
    }
  }
});
test("security matrix checks both manifests with the shared dependency policy", () => {
  const manifests = securityWorkflow
    .match(/manifest: \[([^\]]+)\]/)?.[1]
    .split(",")
    .map((value) => value.trim());
  assert.deepEqual(manifests, ["Cargo.toml", "desktop/src-tauri/Cargo.toml"]);
  const command = securityWorkflow.match(/run: (cargo-deny .+)$/m)[1];
  for (const manifest of manifests) {
    const expanded = command
      .replaceAll("${{ matrix.manifest }}", manifest)
      .replaceAll("${{ github.workspace }}", "/fixture");
    const result = spawnSync(
      "bash",
      ["-c", `cargo-deny() { printf '%s\\n' "$@"; }; ${expanded}`],
      {
        encoding: "utf8",
        timeout: 1000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      "--manifest-path",
      manifest,
      "check",
      "--config",
      "/fixture/deny.toml",
    ]);
  }
});
