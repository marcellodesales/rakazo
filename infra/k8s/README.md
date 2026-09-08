# Kubernetes deployment

This Kustomize stack replaces the production Compose ingress path with Istio while keeping the same core services: PostgreSQL, API, worker, and web. The updater and Caddy are intentionally omitted: Kubernetes image promotion and Deployment rollouts replace the Docker-socket updater, and Istio replaces the edge proxy.

## Layout

- `base/`: PostgreSQL `StatefulSet`, shared-data `PersistentVolumeClaim`, and `Deployment` + `Service` resources for `api`, `worker`, and `web`
- `overlays/az-eastus-prdt-prd-prd/`: Azure-oriented example overlay with namespace, Istio `Gateway`, and `VirtualService`
- `infra/compose/docker-compose.cicd.yml`: clean-checkout build descriptor for the four image workflows (`api`, `worker`, `web`, `updater`)

The `api`, `worker`, and `web` images use distinct GHCR repositories even though they currently build from the same monorepo Dockerfile. That keeps each rollout target stable and prevents parallel CI jobs from overwriting one shared tag.

## Prerequisites

- A Kubernetes cluster with a default `ReadWriteOnce` storage class for PostgreSQL
- An RWX-capable storage class for `rakazo-shared-data`; the Azure example overlay pins `azurefile-csi`
- Istio installed separately, with an ingress gateway labeled `istio: ingressgateway`
- A DNS record for `app.example.com` (replace it before applying)
- A TLS secret named `rakazo-app-example-com-tls` available to the ingress gateway workload namespace

## Secrets

Create secrets from local, untracked values before applying. Encode the database password inside the URL if it contains reserved characters.

```bash
kubectl -n rakazo-az-eastus-prdt-prd-prd create secret generic rakazo-database \
  --from-literal=POSTGRES_PASSWORD='<database-password>' \
  --from-literal=DATABASE_URL='postgres://rakazo:<url-encoded-password>@postgres:5432/rakazo' \
  --from-literal=REALTIME_DATABASE_URL='postgres://rakazo:<url-encoded-password>@postgres:5432/rakazo'

kubectl -n rakazo-az-eastus-prdt-prd-prd create secret generic rakazo-runtime-secrets \
  --from-literal=BETTER_AUTH_SECRET='<32+ char random string>' \
  --from-literal=ENCRYPTION_KEY='<64 random hex characters>' \
  --from-literal=SCREEN_PROXY_SECRET='<32+ char random string>'
```

Optional provider credentials and optional egress proxy values can be added later with:

- secret `rakazo-optional-providers`
- config map `rakazo-optional-egress-proxy`

The web deployment deliberately does not consume the database URL, auth secret, encryption key, or optional provider credentials.

## Image customization

The Azure overlay defaults to:

- `ghcr.io/marcellodesales/rakazo/api:edge`
- `ghcr.io/marcellodesales/rakazo/worker:edge`
- `ghcr.io/marcellodesales/rakazo/web:edge`

Promote a digest or release tag by editing the overlay images, for example:

```bash
kustomize edit set image ghcr.io/marcellodesales/rakazo/api=ghcr.io/marcellodesales/rakazo/api@sha256:<digest>
kustomize edit set image ghcr.io/marcellodesales/rakazo/worker=ghcr.io/marcellodesales/rakazo/worker@sha256:<digest>
kustomize edit set image ghcr.io/marcellodesales/rakazo/web=ghcr.io/marcellodesales/rakazo/web@sha256:<digest>
```

If the cluster cannot pull GHCR packages anonymously, add an `imagePullSecret` or make the packages readable to the cluster's identity. The reusable Vionix workflow lives outside this repository; access to `vionix-proj/github-platform` and package-write permission for this fork must be verified in GitHub before relying on those workflows for publishing.

## Apply and operate

Review rendered output first:

```bash
kubectl kustomize infra/k8s/base
kubectl kustomize infra/k8s/overlays/az-eastus-prdt-prd-prd
kubectl apply -k infra/k8s/overlays/az-eastus-prdt-prd-prd
```

The API deployment runs `prisma migrate deploy` before starting the server. If PostgreSQL is not ready yet, Kubernetes restarts the pod until the migration-and-start command succeeds, which avoids an Istio sidecar deadlock from network-dependent init containers or jobs. Keep conservative replica counts unless you also revisit migrations and the shared RWX volume assumptions.

Useful commands:

```bash
kubectl -n rakazo-az-eastus-prdt-prd-prd get pods,svc,pvc
kubectl -n rakazo-az-eastus-prdt-prd-prd logs deploy/api
kubectl -n rakazo-az-eastus-prdt-prd-prd logs deploy/worker
kubectl -n rakazo-az-eastus-prdt-prd-prd rollout status deploy/api
kubectl -n rakazo-az-eastus-prdt-prd-prd rollout undo deploy/api
```

PostgreSQL backups and restore procedures remain the operator's responsibility. For production HA or managed backups, replace the in-cluster database with an external PostgreSQL service and update `rakazo-database` accordingly.

## Workflows

The four `docker-multiarch-cicd-*.yml` workflows are thin callers around the shared Vionix reusable workflow and intentionally cover `api`, `worker`, `web`, and `updater` independently. They build from `infra/compose/docker-compose.cicd.yml`, which does not require runtime secrets, `.env`, or the updater profile to render from a clean checkout.
