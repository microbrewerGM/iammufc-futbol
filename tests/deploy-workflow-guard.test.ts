import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import { readFileSync, readdirSync } from "node:fs";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import { join } from "node:path";

type WorkflowJob = { name: string; source: string };

function parseJobs(source: string): WorkflowJob[] {
  const lines = source.split(/\r?\n/);
  const jobsStart = lines.findIndex((line) => line === "jobs:");
  expect(jobsStart).toBeGreaterThanOrEqual(0);

  const jobs: WorkflowJob[] = [];
  for (let index = jobsStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) break;
    const match = line.match(/^  ([a-z][a-z0-9-]*):\s*$/);
    if (!match) continue;
    const jobLines: string[] = [];
    for (let end = index + 1; end < lines.length; end += 1) {
      const jobLine = lines[end];
      if (jobLine === undefined || /^  [a-z][a-z0-9-]*:\s*$/.test(jobLine)) break;
      jobLines.push(jobLine);
    }
    jobs.push({ name: match[1]!, source: jobLines.join("\n") });
  }
  return jobs;
}

const approvedConditions = new Set([
  "github.ref == 'refs/heads/main' && github.event_name != 'repository_dispatch'",
  "github.event_name == 'repository_dispatch' && github.event.action == 'p13-private-seed-ready' && github.ref == 'refs/heads/main'",
  "github.ref == 'refs/heads/main'",
]);

function normalizeCondition(condition: string): string {
  return condition.replace(/\s+/g, " ").trim();
}

function findSecretJobs(source: string): WorkflowJob[] {
  return parseJobs(source).filter((job) => /\$\{\{\s*secrets\.(?:CF_|CLOUDFLARE)/i.test(job.source));
}

function assertApprovedSecretJobConditions(workflows: Array<{ path: string; source: string }>): string[] {
  const found: string[] = [];
  for (const workflow of workflows) {
    for (const job of findSecretJobs(workflow.source)) {
      found.push(`${workflow.path}:${job.name}`);
      const condition = job.source.match(/^    if:\s*(.+)$/m)?.[1] ?? "";
      expect(
        approvedConditions.has(normalizeCondition(condition)),
        `${workflow.path}:${job.name} has unapproved secret-job condition: ${condition}`,
      ).toBe(true);
    }
  }
  return found.sort();
}

function readWorkflowSources(): Array<{ path: string; source: string }> {
  return readdirSync(".github/workflows")
    .filter((file: string) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort()
    .map((file: string) => {
      const path = join(".github/workflows", file);
      return { path, source: readFileSync(path, "utf8") };
    });
}

describe("deploy workflow secret job guards", () => {
  it("checks every Cloudflare-secret job in every workflow against approved conditions", () => {
    const secretJobs = assertApprovedSecretJobConditions(readWorkflowSources());
    expect(secretJobs).toEqual([
      ".github/workflows/access-smoke.yml:smoke",
      ".github/workflows/deploy.yml:consume-private-seed",
      ".github/workflows/deploy.yml:deploy-dev",
      ".github/workflows/gauntlet-capture.yml:capture",
    ]);
  });

  it("rejects an always() bypass even when the main ref condition is present", () => {
    const mutated = `name: Deploy\njobs:\n  deploy-dev:\n    if: always() || github.ref == 'refs/heads/main'\n    steps:\n      - run: echo safe\n      - env:\n          CF_TOKEN: \${{ secrets.CF_TOKEN_DEV }}\n`;
    expect(() => assertApprovedSecretJobConditions([{ path: "mutated.yml", source: mutated }])).toThrow();
  });
});
