import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WorkflowDefinition {
  name?: string;
  "run-name"?: string;
}

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const workflowsDir = path.resolve(repoRoot, ".github/workflows");

const workflowFiles = readdirSync(workflowsDir).filter((file) => /\.ya?ml$/u.test(file));

describe("workflow identity", () => {
  it("defines an emoji-prefixed name and run-name on every workflow", () => {
    for (const file of workflowFiles) {
      const workflow = parse(readFileSync(path.resolve(workflowsDir, file), "utf8")) as WorkflowDefinition;
      expect(workflow.name).toBeTypeOf("string");
      expect(workflow["run-name"]).toBeTypeOf("string");
      expect(workflow.name).toMatch(/^\p{Extended_Pictographic}/u);
      expect(workflow["run-name"]).toMatch(/^\p{Extended_Pictographic}/u);
    }
  });
});
