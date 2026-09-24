# GitHub: repository, CI, and the token

The repository has no remote yet. Everything below is the one-time step that
puts it on GitHub, plus what you need to hand over to make that happen.

Written against the decision recorded on DDJ-3: **GitHub + Actions**. That
decision settles two of DDJ-3's five bullets — a hosted repository and CI
running on every push. It does **not** settle where production runs, which is
still open (see "What this does not fix" at the end).

## What you need to provide

One token. Nothing else — no account setup, no payment, no host configuration.

### 1. Create a classic personal access token

<https://github.com/settings/tokens/new>

| Field | Value | Why |
| --- | --- | --- |
| Note | `ddjeh-paperclip-engineer` | So it is identifiable a year from now |
| Expiration | 90 days | Long enough to be useful, short enough to be rotated deliberately. Put the renewal date in the token note if you want a reminder. |
| Scopes | `repo`, `workflow` | `repo` creates the repository and pushes to it. `workflow` is required to push anything under `.github/workflows/` — without it, GitHub rejects the push with a message about the workflow scope. |

**Use a classic token, not a fine-grained one.** Fine-grained tokens have to be
scoped to repositories that already exist, and this repository does not exist
yet. That is the whole reason.

### 2. Add it to Paperclip as a secret

Do **not** paste the token into an issue comment, a document, or a message.
Anything pasted into a thread is readable by every agent on the issue and ends
up in the run transcript.

In the Paperclip UI, at **Company → Settings → Secrets**:

1. **New secret**.
2. Choose the **Company** tab (not "Each user") and **Managed value** (not
   "External reference").
3. Name it `github_token`. The environment key is derived from the name, so it
   becomes `GITHUB_TOKEN`.
4. Paste the token as the value and save.
5. Open the new secret, go to its **Usage** tab, and in the **Agent access**
   section pick Agent = **Founding Engineer**, Env var = `GITHUB_TOKEN`, then
   **Add**.

That last step is the one that matters: creating the secret alone does not give
any agent access to it. The binding is what injects it at run start.

Equivalent through the API, if you prefer the command line:

```bash
# Create the secret. Keep the value out of your shell history.
curl -sS -X POST \
  -H "Authorization: Bearer $PAPERCLIP_USER_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- \
  "$PAPERCLIP_API_BASE/api/companies/$PAPERCLIP_COMPANY_ID/secrets" <<'JSON'
{ "name": "github_token", "value": "<paste here>", "description": "GitHub PAT: repo + workflow" }
JSON
```

Then bind it to the Founding Engineer agent's `adapterConfig.env.GITHUB_TOKEN`
as a `secret_ref` — the UI does this in one click, which is why the UI path is
the recommended one.

### 3. Tell me it is done

Comment on DDJ-3. The next run picks the secret up and finishes the job with no
further input from you. If the token belongs to an organisation rather than
your personal account, say so and name the org — the repository is created
under the token's own account otherwise.

## What I do with it

One command, idempotent, safe to run twice:

```bash
./scripts/github-bootstrap.sh --owner <org-or-user> --name ddj-platform
```

It creates the repository, adds `origin`, pushes `main`, and then waits for the
Actions run on the pushed commit and prints its URL — which is the green CI run
DDJ-3 asks for as evidence. `--dry-run` prints the plan without touching
anything. `--visibility private` is available; the default is `public`, because
a public repository makes the CI run linkable to anyone, and this repository
contains no client code yet. Say so if you want it private instead.

The token is passed to `git push` through a one-shot credential helper, never
written into the remote URL. A token in `.git/config` is a token in every
backup and in every pasted `git remote -v`.

## What this does not fix

**Production is still not publicly reachable.** GitHub gives us the repository
and hosted CI. It is not a host, so it cannot serve the API. The success
condition on DDJ-3 is "something is deployed to production and reachable", and
the second half of that still needs one of:

| Option | What it needs | Trade-off |
| --- | --- | --- |
| Fly.io / Render / Railway | An account and an API token | Durable, genuinely public, one more credential |
| A host we already own | Address and access from the board | Durable; needs DNS and TLS wired |
| Cloudflare quick tunnel | Nothing | Public today, but a random ephemeral URL — evidence-grade, not production-grade |

Staging and production both run on this host today (`:3001` and `:3002`,
loopback). CI, the deploy path, and rollback all work against them.

## Once there is a deploy target

Two wirings, in order of how much they need from you:

- **A public host (Fly/Render/Railway).** A deploy job in
  `.github/workflows/ci.yml` gated on `needs: build-and-test`, that installs
  the host's CLI and runs the deploy step with a token from repository
  secrets. I write this; you supply the token.
- **This host.** Register the machine as a self-hosted runner and run the same
  `scripts/deploy.sh` from the workflow against the artifact CI already built.
  This is a security-relevant change — a runner executes repository code on the
  host — so it gets escalated to the CEO before it is merged, per the
  engineering instructions.

Either way the gate is the same: the deploy job depends on the build-and-test
job, so a red build cannot reach an environment.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `GitHub rejected the token (401)` | Token expired, revoked, or mistyped when saved | Create a new one and update the secret value; the version history keeps the old value audit-able |
| `GitHub refused to create the repo (403)` | Missing `repo` scope, or no permission to create repos in the org | Re-issue with `repo`; for an org, check your role there |
| Push rejected with a message about the `workflow` scope | Token lacks `workflow` | Re-issue the token with both `repo` and `workflow` |
| `the working tree is dirty` | Uncommitted changes | Commit or stash them; the script refuses to push a tree that is not what the commit says |
| No Actions run appears | Workflows are disabled on the repo, or the push created the repo but not the branch | Check the Actions tab; it prints the exact URL to look at |
| CI green locally, red on GitHub | Node or pnpm version drift | Both are pinned in `.github/workflows/ci.yml` and `package.json`; compare the versions in the failing step's log |
