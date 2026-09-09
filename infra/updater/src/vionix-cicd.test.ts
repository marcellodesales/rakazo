import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface ComposeService {
  image?: string;
  build?: { context?: string; dockerfile?: string; args?: Record<string, string> };
  env_file?: unknown;
  environment?: Record<string, unknown>;
  profiles?: string[];
}

interface WorkflowJob {
  uses?: string;
  permissions?: Record<string, string>;
  with?: Record<string, string>;
}

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const composeFile = path.resolve(repoRoot, "infra/compose/docker-compose.cicd.yml");
const compose = parse(readFileSync(composeFile, "utf8")) as {
  services: Record<string, ComposeService>;
};

const workflowFiles = {
  api: path.resolve(repoRoot, ".github/workflows/docker-multiarch-cicd-api.yaml"),
  worker: path.resolve(repoRoot, ".github/workflows/docker-multiarch-cicd-worker.yaml"),
  web: path.resolve(repoRoot, ".github/workflows/docker-multiarch-cicd-web.yaml"),
  updater: path.resolve(repoRoot, ".github/workflows/docker-multiarch-cicd-updater.yaml"),
} as const;

const expectedPermissions = {
  contents: "write",
  packages: "write",
  "id-token": "write",
  attestations: "write",
  "artifact-metadata": "write",
  "pull-requests": "write",
};

function loadWorkflow(file: string) {
  return parse(readFileSync(file, "utf8")) as {
    name?: string;
    on?: { pull_request?: { types?: string[] }; push?: { branches?: string[]; tags?: string[] } };
    jobs?: { "docker-multiarch"?: WorkflowJob };
  };
}

describe("the Vionix multi-arch callers", () => {
  it("defines one clean-checkout build target per service", () => {
    expect(Object.keys(compose.services).sort()).toEqual(["api", "updater", "web", "worker"]);
    for (const [service, config] of Object.entries(compose.services)) {
      expect(config.image).toBe(`ghcr.io/marcellodesales/rakazo/${service}:edge`);
      expect(config.build?.context).toBe("../..");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Compose interpolation
      expect(config.build?.args?.GIT_SHA).toBe("${GITHUB_SHA:-}");
      expect(config.env_file).toBeUndefined();
      expect(config.environment).toBeUndefined();
      expect(config.profiles).toBeUndefined();
    }
    expect(compose.services.api?.build?.dockerfile).toBe("infra/compose/Dockerfile");
    expect(compose.services.worker?.build?.dockerfile).toBe("infra/compose/Dockerfile");
    expect(compose.services.web?.build?.dockerfile).toBe("infra/compose/Dockerfile");
    expect(compose.services.updater?.build?.dockerfile).toBe("infra/updater/Dockerfile");
  });

  it.each(Object.entries(workflowFiles))(
    "wires the %s caller to the shared Vionix workflow",
    (service, file) => {
      const workflow = loadWorkflow(file);
      expect(workflow.name).toBe(`docker-multiarch-cicd-${service}`);
      expect(workflow.on?.pull_request?.types).toEqual([
        "opened",
        "synchronize",
        "reopened",
        "closed",
      ]);
      expect(workflow.on?.push?.branches).toEqual(["main"]);
      expect(workflow.on?.push?.tags).toEqual(["v*"]);
      const job = workflow.jobs?.["docker-multiarch"];
      expect(job?.uses).toBe(
        "vionix-proj/github-platform/.github/workflows/docker-multiarch-cicd.yaml@main",
      );
      expect(job?.permissions).toEqual(expectedPermissions);
      expect(job?.with).toEqual({
        registry: "ghcr.io",
        platforms: "linux/amd64,linux/arm64",
        "docker-compose-file-name": "infra/compose/docker-compose.cicd.yml",
        "docker-compose-target-service": service,
        "push-attestations": "false",
      });
    },
  );

  it("renders from a clean checkout and exposes every buildx bake target", () => {
    execFileSync("docker", ["compose", "-f", composeFile, "config"], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? "" },
      stdio: "pipe",
    });

    for (const service of Object.keys(compose.services)) {
      const bake = JSON.parse(
        execFileSync("docker", ["buildx", "bake", "--print", "--file", composeFile, service], {
          cwd: repoRoot,
          env: { PATH: process.env.PATH ?? "" },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ) as {
        target?: Record<
          string,
          { context?: string; dockerfile?: string; tags?: string[]; args?: Record<string, string> }
        >;
      };
      const target = bake.target?.[service];
      expect(target?.context).toBe("../..");
      expect(target?.tags).toEqual([`ghcr.io/marcellodesales/rakazo/${service}:edge`]);
      expect(target?.args?.GIT_SHA).toBe("");
    }
  });
});
