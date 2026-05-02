# Developer Access — Design

**Status:** Draft (pending implementation)
**Date:** 2026-05-02
**Skill name:** `add-developer-access`

## Summary

Give Andy (the NanoClaw agent) view/edit access to projects on `/Volumes/1tbSSD/` and conversational, runtime control over write permissions and destructive shell commands — both gated through Signal (or whichever channel is registered for the main group). Coexists with the existing `github` container skill; together they enable phone-driven async development, directory organisation, and remote pair-programming on Greg's project drive.

## Goals

- Andy can read every project on `/Volumes/1tbSSD/` by default.
- Andy can write only to projects Greg has explicitly granted, with grants persistent across conversations.
- Greg can grant write access mid-conversation by replying "yes" in chat — no rebuild, no service restart.
- Greg can list and revoke grants conversationally.
- Andy can clone new repos to the SSD root via the same approval flow.
- Destructive Bash commands (`rm -rf`, `git push --force`, `git reset --hard`, etc.) require Greg's per-command approval.
- NanoClaw's own source directory and standard secret patterns are non-bypassable hard rails.

## Non-goals (v1)

- Mid-conversation container respawn (Option β). Granted mounts apply to the next container spawn; Andy adds one extra round-trip per write session.
- Multiple GitHub identities. Existing `mudislandkid`-only `GH_TOKEN` is sufficient.
- Other groups beyond `main`. Main-only by default; future opt-in possible.
- Sandbox subdirectory for Andy's clones. Clones land at `/Volumes/1tbSSD/<repo>/` alongside Greg's projects.
- Time-limited grants. Persistent until explicitly revoked.
- Worktree-based consolidation. Standard PR-based flow only.
- Web/desktop dashboard. CLI `list` + `revoke` are sufficient.
- LLM-based danger detection. Destructive command set is deterministic regex.
- A second writable area for Andy's first-time clones outside `/Volumes/1tbSSD/`.

## User stories

1. **Phone-driven feature work.** Greg messages Andy from his phone: "Refactor the timezone handling in VoltWise's forecaster." Andy reads the file, asks for write access, Greg replies "yes", Andy edits, commits to a branch, pushes, opens a PR, sends Greg the link.
2. **Directory hygiene.** "Andy, find all my repos with open Dependabot alerts and tell me which need attention." Andy reads everything (RO), produces a report — no write access ever requested.
3. **First-time clone.** "Andy, look at mudislandkid/old-cve-repo I haven't touched in two years." Andy doesn't have it locally, runs `dev-access clone mudislandkid/old-cve-repo`, Greg approves, orchestrator clones to `/Volumes/1tbSSD/old-cve-repo/`, registers as writable, Andy works on the next turn.
4. **Cache cleanup with safety.** "Andy, clear the build cache in TheTutorClassroom." Andy runs `rm -rf .next/`, the destructive-command hook intercepts, Greg gets a Signal prompt with the exact command, replies "yes", command runs.
5. **Forgotten grants.** "Andy, what can you write to?" Andy reads the allowlist + DB, replies with the list. "Drop write to VoltWise." Andy requests revoke, Greg confirms, mount drops on next spawn.

## Architecture

### Mount layout (overlay strategy)

```
Host                           Container
/Volumes/1tbSSD/         →     /workspace/dev/                    (RO)
/Volumes/1tbSSD/VoltWise/ →    /workspace/dev/VoltWise/           (RW, if granted)
/Volumes/1tbSSD/Eirene/   →    /workspace/dev/Eirene/             (RW, if granted)
```

Single user-facing namespace — Andy always works at `/workspace/dev/<project>/` regardless of whether it's RO or RW. Bind-mount overlay (parent RO, child RW) is honoured by both Docker and Apple Container.

### Components

1. **`add-developer-access` install skill** (`.claude/skills/add-developer-access/SKILL.md`) — one-time setup, mirrors the `add-second-brain` installer pattern.
2. **`dev-access` container skill** (`container/skills/dev-access/`):
   - `SKILL.md` — Andy's prose instructions.
   - `dev-access` — bash CLI on `$PATH` inside the container; marshals JSON IPC requests, polls for responses.
3. **`src/dev-access-handler.ts` (new orchestrator module)** — watches `/workspace/ipc/access-requests/` per group, validates against hard rails, sends channel prompts, parses replies via affirmative/negative classifier, mutates allowlist + DB on grant, writes response files.
4. **`src/mount-security.ts` (extension)**:
   - `invalidateAllowlistCache()` exported function — used by handler and a new host-side `nanoclaw-mount-reload` CLI.
   - Support for `requireApproval: true` flag on a root entry: root is mounted RO automatically, RW requires explicit per-subdirectory entry in the group's `additionalMounts`.
