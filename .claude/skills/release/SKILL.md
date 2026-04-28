---
name: release
description: Cut a new pletivo release — bump version, push tag, watch the npm publish workflow, and write GitHub Release notes in the project's house style. Use when the user says "release", "ship", "tag a release", or "cut v0.1.X". Only operates on the `main` branch.
allowed-tools: Bash(git status:*), Bash(git log:*), Bash(git tag:*), Bash(git push:*), Bash(git fetch:*), Bash(git diff:*), Bash(git rev-parse:*), Bash(gh run list:*), Bash(gh run watch:*), Bash(gh release view:*), Bash(gh release list:*), Bash(gh release create:*), Bash(npm view:*), Bash(bun test:*), Read
---

# Release pletivo

Cut a new release of `pletivo` (the only published workspace package). The CI workflow at `.github/workflows/release.yml` is triggered by pushing a `v*` tag — it runs tests and publishes to npm via OIDC. Your job is to pick the version, push the tag, watch the run, and publish a GitHub Release with notes in the project's style.

## Live context

- Current branch: !`git rev-parse --abbrev-ref HEAD`
- Working tree status: !`git status --short`
- Latest 5 tags (most recent first): !`git tag -l 'v*' --sort=-v:refname | head -5`
- Commits since latest tag: !`git log --oneline "$(git tag -l 'v*' --sort=-v:refname | head -1)"..HEAD 2>/dev/null || git log --oneline -10`
- Latest published version on npm: !`npm view pletivo version 2>/dev/null`

## Hard rules

1. **Branch must be `main`.** If it's not, stop and tell the user.
2. **Working tree must be clean.** No uncommitted changes — they won't make it into the published artifact and silently diverge from the tag.
3. **Local `main` must be in sync with `origin/main`.** Run `git fetch origin main` and confirm `git log origin/main..HEAD` is empty before tagging.
4. **Never force-push, never overwrite an existing tag.** If the chosen tag exists, stop and ask.
5. **Always confirm the version with the user before pushing the tag.** A published npm version cannot be unpublished after 72 hours and is a permanent record either way.

## Step 1 — Pre-flight

Verify the hard rules above. If anything fails, stop and report.

If the working tree has uncommitted changes that should be part of the release, suggest invoking `/commit` first.

If `npm view pletivo version` ≠ the latest local tag, something is off (a previous release may have failed mid-way) — surface this to the user before proceeding.

## Step 2 — Choose the next version

Read the commits since the latest tag (shown in **Live context**). Apply semver:

- **Pre-1.0 (current):** the project's observed cadence is to bump **patch** for every release regardless of whether the change is feat/fix/refactor. Only bump minor (`0.X.0`) for breaking changes that warrant attention. The user may explicitly override (e.g. "cut v0.2.0").
- **Post-1.0** (when applicable): standard semver — feat → minor, fix → patch, breaking → major.

Show the user:
- The proposed version (e.g. `v0.1.16`).
- A one-line summary of what's in it (derived from the commit subjects).
- Ask for explicit confirmation. Do not proceed without it.

## Step 3 — Run the test suite locally

Run `bun test tests/integration/ tests/unit/` and confirm it's green. The CI runs the same suite, but a local pass catches the obvious before burning a tag. If tests fail, stop.

(`packages/astro-jsx-pages/test/*.js` uses Node's test runner and fails under `bun test` — that's pre-existing, not a release blocker. The release workflow runs that package's tests separately via its own scripts.)

## Step 4 — Push and tag

Per CLAUDE.md's release section:

```bash
git push origin main                  # ensure remote is up-to-date
git tag v<version> && git push origin v<version>
```

The tag push is the trigger. Once it lands, the publish workflow starts.

## Step 5 — Watch the workflow

```bash
gh run watch $(gh run list --workflow=release.yml --limit=1 --json databaseId -q '.[0].databaseId') --exit-status
```

**Gotcha:** `gh run list --limit=1` may briefly return the *previous* run before the new one is registered. If `gh run watch` reports "already completed with 'success'" instantly, double-check by listing runs with `--json headSha` and matching against `git rev-parse HEAD`. If the SHAs don't match, sleep a few seconds and re-list.

If the workflow fails, the tag is still on the remote. Investigate the failure (usually a flaky test or registry blip), fix it, and either retry the same tag (`gh workflow run release.yml --ref v<version>`) or — if a code fix is needed — delete the tag locally and remotely, push the fix, and re-tag.

## Step 6 — Verify the npm publish

```bash
npm view pletivo@<version> version    # should echo the version
```

The `dist-tags.latest` may lag a few seconds behind the publish; verifying the specific version is more reliable than `npm view pletivo version`.

## Step 7 — Draft the release notes

The project has a consistent house style. Look at the most recent release for reference:

```bash
gh release view "$(gh release list --limit 1 --json tagName -q '.[0].tagName')"
```

**Title format:** `v<version> — <short topical summary>` (e.g. `v0.1.16 — TypeScript in Astro <script> blocks`).

**Sections** (use only the ones that apply, in this order):

- `## Features` — new user-visible capabilities. Be concrete, name the API surface and the example.
- `## Breaking` — anything that requires user action. Explain the migration in one paragraph.
- `## Fixed` — bugs fixed. Describe the symptom *and* the underlying cause when it's non-obvious.
- `## Performance` — measurable changes only. Include before/after numbers if available.
- `## Internals` — refactors, helper extractions, test additions. Keep brief unless they unblock something users will notice.
- `## Notes` — known limitations or scope decisions. Especially useful for "this release intentionally does NOT do X" so users aren't surprised.

**Style:** technical but readable. Concrete API names, file paths only when load-bearing. No emojis. Match the tone of v0.1.15.

Draft the notes from the commits since the previous tag. Show them to the user for review **before** running `gh release create`.

## Step 8 — Publish the GitHub Release

Use a HEREDOC for the body to preserve formatting:

```bash
gh release create v<version> --title "v<version> — <summary>" --notes "$(cat <<'EOF'
## Features
- ...

## Fixed
- ...
EOF
)"
```

Print the release URL when done.

## When things go wrong

- **Tag already exists locally but not on remote:** `git push origin v<version>` is enough; don't recreate the tag.
- **Tag pushed but workflow didn't trigger:** check the workflow's `on.push.tags` filter in `.github/workflows/release.yml`. If matched, manually dispatch with `gh workflow run release.yml --ref v<version>`.
- **npm publish failed mid-workflow:** the tag is on the remote but the package isn't on npm. Re-run the workflow (`gh run rerun <run-id>`); the `Publish pletivo` step is idempotent in that the OIDC token is fresh each run.
- **Wrong version published:** you cannot republish the same version. Cut a new patch release (e.g. `v0.1.17`) with the fix and a `## Fixed` entry explaining what the previous release did wrong.
