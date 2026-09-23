# Repo conventions

How we write code here. Short on purpose: every rule costs someone time, so each
one earns its place or it goes.

## Layout

```
apps/           deployable services. Each has its own build and can be deployed alone.
  api/          the HTTP service
packages/       shared code. No runtime dependencies in here.
  shared/       contracts both sides agree on
scripts/        build, CI, deploy, rollback
deploy/         systemd units and other host config
docs/           this, and the release process
```

**Where does new code go?** A new service goes in `apps/`. Code two services
need goes in `packages/`. If it is only used once, it stays where it is — a
shared package with one consumer is a guess about the future that costs
indirection today.

## Workspace rules

- **pnpm, not npm.** `workspace:*` protocol for internal deps.
- **The lockfile is committed and CI installs with `--frozen-lockfile`.**
  Adding a dependency without updating the lockfile fails CI, by design — it
  means CI is testing a tree nobody else has.
- **`@ddj/shared` has no runtime dependencies.** Everything imports it, so a
  dependency there is a dependency everywhere. It is compiled by the `preflight`
  step before anything that consumes it, because consumers import its built
  output, not its source.

## TypeScript

- **Strict, everywhere.** `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. The settings live in
  `tsconfig.base.json`; do not relax them per-package.
- **`any` is a lint error.** If a type is genuinely unknown, use `unknown` and
  narrow it. If you are fighting the compiler, the types are usually telling you
  the design is wrong.
- **Types do not exist at runtime.** Anything crossing a boundary — an HTTP
  response, a config file, a message — gets validated. See
  `packages/shared/src/validate.ts` for the pattern: a hand-written parser that
  throws a named error. Add a schema library when there are dozens of contracts,
  not at two.
- **Relative imports need the `.js` extension** (`./config.js`). We target
  NodeNext ESM; the extension is what Node resolves, and omitting it works in
  the editor and fails at runtime.

## Naming

- **Files**: `kebab-case.ts`. Tests sit next to the code they test as
  `thing.test.ts`.
- **Types and interfaces**: `PascalCase`. No `I` prefix.
- **Functions and variables**: `camelCase`.
- **Constants that are truly constant**: `SCREAMING_SNAKE_CASE`. A `const`
  binding that holds a computed value is still `camelCase`.
- **Environment variables**: `DDJ_` prefix, `SCREAMING_SNAKE_CASE`.

## Tests

- **Every bug fix gets a test that fails without the fix.** Otherwise the same
  bug comes back and nobody notices.
- **Tests assert behaviour, not implementation.** Call the endpoint, check the
  response. Do not assert on internal call counts unless the count *is* the
  behaviour.
- **The failure message matters.** A test that fails with "expected true to be
  false" costs the next person ten minutes. `expect(() => x).toThrow(/contract
  drift/)` tells them what broke.
- **Test the boundary, not the happy path only.** Config parsing, contract
  validation, and error responses are where the interesting bugs live.

## Commits

- **One logical change per commit.** If the message needs "and", it is two
  commits.
- **The message says why, not what.** The diff already shows what changed.
  Explain the reasoning: what was wrong, why this fixes it, what you rejected.
- **Branches are named for the change**, not the ticket: `add-order-endpoint`.

## Errors

- **Fail fast at startup, not at request time.** Bad config should stop the
  process with a message naming the variable. See `apps/api/src/config.ts`.
- **Error messages name the thing that is wrong.** `DDJ_PORT must be an integer;
  got "8080abc"` beats `Invalid configuration`.
- **Never leak a credential into a response or a log.** The readiness endpoint
  is unauthenticated and database drivers put passwords in error messages;
  `readiness.ts` scrubs URLs for exactly this reason.
- **Exit codes are part of the interface.** `78` (`EX_CONFIG`) means the
  environment is wrong, so a supervisor does not restart-loop on it.

## Configuration

- **Read once at startup, pass it around.** Never reach into `process.env`
  deeper in the code. When staging and production behave differently,
  `config.ts` is the one file to compare.
- **Every value has a working default**, so the service starts with an empty
  environment. A missing variable is never the reason a deploy fails.
- **Secrets never enter the repo.** `.env` is gitignored; `.env.example`
  documents the shape with no real values.

## Comments

- **Comment the why.** What the code does is visible; why it does it that way
  is not.
- **Record the trap you hit.** If something failed for a non-obvious reason and
  the fix looks arbitrary, say so on the line. The note about
  `MemoryDenyWriteExecute` in `deploy/ddj-api@.service` exists so nobody
  re-adds a hardening flag that kills Node at startup.
- **Do not comment what the code says.** `// increment i` is noise.