5. **`src/container-runner.ts` (extension)** — when an allowlist root has `requireApproval: true`, add it as a RO root mount automatically (no DB entry needed). Per-project RW mounts still come from DB `additionalMounts`. Layer order: parent first, child mounts after.
6. **Destructive-command gate** — PreToolUse hook configured in the per-group `.claude/settings.json`. Hook script (host-mounted, container can't tamper) reads command on stdin, regex-matches against `~/.config/nanoclaw/dangerous-commands.json`, either allows immediately, drops an IPC request, or auto-denies.

### Hard rails (orchestrator-enforced, non-bypassable)

- Path resolves to NanoClaw's own dir (`process.cwd()` of the orchestrator at install time, frozen into the handler).
- Path matches existing default blocked patterns (`.ssh`, `.gnupg`, `.aws`, `.env`, `id_rsa`, etc. — see `mount-security.ts`).
- Path is outside any allowed root (existing logic).
- Path traversal in request payloads (`..`, absolute where relative expected).
- `rm -rf /` / `rm -rf /*` literal-path deletes (matched by `hardDenyPatterns` in the destructive-command config; auto-deny without prompt).

## Data flow

### Scenario A — write access on existing project

```
1. Greg → "Edit timezone handling in VoltWise/forecaster.py"
2. Andy   reads /workspace/dev/VoltWise/ (RO), tries to write, hits EROFS
3. Andy   runs: dev-access request VoltWise "fix forecaster timezone"
4. Script writes /workspace/ipc/access-requests/<uuid>.json, polls response file
5. Handler validates, queues request, sends channel prompt:
            "Andy wants write access to VoltWise — 'fix forecaster timezone'.
             Reply yes/no."
6. Greg → "yes"
7. Handler classifier matches, resolves oldest pending, updates
   ~/.config/nanoclaw/mount-allowlist.json (adds VoltWise, allowReadWrite:true,
   overrideNonMainReadOnly:true), updates registered_groups.container_config.
   additionalMounts in SQLite, calls invalidateAllowlistCache(), writes
   /workspace/ipc/access-responses/<uuid>.json with status:granted.
8. Andy   tells Greg: "Got write access to VoltWise. Ping me to retry."
9. Greg → "go ahead"
10. Next container spawn includes the new RW mount; Andy edits, commits,
    pushes, opens PR via gh, replies with PR link.
```

### Scenario B — first-time clone

Same flow, but instead of mutating the mount registry directly, the handler runs `gh repo clone <owner/repo> /Volumes/1tbSSD/<repo>` on the host, then registers the new directory as an RW mount. Same one-message-delay UX as A.

### Scenario C — list

Synchronous: handler reads allowlist + DB, returns the writable-project list immediately, no channel prompt.

### Scenario D — revoke

Channel prompt sent ("Andy wants to revoke write access to VoltWise. Reply yes/no") for veto safety. On YES: removes allowlist entry + DB additionalMount, invalidates cache. Mount drops on next spawn.

### Scenario E — destructive command

```
1. Andy runs `rm -rf .next/` (cwd: /workspace/dev/TheTutorClassroom)
2. PreToolUse hook intercepts, regex matches dangerous pattern
3. Hard-rail check: not NanoClaw, $vars resolved non-empty → ok to ask
4. Hook drops /workspace/ipc/dangerous-commands/<uuid>.json with full command
   + cwd + project, polls for response
5. Handler sends channel prompt:
     "Andy wants to run `rm -rf .next/` in TheTutorClassroom. Reply yes/no."
6. Greg → "yes"
7. Handler writes response with status:approved
8. Hook exits 0; SDK proceeds with the Bash call
9. Andy continues
```

Deny path: handler writes `status:denied`; hook exits 1 with stderr `denied by user`; SDK surfaces failure to Andy who reports gracefully and continues with non-destructive alternatives.

## IPC protocol

### Access requests

`/workspace/ipc/access-requests/<uuid>.json`:
```json
{
  "id": "uuid-v4",
  "command": "request|revoke|list|clone",
  "project": "VoltWise",
  "owner": "mudislandkid",
  "reason": "fix forecaster timezone",
  "requestedAt": "2026-05-02T10:30:00Z"
}
```

`/workspace/ipc/access-responses/<uuid>.json`:
```json
{
  "id": "uuid-v4",
  "status": "granted|denied|timeout|blocked",
  "message": "human-readable explanation",
  "details": { "project": "VoltWise", "mountPath": "/workspace/dev/VoltWise" }
}
```

### Destructive command requests

`/workspace/ipc/dangerous-commands/<uuid>.json`:
```json
{
  "id": "uuid-v4",
  "command": "rm -rf .next/",
  "cwd": "/workspace/dev/TheTutorClassroom",
  "project": "TheTutorClassroom",
  "matchedPattern": "rm\\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\\s+|--force\\s+|--recursive\\s+)",
  "requestedAt": "2026-05-02T10:35:00Z"
}
```

`/workspace/ipc/dangerous-responses/<uuid>.json`:
```json
{
  "id": "uuid-v4",
  "status": "approved|denied|timeout|blocked",
  "message": "human-readable explanation"
}
```

## Conversational reply matching

When a request prompt is pending for the main group, the orchestrator's inbound message handler intercepts replies before they reach Andy:

- Affirmative regex: `^\s*(yes|yeah|yep|sure|ok|okay|do it|go|grant|allow|👍)\b`
- Negative regex: `^\s*(no|nope|nah|deny|don'?t|reject|👎)\b`

Both case-insensitive. If a reply matches one and exactly one pending request exists, it resolves that request. If multiple are pending, "yes" resolves the oldest; Greg can disambiguate with "yes VoltWise" / "no Eirene".

If a reply matches neither pattern (e.g. "actually fix Y first"), it falls through to Andy normally — pending requests stay queued until resolution or timeout.

**Timeouts:** 5 minutes per request. On timeout, response file written with `status:timeout`, request file deleted, Andy informed on next interaction.

## Allowlist schema extension

`~/.config/nanoclaw/mount-allowlist.json` gains support for `requireApproval` on root entries:

```json
{
  "allowedRoots": [
    {
      "path": "/Volumes/1tbSSD",
      "allowReadWrite": false,
      "overrideNonMainReadOnly": false,
      "requireApproval": true,
      "description": "Developer projects drive — RO root, RW per-subdir on grant"
    },
    {
      "path": "/Volumes/1tbSSD/VoltWise",
      "allowReadWrite": true,
      "overrideNonMainReadOnly": true,
      "description": "Granted via dev-access on 2026-05-02"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

When a root has `requireApproval: true`:
- The orchestrator auto-mounts it RO at `/workspace/dev/` for any group enabled for dev-access.
- Sub-paths under that root are *not* writable unless they have their own allowlist entry with `allowReadWrite: true`.
- The hard rails (NanoClaw self-dir, blocked patterns) still apply on top.

## Destructive command pattern set

Default `~/.config/nanoclaw/dangerous-commands.json`:

```json
{
  "patterns": [
    "rm\\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\\s+|--force\\s+|--recursive\\s+)",
    "git\\s+push\\s+.*(--force(-with-lease)?|-f\\b)",
    "git\\s+reset\\s+--hard",
    "git\\s+clean\\s+-[a-zA-Z]*[fd]",
    "git\\s+branch\\s+-D",
    "\\bdropdb\\b",
    "DROP\\s+(TABLE|DATABASE|SCHEMA)",
    ">\\s*(\\.env|package\\.json|.*\\.lock)\\b",
    "find\\s+.*-delete",
    "find\\s+.*-exec\\s+rm",
    "(npm|yarn|pnpm)\\s+(uninstall|remove)\\b"
  ],
  "hardDenyPatterns": [
    "rm\\s+(-[rRf]+\\s+)?/\\s*$",
    "rm\\s+(-[rRf]+\\s+)?/\\*"
  ]
}
```

`patterns` triggers an approval prompt; `hardDenyPatterns` auto-deny without prompting.

Editable on host; reload via `nanoclaw-mount-reload` (which also reloads dangerous-commands).

## Edge cases

| Case | Behaviour |
|---|---|
| Two simultaneous requests | FIFO queue per group; `yes` resolves oldest; Andy notified which resolved |
| Revoke while Andy mid-edit | Current container keeps mount until exit; next spawn lacks it |
| Two grants race in SQLite | Per-group in-memory mutex serialises writes |
| Channel down at prompt time | Handler retries 3x with backoff, then `timeout` response |
| Crash between allowlist write and DB write | Allowlist has entry, DB doesn't → no mount → Andy retries → resyncs |
| Reply >5 min late | No pending request matches; reply falls through to Andy |
| Stale request files at startup | Handler scans, expires anything >5 min old, writes timeouts, deletes |
| `rm -rf $UNSET_VAR` | Hook does not expand shell vars; falls through to the standard `rm -rf` pattern → channel prompt shows the literal command → Greg can deny |
| Andy requests grant on NanoClaw self-dir | Auto-blocked; no channel prompt; response status:blocked |
| Greg edits allowlist by hand | `nanoclaw-mount-reload` CLI invalidates cache; next spawn picks up |

## Audit trail

Two append-only host-side log files (container can't write):

- `groups/main/dev-access.log` — every grant/revoke/clone with timestamp, project, action, source (`signal-reply` / `manual-edit` / `timeout` / `auto-block`).
- `groups/main/dangerous-commands.log` — every gated command with timestamp, command, project, decision, source.

One line per event, plain text, easy to `tail`.

## Channel agnosticism

The handler doesn't hardcode Signal. It uses whatever channel is registered for the main group via the channel registry — Signal today, Telegram tomorrow if Greg switches. The prompt is sent through `router.ts`'s standard outbound message path.

## Trust boundary

Once Andy has write access to a project, the SDK can run any non-destructive Bash command and any Edit/Write tool freely within that project. The destructive-command gate catches the genuinely dangerous patterns. This matches the trust model of running Cursor/Claude Code on Greg's laptop — the boundary is "what's been granted", not "every individual action."

Out of scope: protection against intentional Anthropic-API compromise, against Andy intentionally destroying state through non-destructive operations (e.g. overwriting a file via Edit), against Andy reading sensitive content within a granted project.

## Rollout (install skill phases)

1. **Pre-flight.** Verify `/Volumes/1tbSSD/` exists, NanoClaw at writable git state, main group registered. Show summary of what will change; confirm with user.
2. **Config files.** Write `~/.config/nanoclaw/dangerous-commands.json` with defaults (skip if exists, ask to overwrite). Update `~/.config/nanoclaw/mount-allowlist.json` to add SSD root entry with `requireApproval: true` (preserve existing entries).
3. **Container skill.** Install `container/skills/dev-access/` (SKILL.md + executable script).
4. **Orchestrator changes.** Apply patches to `mount-security.ts`, `container-runner.ts`. Add new `dev-access-handler.ts`. Wire the handler into `src/index.ts` startup. Update `.claude/settings.json` template to include the destructive-command PreToolUse hook.
5. **Group instructions.** Append a "Developer Access" section to `groups/main/CLAUDE.md` with `/workspace/dev/` orientation, elevation flow, and destructive-gate explanation.
6. **Build & restart.** `npm run build`, kickstart NanoClaw.
7. **Verification.** Print smoke-test prompts for the user.

**Idempotence.** Re-running the install skill detects existing state at each phase and skips/asks rather than overwriting.

**Rollback.** Install writes `~/.config/nanoclaw/dev-access-rollback.sh` that:
- Removes SSD root entry from allowlist.
- Strips `/Volumes/1tbSSD/*` mounts from main's `container_config.additionalMounts`.
- Restores `groups/main/CLAUDE.md` from a saved backup.
- Removes the `container/skills/dev-access/` directory.
- Removes the PreToolUse hook from settings.json.
- `npm run build` + restart.

## Testing

### Manual smoke tests
1. RO root mount visible; reads work; writes fail.
2. Elevation happy path (request → yes → next-message edit completes).
3. Elevation deny path.
4. Hard-rail block on NanoClaw self-dir (no prompt fires).
5. List + revoke flows.
6. First-time clone flow.
7. Destructive-gate happy path (`rm -rf dist/` → yes → command runs).
8. Destructive-gate deny path.
9. Destructive auto-deny on literal hard-deny pattern (`rm -rf /*`) — no prompt fires.
10. Allowlist hot-reload via `nanoclaw-mount-reload`.
11. Stale request cleanup at orchestrator startup.

### Automated tests
- Unit: `mount-security.ts` cache invalidation; destructive pattern regex; FIFO queue ordering; affirmative/negative classifier.
- Integration: full IPC flow with mocked channel — write request, simulate reply, assert state changes.

## Open questions

None at design-approval time. Implementation may surface tactical questions about Apple Container vs Docker mount-overlay differences; flag during execution.
