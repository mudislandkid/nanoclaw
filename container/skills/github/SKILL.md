---
name: github
description: Full access to mudislandkid GitHub repos — clone, branch, fix, push, PR, plus Dependabot/CVE alerts via the gh CLI.
---

# GitHub Access

You have full access to `mudislandkid` GitHub repos via the `gh` CLI.
The `GH_TOKEN` environment variable is pre-configured — no authentication step needed.

## Repos

```bash
gh repo list mudislandkid                            # List all repos
gh repo clone mudislandkid/<repo>                    # Clone a repo
gh repo view mudislandkid/<repo>                     # Repo details + README
gh api repos/mudislandkid/<repo>/contents/<path>     # Read file contents (base64)
gh api repos/mudislandkid/<repo>/branches            # List branches
```

## Pull Requests & Issues

```bash
gh pr list -R mudislandkid/<repo>                    # List open PRs
gh pr view <number> -R mudislandkid/<repo>           # PR details + diff
gh pr create -R mudislandkid/<repo> --title "..." --body "..."  # Create PR
gh issue list -R mudislandkid/<repo>                 # List open issues
gh issue view <number> -R mudislandkid/<repo>        # Issue details
```

## Security & CVE Scanning

```bash
# Dependabot alerts (requires security_events scope on token)
gh api repos/mudislandkid/<repo>/dependabot/alerts                        # All alerts
gh api repos/mudislandkid/<repo>/dependabot/alerts?state=open             # Open only
gh api repos/mudislandkid/<repo>/dependabot/alerts -q '.[].security_advisory.summary'  # Summaries

# Code scanning alerts (if enabled)
gh api repos/mudislandkid/<repo>/code-scanning/alerts?state=open

# Secret scanning alerts (if enabled)
gh api repos/mudislandkid/<repo>/secret-scanning/alerts?state=open

# Scan all repos for open Dependabot alerts
gh repo list mudislandkid --json nameWithOwner -q '.[].nameWithOwner' | while read repo; do
  alerts=$(gh api "repos/$repo/dependabot/alerts?state=open" -q 'length' 2>/dev/null)
  if [ "$alerts" != "0" ] && [ -n "$alerts" ]; then
    echo "$repo: $alerts open alerts"
  fi
done
```

## Fix Workflow

When fixing a CVE or Dependabot alert:

1. Clone the repo: `gh repo clone mudislandkid/<repo>`
2. Create a fix branch: `git checkout -b fix/cve-<id>`
3. Apply the fix (update dependency, patch code, etc.)
4. Test if possible (check for test scripts in package.json, Makefile, etc.)
5. Commit and push: `git push -u origin fix/cve-<id>`
6. Create PR: `gh pr create -R mudislandkid/<repo> --title "fix: patch CVE-XXXX-XXXXX" --body "..."`

## Actions

```bash
gh run list -R mudislandkid/<repo>                   # List workflow runs
gh run view <run-id> -R mudislandkid/<repo>          # Run details
gh run view <run-id> --log -R mudislandkid/<repo>    # Full run logs
```

## Commits & Activity

```bash
gh api repos/mudislandkid/<repo>/commits                          # Recent commits
gh api repos/mudislandkid/<repo>/compare/<base>...<head>          # Diff between refs
```

## Tips

- Use `--json <fields>` with `gh pr list` / `gh issue list` for structured output.
- Use `gh api` with `-q` (jq filter) to extract specific fields from JSON responses.
- For file contents via the API, the response is base64-encoded — decode with `echo <content> | base64 -d`.
- Always create a branch for fixes — never push directly to main.
- When creating PRs, include the CVE ID in the title and link to the advisory in the body.
