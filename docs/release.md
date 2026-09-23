# Release process

How a change gets from a branch to production. This describes the path that
exists and is exercised, not an aspiration.

## The short version

```
branch -> pull request -> CI green -> merge to main -> deploy staging
       -> verify -> deploy production -> health gate -> done
```

## 1. Branch

Branch from `main`. Name it for the change, not the ticket number:
`add-order-endpoint`, not `DDJ-42`.

```bash
git checkout main && git pull
git checkout -b add-order-endpoint
```

## 2. Make the change, and run CI locally first

```bash
pnpm ci
```

`pnpm ci` is the whole pipeline: install with a frozen lockfile, typecheck,
lint, test, build, and verify the build records its commit. GitHub Actions runs
the same script, so a local pass and a CI pass mean the same thing. Do not push
a change you have not run this on.

## 3. Open a pull request

CI runs on every push and every pull request. **Green means green**: the deploy
path refuses to ship a commit whose CI has not passed.

What CI checks:

| Step | Catches |
| --- | --- |
| `pnpm install --frozen-lockfile` | A dependency added without updating the lockfile |
| `pnpm typecheck` | Type errors across every package |
| `pnpm lint` | Dead code, explicit `any`, `==` |
| `pnpm test` | Regressions, including contract drift (see below) |
| `pnpm build` | A build that does not compile |
| Metadata check | A build that cannot report which commit it came from |

### The contract-drift test

The test worth knowing about is in `apps/api/src/app.test.ts`. It asserts that
the API's `/version` response satisfies the contract defined in
`packages/shared` and validates against the contract's own parser.

If you rename a field in the API and not in `packages/shared`, this fails:

```
ContractError: BuildInfo is missing required field "commitShort"
```

That is deliberate. The API validates its own response at startup, so a build
with drift fails to boot rather than serving a payload consumers cannot read.

## 4. Merge to `main`

Squash-merge. The commit message should say what changed and why, not which
files moved.

## 5. Deploy to staging

```bash
./scripts/deploy.sh staging
```

This builds, cuts a release, points `current` at it, restarts the service, and
waits for the health gate. It needs root.

Staging is at **http://127.0.0.1:3001**.

## 6. Verify staging

The deploy already gated on this, but look yourself before promoting:

```bash
curl -s http://127.0.0.1:3001/version | jq
curl -s http://127.0.0.1:3001/health/ready | jq
```

`/version` must report the commit you just deployed. If it reports a different
one, the deploy did not take effect and something is wrong with the activation.

## 7. Deploy to production

```bash
./scripts/deploy.sh production
```

Production is at **http://127.0.0.1:3002**.

Production refuses to deploy from a dirty working tree — the commit must exist.
Staging allows it, so a fix can be tested before it is committed.

## What the health gate actually does

Before a deploy is considered successful, `scripts/health-check.sh` polls the
environment and requires all of:

1. `/health` responds — the process is listening.
2. `/health/ready` returns `ready` — every configured dependency is reachable.
3. `/version` reports **the commit that was just deployed**.

The third check is what stops a deploy that silently did not take effect from
being reported as a success. Without it, "deployed" and "the old version is
still running" look identical.

If the gate does not pass within 45s, the deploy **rolls back automatically**
and exits non-zero. It does not leave a broken release live for you to find
later.

## Migrations

Schema changes are numbered SQL files in `apps/api/migrations/`, applied in
filename order by `scripts/migrate.sh`. **`deploy.sh` runs them automatically**
between staging the release and activating it, so the schema is never behind the
code that is about to serve traffic.

```bash
./scripts/migrate.sh staging --dry-run   # what is pending, change nothing
./scripts/migrate.sh staging             # apply
```

Rules, because these are the parts that are expensive to change later:

- **Forward-only.** There are no down migrations. A rollback restores code,
  never schema.
- **Every migration must be additive for at least one release.** Since rollback
  restores the previous code against the *current* schema, the schema has to
  work for both versions during the window when either could be live. Add a
  column, backfill, and stop reading the old one in a later release — do not
  rename or drop in the same release that introduces the change.
- **Never edit an applied migration.** It is recorded by filename in
  `schema_migrations`, and two environments will silently disagree about the
  schema. Write a new file.
- Each file runs in a transaction together with the row that records it, so a
  failure part-way leaves neither the schema change nor the bookkeeping behind.

If a migration fails, `deploy.sh` stops before activating and the previous
release keeps serving. That is deliberate: a failed migration is a code problem,
and the running service is not the thing to break while you fix it.

## Rollback

A release is an immutable timestamped directory; `current` is a symlink.
Rollback is therefore a symlink move plus a restart, which is why it works even
when the faulty release cannot start at all.

```bash
./scripts/rollback.sh staging --list          # what is available
./scripts/rollback.sh staging                 # previous release
./scripts/rollback.sh production --to <id>    # a specific release
```

Rollback also gates on health, so a rollback that does not restore service
tells you so instead of reporting success.

**Deploy already rolls back automatically when its gate fails.** Use
`rollback.sh` for the other case: a release that passed its gate and then turned
out to be wrong.

## Environments

| | Staging | Production |
| --- | --- | --- |
| URL | `http://127.0.0.1:3001` | `http://127.0.0.1:3002` |
| systemd unit | `ddj-api@staging` | `ddj-api@production` |
| Service user | `ddj-staging` | `ddj-production` |
| Release root | `/srv/ddj/staging` | `/srv/ddj/production` |
| Config | `/srv/ddj/staging/shared/.env` | `/srv/ddj/production/shared/.env` |
| Logs | `/var/log/ddj/staging/api.log` | `/var/log/ddj/production/api.log` |

Both run the same artifact with the same unit template. Only the config
differs — which is what makes "it worked in staging" mean something.

Config changes go in `shared/.env`, which persists across releases and is never
overwritten by a deploy. Restart to apply:

```bash
systemctl restart ddj-api@staging
```

### Binding to the network

Both environments bind `127.0.0.1` by default, so they are not reachable from
the LAN. To expose one deliberately:

```bash
DDJ_BIND_HOST=0.0.0.0 ./scripts/deploy.sh staging
```

There is no TLS terminator or reverse proxy configured. See "Known gaps".

## First-time host setup

```bash
sudo ./scripts/setup-environments.sh
```

Creates the service users, directories, and systemd units. Idempotent, and it
never touches an existing release or `.env`.

## Logs and status

```bash
systemctl status ddj-api@production
journalctl -u ddj-api@production -n 50 --no-pager
tail -f /var/log/ddj/production/api.log
```

## Known gaps

Recorded here rather than discovered later.

- **No public ingress.** Both environments bind loopback on a host with a LAN
  address. There is no reverse proxy, no TLS, and no public DNS pointing here.
  "Deployed and reachable" currently means reachable from this host. Exposing
  this needs a substrate decision (a public host, or a tunnel in front of this
  one) plus a TLS terminator.
- **No GitHub remote.** CI is written and runs locally via `pnpm ci`, but the
  repository has no remote and no Actions runs yet, so there is no hosted green
  run to link. Pushing needs a credential with `repo` and `workflow` scope.
- **No database.** `/health/ready` reports `skipped` because no
  `DDJ_DATABASE_URL` is configured. The readiness plumbing is real and tested;
  it has simply never had a dependency to check in a live environment.
- **Secrets are plain files** in `shared/.env`, mode 640, owned by the service
  user. Fine for config; revisit before anything sensitive lives there.
