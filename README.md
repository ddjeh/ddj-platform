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
curl -s -X POST localhost:3000/notes -H 'content-type: application/json' \
  -d '{"body":"hello"}' | jq
curl -s localhost:3000/notes | jq
```

`development` and `test` do not require a token, so the commands above work on a
laptop with no `.env`. Staging and production do — see "Notes API" below.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm run ci` | The whole pipeline: install, typecheck, lint, test, build |
| `pnpm test` | Test suite |
| `pnpm typecheck` | Typecheck every package |
| `pnpm lint` | Lint |
| `pnpm build` | Compile everything |
| `pnpm dev:api` | Run the API with reload on change |

Use `pnpm run ci`, not `pnpm ci` — `pnpm ci` is a pnpm built-in that errors with
`ERR_PNPM_CI_NOT_IMPLEMENTED` and never reaches our script.

## Documentation

- **[docs/release.md](docs/release.md)** — how a change gets from a branch to
  production, including rollback.
- **[docs/conventions.md](docs/conventions.md)** — how we write code here.
- **[docs/github.md](docs/github.md)** — the token, the remote, and what is
  still needed to make production reachable.

## What is running

| | Staging | Production |
| --- | --- | --- |
| URL | http://127.0.0.1:3001 | http://127.0.0.1:3002 |
| Deploy | `./scripts/deploy.sh staging` | `./scripts/deploy.sh production` |

Both currently bind loopback only. See "Known gaps" in
[docs/release.md](docs/release.md) — public ingress is not yet provisioned, and
the board has deferred that decision.

**Deploys are manual and stay manual.** Nothing deploys on push; a person runs
`./scripts/deploy.sh <environment>`. CI fails if a deploy step is ever wired into
a workflow — see "Deploys are manual" in [docs/release.md](docs/release.md).

## Endpoints

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | no | Liveness. Is the process up? Touches no dependency. |
| `GET /health/ready` | no | Readiness. Should it receive traffic? `503` when degraded. |
| `GET /version` | no | Which commit is this? Validated against the shared contract. |
| `GET /notes` | yes | Every note, newest first. |
| `POST /notes` | yes | Write a note. `201` with the stored note. |

Errors are uniform across every endpoint:

```json
{ "error": { "code": "validation_failed", "message": "CreateNoteRequest.body must not be empty or whitespace" } }
```

`code` is one of `unauthorized`, `validation_failed`, `not_found`, `internal`.
Branch on the code, not the message; the message is prose and may be reworded.

## Notes API

The authenticated routes need a bearer token. Getting one onto your machine:

```bash
# The token is generated once per environment and never leaves the host.
sudo cat /srv/ddj/staging/shared/.env | grep DDJ_API_TOKEN
```

```bash
TOKEN=$(sudo sed -n 's/^DDJ_API_TOKEN=//p' /srv/ddj/staging/shared/.env)
curl -s localhost:3001/notes -H "Authorization: Bearer $TOKEN" | jq
curl -s -X POST localhost:3001/notes \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"body":"from staging"}' | jq
```

Staging and production have **different** tokens. A token is scoped to the
environment whose `.env` holds it; there is no shared credential and no
cross-environment access. Each environment also has its own database, owned by
its own PostgreSQL role.

`DDJ_API_TOKEN` is optional only in `development` and `test`. In staging or
production a missing token is a refusal to start, not a service that accepts
every request.

## Layout

```
apps/api/              the deployable HTTP service
apps/api/migrations/   forward-only, numbered SQL migrations
packages/shared/       contracts the API and its consumers agree on
scripts/               build, CI, deploy, migrate, rollback
deploy/                systemd units
docs/                  release process, conventions, GitHub setup
```

## CI

CI runs on every push via [.github/workflows/ci.yml](.github/workflows/ci.yml),
which calls [scripts/ci.sh](scripts/ci.sh). The pipeline lives in the script so
`pnpm run ci` reproduces it exactly on a laptop.

The repository is at [ddjeh/ddj-platform](https://github.com/ddjeh/ddj-platform)
and the pipeline is green on a hosted runner: [run
`35977284936`](https://github.com/ddjeh/ddj-platform/actions/runs/35977284936),
`conclusion: success` on `41614ce`. The job uploads a build artifact, so the
commit is checkable against the tree.

```bash
./scripts/github-bootstrap.sh --owner ddjeh --name ddj-platform
```

pushes `main` and prints the URL of the Actions run; it is idempotent, so running
it again on a pushed repository is harmless.
[docs/github.md](docs/github.md) has the token scopes and the rest.
