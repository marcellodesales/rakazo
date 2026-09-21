import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: {
    configMapKeyRef?: { name: string; key: string };
    secretKeyRef?: { name: string; key: string };
  };
}

interface EnvFromSource {
  configMapRef?: { name: string; optional?: boolean };
  secretRef?: { name: string; optional?: boolean };
}

interface Container {
  name: string;
  image?: string;
  env?: EnvVar[];
  envFrom?: EnvFromSource[];
  volumeMounts?: Array<{ name: string; mountPath: string }>;
}

interface PodSpec {
  containers: Container[];
  volumes?: Array<{ name: string; persistentVolumeClaim?: { claimName: string } }>;
}

interface DeploymentSpec {
  template?: { spec?: PodSpec };
}

interface StatefulSetSpec {
  template?: { spec?: PodSpec };
  volumeClaimTemplates?: Array<{ metadata?: { name?: string }; spec?: { accessModes?: string[] } }>;
}

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const cicdCompose = parse(
  readFileSync(path.resolve(repoRoot, "infra/compose/docker-compose.cicd.yml"), "utf8"),
) as { services: Record<string, { image?: string }> };

function readYaml<T>(rel: string): T {
  return parse(readFileSync(path.resolve(repoRoot, rel), "utf8")) as T;
}

function envMap(container: Container | undefined) {
  return new Map((container?.env ?? []).map((entry) => [entry.name, entry]));
}

