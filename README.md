# DDJ foundation

The engineering baseline: the repo, the CI, the tests, and the deploy path.

This exists so the team ships on a predictable cadence instead of rebuilding the
same scaffolding on every project.

## Quick start

```bash
pnpm install
pnpm dev:api          # http://127.0.0.1:3000
```

```bash
curl -s localhost:3000/version | jq
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm ci` | The whole pipeline: install, typecheck, lint, test, build |
| `pnpm test` | Test suite |
| `pnpm typecheck` | Typecheck every package |
| `pnpm lint` | Lint |
| `pnpm build` | Compile everything |
| `pnpm dev:api` | Run the API with reload on change |

## Documentation

- **[docs/release.md](docs/release.md)** — how a change gets from a branch to
  production, including rollback.
- **[docs/conventions.md](docs/conventions.md)** — how we write code here.

## What is running

| | Staging | Production |
| --- | --- | --- |
| URL | http://127.0.0.1:3001 | http://127.0.0.1:3002 |
| Deploy | `./scripts/deploy.sh staging` | `./scripts/deploy.sh production` |

Both currently bind loopback only. See "Known gaps" in
[docs/release.md](docs/release.md) — public ingress is not yet provisioned.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness. Is the process up? Touches no dependency. |
| `GET /health/ready` | Readiness. Should it receive traffic? `503` when degraded. |
| `GET /version` | Which commit is this? Validated against the shared contract. |

## Layout

```
apps/api/         the deployable HTTP service
packages/shared/  contracts the API and its consumers agree on
scripts/          build, CI, deploy, rollback
deploy/           systemd units
docs/             release process and conventions
```

## CI

CI runs on every push via [.github/workflows/ci.yml](.github/workflows/ci.yml),
which calls [scripts/ci.sh](scripts/ci.sh). The pipeline lives in the script so
`pnpm ci` reproduces it exactly on a laptop.

The repository has no git remote yet, so CI has not run on a hosted runner. The
pipeline itself passes locally.
