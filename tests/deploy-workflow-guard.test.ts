import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import { readFileSync } from "node:fs";

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

describe("deploy workflow secret job guards", () => {
  it("restricts every job that references a secret to main", () => {
    const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");
    const secretJobs = parseJobs(workflow).filter((job) => /\$\{\{\s*secrets\./.test(job.source));

    expect(secretJobs.length).toBeGreaterThan(0);
    for (const job of secretJobs) {
      const condition = job.source.match(/^    if:\s*(.+)$/m)?.[1] ?? "";
      expect(condition, `${job.name} must require refs/heads/main`).toContain("github.ref == 'refs/heads/main'");
    }
  });
});