describe("the Kubernetes Kustomize deployment", () => {
  const base = readYaml<{ resources?: string[] }>("infra/k8s/base/kustomization.yaml");
  const overlay = readYaml<{
    namespace?: string;
    resources?: string[];
    patches?: Array<{ target?: { kind?: string; name?: string }; patch?: string }>;
  }>("infra/k8s/overlays/az-eastus-prdt-prd-prd/kustomization.yaml");
  const config = readYaml<{ data?: Record<string, string> }>("infra/k8s/base/configmap.yaml");
  const sharedData = readYaml<{ spec?: { accessModes?: string[] } }>(
    "infra/k8s/base/shared-data-pvc.yaml",
  );
  const api = readYaml<{ spec?: DeploymentSpec }>("infra/k8s/base/api-deployment.yaml");
  const worker = readYaml<{ spec?: DeploymentSpec }>("infra/k8s/base/worker-deployment.yaml");
  const web = readYaml<{ spec?: DeploymentSpec }>("infra/k8s/base/web-deployment.yaml");
  const postgres = readYaml<{ spec?: StatefulSetSpec }>("infra/k8s/base/postgres-statefulset.yaml");
  const gateway = readYaml<{
    spec?: { selector?: Record<string, string>; servers?: Array<Record<string, unknown>> };
  }>("infra/k8s/overlays/az-eastus-prdt-prd-prd/istio-gateway.yaml");
  const virtualService = readYaml<{
    spec?: {
      hosts?: string[];
      gateways?: string[];
      http?: Array<{
        name?: string;
        match?: Array<{ uri?: { exact?: string; prefix?: string } }>;
        route?: Array<{ destination?: { host?: string; port?: { number?: number } } }>;
      }>;
    };
  }>("infra/k8s/overlays/az-eastus-prdt-prd-prd/istio-virtual-service.yaml");
  const namespace = readYaml<{ metadata?: { name?: string; labels?: Record<string, string> } }>(
    "infra/k8s/overlays/az-eastus-prdt-prd-prd/namespace.yaml",
  );

  it("keeps the base focused on postgres, api, worker, and web", () => {
    expect(base.resources).toEqual([
      "configmap.yaml",
      "shared-data-pvc.yaml",
      "postgres-service.yaml",
      "postgres-statefulset.yaml",
      "api-service.yaml",
      "api-deployment.yaml",
      "worker-deployment.yaml",
      "web-service.yaml",
      "web-deployment.yaml",
    ]);
  });

  it("defaults the stack to a minimal hosted-provider-free runtime", () => {
    expect(config.data).toMatchObject({
      NODE_ENV: "production",
      SANDBOX_PROVIDER: "none",
      CLOUD_AGENT_PROVIDER: "none",
      WAKEUP_DRIVER: "graphile",
      AGENT_RUNTIME: "pi",
      RAKAZO_HOST: "app.example.com",
      API_PROXY_TARGET: "http://api:3100",
    });
  });

  it("shares RWX app data between api and worker and keeps postgres on its own claim", () => {
    expect(sharedData.spec?.accessModes).toEqual(["ReadWriteMany"]);
    const apiPod = api.spec?.template?.spec;
    const workerPod = worker.spec?.template?.spec;
    expect(apiPod?.volumes).toContainEqual({
      name: "shared-data",
      persistentVolumeClaim: { claimName: "rakazo-shared-data" },
    });
    expect(workerPod?.volumes).toContainEqual({
      name: "shared-data",
      persistentVolumeClaim: { claimName: "rakazo-shared-data" },
    });
    expect(postgres.spec?.volumeClaimTemplates?.[0]?.metadata?.name).toBe("postgres-data");
    expect(postgres.spec?.volumeClaimTemplates?.[0]?.spec?.accessModes).toEqual(["ReadWriteOnce"]);
  });

  it("wires secrets and optional provider config to api and worker without sending them to web", () => {
    const apiContainer = api.spec?.template?.spec?.containers[0];
    const workerContainer = worker.spec?.template?.spec?.containers[0];
    const webContainer = web.spec?.template?.spec?.containers[0];
    const apiEnv = envMap(apiContainer);
    const workerEnv = envMap(workerContainer);
    const webEnv = envMap(webContainer);

    expect(apiContainer?.envFrom).toEqual([
      { configMapRef: { name: "rakazo-config" } },
      { configMapRef: { name: "rakazo-optional-egress-proxy", optional: true } },
      { secretRef: { name: "rakazo-optional-providers", optional: true } },
    ]);
    expect(workerContainer?.envFrom).toEqual(apiContainer?.envFrom);

    expect(apiEnv.get("DATABASE_URL")?.valueFrom?.secretKeyRef).toEqual({
      name: "rakazo-database",
      key: "DATABASE_URL",
    });
    expect(apiEnv.get("BETTER_AUTH_SECRET")?.valueFrom?.secretKeyRef).toEqual({
      name: "rakazo-runtime-secrets",
      key: "BETTER_AUTH_SECRET",
    });
    expect(apiEnv.get("ENCRYPTION_KEY")?.valueFrom?.secretKeyRef).toEqual({
      name: "rakazo-runtime-secrets",
      key: "ENCRYPTION_KEY",
    });
    expect(apiEnv.get("SCREEN_PROXY_SECRET")?.valueFrom?.secretKeyRef).toEqual({
      name: "rakazo-runtime-secrets",
      key: "SCREEN_PROXY_SECRET",
    });
    expect(apiEnv.has("RAKAZO_UPDATER_URL")).toBe(false);

    expect(workerEnv.get("DATABASE_URL")?.valueFrom?.secretKeyRef).toEqual({
      name: "rakazo-database",
      key: "DATABASE_URL",
    });
    expect(workerEnv.get("ENCRYPTION_KEY")?.valueFrom?.secretKeyRef).toEqual({
      name: "rakazo-runtime-secrets",
      key: "ENCRYPTION_KEY",
    });
    expect(workerEnv.has("BETTER_AUTH_SECRET")).toBe(false);
    expect(workerEnv.has("SCREEN_PROXY_SECRET")).toBe(false);

    expect(webContainer?.envFrom).toBeUndefined();
    expect(webEnv.get("SCREEN_PROXY_SECRET")?.valueFrom?.secretKeyRef).toEqual({
      name: "rakazo-runtime-secrets",
      key: "SCREEN_PROXY_SECRET",
    });
    expect(webEnv.has("DATABASE_URL")).toBe(false);
    expect(webEnv.has("BETTER_AUTH_SECRET")).toBe(false);
    expect(webEnv.has("ENCRYPTION_KEY")).toBe(false);
  });

  it("matches Kustomize deployment images to the Vionix compose targets", () => {
    expect(api.spec?.template?.spec?.containers[0]?.image).toBe(cicdCompose.services.api?.image);
    expect(worker.spec?.template?.spec?.containers[0]?.image).toBe(
      cicdCompose.services.worker?.image,
    );
    expect(web.spec?.template?.spec?.containers[0]?.image).toBe(cicdCompose.services.web?.image);
    expect(cicdCompose.services.updater?.image).toBe("ghcr.io/marcellodesales/rakazo/updater:edge");
  });

  it("exposes api routes first and keeps the web fallback (including /novnc) on the web service", () => {
    expect(gateway.spec?.selector).toEqual({ istio: "ingressgateway" });
    expect(virtualService.spec?.hosts).toEqual(["app.example.com"]);
    expect(virtualService.spec?.gateways).toEqual(["rakazo-ingress"]);
    expect(virtualService.spec?.http?.map((route) => route.name)).toEqual([
      "api-health",
      "api-rest",
      "api-rpc",
      "web",
    ]);
    expect(virtualService.spec?.http?.[0]?.match?.[0]?.uri?.exact).toBe("/health");
    expect(virtualService.spec?.http?.[1]?.match?.[0]?.uri?.prefix).toBe("/api");
    expect(virtualService.spec?.http?.[2]?.match?.[0]?.uri?.prefix).toBe("/rpc");
    expect(virtualService.spec?.http?.[0]?.route?.[0]?.destination).toEqual({
      host: "api",
      port: { number: 3100 },
    });
    expect(virtualService.spec?.http?.[3]?.route?.[0]?.destination).toEqual({
      host: "web",
      port: { number: 5173 },
    });
  });

  it("uses an Istio-enabled Azure example namespace and patches the shared RWX storage class", () => {
    expect(overlay.namespace).toBe("rakazo-az-eastus-prdt-prd-prd");
    expect(overlay.resources).toEqual([
      "../../base",
      "namespace.yaml",
      "istio-gateway.yaml",
      "istio-virtual-service.yaml",
    ]);
    expect(namespace.metadata).toEqual({
      name: "rakazo-az-eastus-prdt-prd-prd",
      labels: {
        "istio-injection": "enabled",
        "app.kubernetes.io/part-of": "rakazo",
      },
    });
    expect(overlay.patches).toEqual([
      {
        target: { kind: "PersistentVolumeClaim", name: "rakazo-shared-data" },
        patch: expect.stringContaining("azurefile-csi"),
      },
    ]);
  });
});
