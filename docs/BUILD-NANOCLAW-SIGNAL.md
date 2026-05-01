# Build NanoClaw with Signal — Complete Implementation Guide

> **Purpose:** This document gives a Claude agent (or developer) everything needed to build NanoClaw from scratch with Signal as the messaging channel. It describes the full architecture, every source file, the data model, security model, and container system. Follow it to produce a working personal AI assistant that receives Signal messages and responds via Claude Agent SDK running in isolated Docker containers.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Project Structure](#project-structure)
3. [Technology Stack](#technology-stack)
4. [Core Concepts](#core-concepts)
5. [Message Flow](#message-flow)
6. [Source Files — Host Process](#source-files--host-process)
7. [Source Files — Container Agent](#source-files--container-agent)
8. [Database Schema](#database-schema)
9. [Signal Channel Implementation](#signal-channel-implementation)
10. [Container System](#container-system)
11. [Credential Proxy](#credential-proxy)
12. [IPC System](#ipc-system)
13. [Task Scheduler](#task-scheduler)
14. [Security Model](#security-model)
15. [Group Configuration](#group-configuration)
16. [Service Setup (launchd / systemd)](#service-setup)
17. [Build & Run](#build--run)
18. [Environment Variables](#environment-variables)

---

## Architecture Overview

NanoClaw is a **single Node.js process** that:

1. Connects to Signal (and optionally other channels) via SDK
2. Stores messages in SQLite
3. Polls for new messages every 2 seconds
4. When triggered, spawns a Docker container running Claude Agent SDK
5. Streams agent responses back to the user via Signal
6. Provides file-based IPC for containers to send messages, schedule tasks, and register groups

```
Signal ──► Node.js Orchestrator ──► SQLite
                │                       │
                │   poll every 2s       │
                │◄──────────────────────┘
                │
                ▼
         Docker Container
         ┌─────────────────────┐
         │ Claude Agent SDK    │
         │ (agent-runner)      │
         │                     │
         │ MCP Server (IPC)    │
         │ Browser Automation  │
         └─────────┬───────────┘
                    │ stdout (JSON markers)
                    ▼
         Orchestrator ──► Signal (reply)
```

### Key Design Decisions

- **Container isolation**: Agents run in Docker with only explicitly mounted directories visible. They never see API keys or secrets.
- **Credential proxy**: A local HTTP proxy injects real API credentials. Containers only know `ANTHROPIC_BASE_URL=http://host.docker.internal:3001`.
- **File-based IPC**: Containers write JSON files to `/workspace/ipc/` directories. The host polls these directories every second.
- **Channel abstraction**: Channels self-register at import time via a factory pattern. Adding a new channel means implementing the `Channel` interface and calling `registerChannel()`.
- **Per-group isolation**: Each registered group gets its own filesystem directory, IPC namespace, and Claude session. Groups cannot see each other's data.

---

## Project Structure

```
nanoclaw/
├── src/                          # Host process source (TypeScript)
│   ├── index.ts                  # Main orchestrator, message loop
│   ├── config.ts                 # Constants, paths, env reading
│   ├── db.ts                     # SQLite schema and queries
│   ├── router.ts                 # Message formatting, outbound routing
│   ├── ipc.ts                    # IPC file watcher
│   ├── container-runner.ts       # Docker container spawning
│   ├── container-runtime.ts      # Runtime abstraction (docker binary)
│   ├── credential-proxy.ts       # HTTP proxy for credential injection
│   ├── task-scheduler.ts         # Scheduled task execution
│   ├── group-queue.ts            # Per-group concurrency queue
│   ├── group-folder.ts           # Path validation/resolution
│   ├── mount-security.ts         # Mount allowlist validation
│   ├── sender-allowlist.ts       # Per-group sender filtering
│   ├── env.ts                    # .env file parser (no process.env pollution)
│   ├── logger.ts                 # Pino logger
│   ├── types.ts                  # Shared TypeScript interfaces
│   ├── image.ts                  # Image processing (sharp)
│   ├── transcription.ts          # Voice message transcription
│   ├── timezone.ts               # Timezone formatting helpers
│   └── channels/
│       ├── index.ts              # Barrel import (triggers registration)
│       ├── registry.ts           # Channel factory registry
│       └── signal.ts             # Signal channel implementation
├── container/
│   ├── Dockerfile                # Agent container image
│   ├── build.sh                  # Build script
│   ├── agent-runner/
│   │   ├── package.json          # Container-side dependencies
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts          # Agent execution loop
│   │       └── ipc-mcp-stdio.ts  # MCP server for IPC tools
│   └── skills/                   # Skills synced into containers
├── groups/
│   ├── main/                     # Main group (admin) workspace
│   │   └── CLAUDE.md             # Main group instructions
│   ├── global/
│   │   └── CLAUDE.md             # Shared instructions for all groups
│   └── signal_main/              # Example: Signal 1:1 chat group
│       └── CLAUDE.md
├── store/                        # SQLite database directory
│   └── messages.db
├── data/
│   ├── ipc/                      # Per-group IPC directories
│   │   └── {group-folder}/
│   │       ├── messages/
│   │       ├── tasks/
│   │       └── input/
│   └── sessions/                 # Per-group Claude sessions
│       └── {group-folder}/
│           ├── .claude/
│           └── agent-runner-src/
├── .env                          # Secrets (never mounted into containers)
├── package.json
├── tsconfig.json
└── launchd/
    └── com.nanoclaw.plist        # macOS service definition
```

---

## Technology Stack

### Host Process

| Package | Version | Purpose |
|---------|---------|---------|
| `signal-sdk` | ^0.1.8 | Signal messaging (wraps signal-cli) |
| `better-sqlite3` | ^11.8.1 | SQLite database |
| `cron-parser` | ^5.5.0 | Task scheduling |
| `pino` / `pino-pretty` | ^9.6.0 | Structured logging |
| `sharp` | ^0.34.5 | Image processing |
| `qrcode` / `qrcode-terminal` | ^1.5.4 | QR code for Signal auth |
| `zod` | ^4.3.6 | Schema validation |
| `typescript` | ^5.7.0 | |
| Node.js | >=20 | Runtime |

### Container (agent-runner)

| Package | Version | Purpose |
|---------|---------|---------|
| `@anthropic-ai/claude-agent-sdk` | ^0.2.76 | Claude Agent SDK |
| `@modelcontextprotocol/sdk` | ^1.12.1 | MCP server for IPC tools |
| `cron-parser` | ^5.0.0 | Validation of cron expressions |
| `zod` | ^4.0.0 | Tool parameter validation |

### Container Image

- Base: `node:22-slim`
- Chromium + dependencies (for browser automation via `agent-browser`)
- Global: `agent-browser`, `@anthropic-ai/claude-code`

---

## Core Concepts

### Channels

A channel is a messaging platform connector. Each channel implements the `Channel` interface:

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}
```

Channels self-register at module load time via `registerChannel(name, factory)`. The factory returns `null` if credentials are missing, so unconfigured channels are silently skipped.

### JIDs (Chat Identifiers)

Each channel uses a prefixed JID format to identify chats:

- **Signal**: `signal:+1234567890` (DMs) or `signal:{base64-group-id}` (groups)
- **WhatsApp**: `1234567890@s.whatsapp.net` (DMs) or `1234567890-1234567890@g.us` (groups)
- **Telegram**: `tg:-1001234567890`
- **Discord**: `dc:1234567890123456`

The router uses `ownsJid()` to determine which channel should handle a given JID.

### Groups

A "group" in NanoClaw is any registered chat — could be a Signal 1:1, a group chat, or a "Note to Self". Each group has:

- A JID (unique identifier)
- A folder name under `groups/` (e.g., `signal_main`)
- A trigger pattern (e.g., `@Andy`)
- Whether it requires the trigger prefix
- Whether it's the main (admin) group

### Trigger Pattern

Messages in non-main groups must start with `@{ASSISTANT_NAME}` to activate the agent. Messages without the trigger still accumulate in the database and are included as context when a trigger eventually arrives. The main group and groups with `requiresTrigger: false` process all messages.

---

## Message Flow

### Inbound (Signal → Agent)

1. **Signal SDK** fires `message` event with an envelope
2. **SignalChannel.handleMessage()** extracts sender, text, attachments, determines if group/DM
3. **onChatMetadata()** called for chat discovery (stores in `chats` table)
4. **onMessage()** called for registered groups → stores in `messages` table (after sender allowlist check)
5. **Message loop** (every 2s) polls `messages` table for new rows since `lastTimestamp`
6. Deduplicates by group, checks trigger pattern
7. If triggered: formats messages as XML, enqueues for container processing
8. **GroupQueue** manages concurrency — only one container per group at a time
9. If a container is already running for this group, messages are **piped** into it via IPC

### Container Processing

1. **runContainerAgent()** builds volume mounts, spawns `docker run -i`
2. Input JSON sent to container's stdin
3. Container's **entrypoint.sh** compiles TypeScript, runs `agent-runner`
4. **agent-runner** calls Claude Agent SDK `query()` with the prompt
5. SDK runs tools (Bash, Read, Write, WebSearch, MCP tools, etc.)
6. Results wrapped in `---NANOCLAW_OUTPUT_START---` / `---NANOCLAW_OUTPUT_END---` markers
7. Host parses these markers from stdout stream

### Outbound (Agent → Signal)

1. Host receives streamed output via stdout markers
2. Strips `<internal>...</internal>` tags (agent's private reasoning)
3. Calls `channel.sendMessage(chatJid, text)` on the owning channel
4. **SignalChannel.sendMessage()** routes: groups go direct, DMs may redirect to `SIGNAL_USER_PHONE`

### IPC (Container → Host)

While the container is running, it can:
- **Send messages** via MCP tool → writes JSON to `/workspace/ipc/messages/`
- **Schedule tasks** via MCP tool → writes JSON to `/workspace/ipc/tasks/`
- **Register groups** (main only) → writes JSON to `/workspace/ipc/tasks/`
- **Receive follow-up messages** → reads from `/workspace/ipc/input/`

The host polls IPC directories every 1 second.

---

## Source Files — Host Process

### `src/index.ts` — Main Orchestrator

The entry point. Responsibilities:

- Initializes database, loads state (timestamps, sessions, registered groups)
- Starts credential proxy on port 3001
- Creates and connects all registered channels
- Starts the message loop (2s polling interval)
- Starts the IPC watcher
- Starts the task scheduler
- Handles graceful shutdown (SIGTERM, SIGINT)

**Key functions:**
- `main()` — bootstrap sequence
- `startMessageLoop()` — infinite loop polling for new messages
- `processGroupMessages(chatJid)` — fetches pending messages, checks trigger, invokes container
- `runAgent()` — wraps `runContainerAgent()` with session tracking
- `recoverPendingMessages()` — startup recovery for crash between cursor advance and processing

**Message loop logic:**
```
while (true) {
  poll messages since lastTimestamp for all registered group JIDs
  advance lastTimestamp cursor
  for each group with new messages:
    if trigger required and not present: skip
    if container already running: pipe messages via IPC
    else: enqueue for new container
  sleep 2 seconds
}
```

### `src/config.ts` — Configuration

Reads non-secret config from `.env` via `readEnvFile()`. Exports constants:

| Constant | Default | Description |
|----------|---------|-------------|
| `ASSISTANT_NAME` | `'Andy'` | Bot name, used in trigger pattern |
| `ASSISTANT_HAS_OWN_NUMBER` | `false` | Whether bot has dedicated phone |
| `POLL_INTERVAL` | `2000` | Message loop polling (ms) |
| `SCHEDULER_POLL_INTERVAL` | `60000` | Task scheduler polling (ms) |
| `CONTAINER_IMAGE` | `'nanoclaw-agent:latest'` | Docker image name |
| `CONTAINER_TIMEOUT` | `1800000` | 30 min container timeout |
| `CREDENTIAL_PROXY_PORT` | `3001` | Proxy port |
| `IPC_POLL_INTERVAL` | `1000` | IPC directory polling (ms) |
| `IDLE_TIMEOUT` | `1800000` | 30 min idle before container cleanup |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Global concurrency limit |
| `TRIGGER_PATTERN` | `/^@Andy\b/i` | Regex built from ASSISTANT_NAME |
| `TIMEZONE` | System timezone | For cron scheduling |

Paths:
- `STORE_DIR` — `{cwd}/store`
- `GROUPS_DIR` — `{cwd}/groups`
- `DATA_DIR` — `{cwd}/data`
- `MOUNT_ALLOWLIST_PATH` — `~/.config/nanoclaw/mount-allowlist.json`
- `SENDER_ALLOWLIST_PATH` — `~/.config/nanoclaw/sender-allowlist.json`

### `src/env.ts` — .env Parser

Parses `.env` file for specific keys without polluting `process.env`. This keeps secrets out of child process environments.

```typescript
function readEnvFile(keys: string[]): Record<string, string>
```

### `src/db.ts` — Database

SQLite via `better-sqlite3`. Initializes at `store/messages.db`.

All queries are synchronous (better-sqlite3's API). Tables are created in `createSchema()` with migration logic for adding new columns to existing databases.

(See [Database Schema](#database-schema) section for full schema.)

### `src/router.ts` — Message Formatting

- `formatMessages(messages, timezone)` — converts message array to XML:
  ```xml
  <context timezone="Europe/London" />
  <messages>
  <message sender="Greg" time="11:30 AM">Hello @Andy</message>
  </messages>
  ```
- `stripInternalTags(text)` — removes `<internal>...</internal>` blocks
- `formatOutbound(rawText)` — strips internal tags for delivery
- `findChannel(channels, jid)` — finds channel that owns a JID

### `src/container-runner.ts` — Container Spawning

**`buildVolumeMounts(group, isMain)`** — constructs mount list:

For **main group**:
| Container Path | Host Path | Access |
|---|---|---|
| `/workspace/project` | Project root | read-only |
| `/workspace/project/.env` | `/dev/null` | read-only (shadow) |
| `/workspace/group` | `groups/main/` | read-write |

For **other groups**:
| Container Path | Host Path | Access |
|---|---|---|
| `/workspace/group` | `groups/{folder}/` | read-write |
| `/workspace/global` | `groups/global/` | read-only |

All groups get:
| Container Path | Host Path | Access |
|---|---|---|
| `/home/node/.claude` | `data/sessions/{folder}/.claude/` | read-write |
| `/workspace/ipc` | `data/ipc/{folder}/` | read-write |
| `/app/src` | `data/sessions/{folder}/agent-runner-src/` | read-write |
| `/workspace/extra/*` | Additional mounts from `containerConfig` | varies |

**`buildContainerArgs(mounts, containerName)`** — constructs `docker run` args:
- `-i --rm` (interactive, remove on exit)
- Environment: `TZ`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (placeholder)
- Host gateway for Docker Desktop
- `--user` matching host UID/GID
- Volume mounts

**`runContainerAgent()`** — spawns container, pipes input JSON to stdin, parses output markers from stdout stream, handles timeout and error recovery.

Output protocol: Container writes results between sentinel markers:
```
---NANOCLAW_OUTPUT_START---
{"status":"success","result":"Here's the answer...","newSessionId":"abc123"}
---NANOCLAW_OUTPUT_END---
```

### `src/container-runtime.ts` — Runtime Abstraction

Abstracts the container runtime binary (`docker`). Key exports:

- `CONTAINER_RUNTIME_BIN` — `'docker'`
- `CONTAINER_HOST_GATEWAY` — `'host.docker.internal'`
- `PROXY_BIND_HOST` — `'127.0.0.1'` on macOS, docker0 bridge IP on Linux
- `hostGatewayArgs()` — `['--add-host=host.docker.internal:host-gateway']` on Linux
- `ensureContainerRuntimeRunning()` — checks `docker info`, fatal error if not running
- `cleanupOrphans()` — stops stale `nanoclaw-*` containers from previous runs

### `src/ipc.ts` — IPC Watcher

Polls `data/ipc/` every 1 second. Each group gets its own subdirectory with `messages/` and `tasks/` folders.

**Authorization model:**
- Group identity is determined by the IPC directory path (tamper-proof from containers)
- Main group can send messages to any chat, schedule tasks for any group, register new groups
- Non-main groups can only send to their own chat, schedule for themselves

**Supported IPC message types:**
- `message` — send a text message to a chat
- `schedule_task` — create a scheduled task
- `pause_task` / `resume_task` / `cancel_task` / `update_task` — task management
- `register_group` — register a new group (main only)
- `refresh_groups` — request group metadata sync (main only)

### `src/task-scheduler.ts` — Task Scheduler

Polls the `scheduled_tasks` table every 60 seconds for due tasks. Supports:

- **cron**: Standard cron expressions with timezone support
- **interval**: Milliseconds between runs (drift-resistant, anchored to scheduled time)
- **once**: One-time ISO timestamp

Tasks run in containers just like regular messages, but with `isScheduledTask: true` flag.

### `src/group-queue.ts` — Concurrency Queue

Manages per-group message/task queuing. Only one container runs per group at a time. If a container is already running, new messages are piped into it via IPC `input/` directory.

### `src/group-folder.ts` — Path Validation

Validates and resolves group folder names. Prevents path traversal:
- Pattern: `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`
- No `..`, `/`, `\`
- Reserved: `global`
- All paths resolved against base directories with containment check

### `src/mount-security.ts` — Mount Allowlist

Validates additional mounts against `~/.config/nanoclaw/mount-allowlist.json`. This file lives outside the project root and is never mounted, making it tamper-proof.

Default blocked patterns: `.ssh`, `.gnupg`, `.aws`, `.env`, `credentials`, `private_key`, etc.

### `src/channels/registry.ts` — Channel Registry

Simple factory pattern:

```typescript
const registry = new Map<string, ChannelFactory>();

function registerChannel(name: string, factory: ChannelFactory): void;
function getChannelFactory(name: string): ChannelFactory | undefined;
function getRegisteredChannelNames(): string[];
```

### `src/channels/index.ts` — Channel Barrel

Imports each channel module to trigger their `registerChannel()` calls:

```typescript
import './signal.js';
// import './whatsapp.js';  // Only if installed
```

### `src/types.ts` — Shared Interfaces

Key types:

```typescript
interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean;  // Default: true
  isMain?: boolean;
}

interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number;
}

interface AdditionalMount {
  hostPath: string;
  containerPath?: string;
  readonly?: boolean;  // Default: true
}

interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}

type ChannelFactory = (opts: ChannelOpts) => Channel | null;

interface ChannelOpts {
  onMessage: (chatJid: string, message: NewMessage) => void;
  onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
}
```

---

## Source Files — Container Agent

### `container/agent-runner/src/index.ts` — Agent Runner

Runs inside the Docker container. Flow:

1. Read JSON from stdin (ContainerInput)
2. Discover optional MCP servers based on mounted files
3. Run Claude Agent SDK `query()` with:
   - Prompt (formatted message XML)
   - Session resume (if existing session)
   - Allowed tools: Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task/Team tools, MCP nanoclaw tools
   - Permission mode: `bypassPermissions` (containers are the sandbox)
   - MCP servers: `nanoclaw` (IPC), plus any optional servers
   - Pre-compact hook: archives conversation transcripts before context compaction
4. Stream results via output markers to stdout
5. After query completes, wait for IPC follow-up messages
6. If new message arrives: run another query (resuming session)
7. If `_close` sentinel appears: exit

**MessageStream class**: Push-based async iterable that keeps the SDK's query loop alive, allowing agent teams subagents to run to completion and IPC messages to be piped in during execution.

**SDK configuration:**
```typescript
query({
  prompt: messageStream,
  options: {
    cwd: '/workspace/group',
    additionalDirectories: extraDirs,  // Discovered from /workspace/extra/
    resume: sessionId,
    systemPrompt: globalClaudeMd ? { type: 'preset', preset: 'claude_code', append: globalClaudeMd } : undefined,
    allowedTools: [
      'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch',
      'Task', 'TaskOutput', 'TaskStop',
      'TeamCreate', 'TeamDelete', 'SendMessage',
      'TodoWrite', 'ToolSearch', 'Skill', 'NotebookEdit',
      'mcp__nanoclaw__*',
    ],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project', 'user'],
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: chatJid,
          NANOCLAW_GROUP_FOLDER: groupFolder,
          NANOCLAW_IS_MAIN: isMain ? '1' : '0',
        },
      },
    },
    hooks: {
      PreCompact: [{ hooks: [createPreCompactHook(assistantName)] }],
    },
  }
})
```

### `container/agent-runner/src/ipc-mcp-stdio.ts` — MCP Server

Stdio-based MCP server providing tools to the agent:

| Tool | Description |
|------|-------------|
| `send_message` | Send a message to the chat immediately |
| `schedule_task` | Schedule a recurring or one-time task |
| `list_tasks` | List all scheduled tasks |
| `pause_task` | Pause a task |
| `resume_task` | Resume a paused task |
| `cancel_task` | Cancel and delete a task |
| `update_task` | Update task prompt/schedule |
| `register_group` | Register a new group (main only) |

Each tool writes a JSON file to the appropriate IPC directory. The host's IPC watcher picks up and processes these files.

### `container/Dockerfile`

```dockerfile
FROM node:22-slim

# Chromium for browser automation
RUN apt-get update && apt-get install -y \
    chromium fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
    libgbm1 libnss3 libatk-bridge2.0-0 libgtk-3-0 libx11-xcb1 \
    libxcomposite1 libxdamage1 libxrandr2 libasound2 libpangocairo-1.0-0 \
    libcups2 libdrm2 libxshmfence1 curl git \
    && rm -rf /var/lib/apt/lists/*

ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

RUN npm install -g agent-browser @anthropic-ai/claude-code

WORKDIR /app
COPY agent-runner/package*.json ./
RUN npm install
COPY agent-runner/ ./
RUN npm run build

RUN mkdir -p /workspace/group /workspace/global /workspace/extra \
    /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Entrypoint: recompile TypeScript (from mounted /app/src), then run
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\n\
ln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\n\
cat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' \
  > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

RUN chown -R node:node /workspace && chmod 777 /home/node
USER node
WORKDIR /workspace/group
ENTRYPOINT ["/app/entrypoint.sh"]
```

The entrypoint recompiles the agent-runner from mounted source (`/app/src`), allowing per-group customization without rebuilding the image.

---

## Database Schema

SQLite at `store/messages.db`.

### `chats` — Chat discovery

```sql
CREATE TABLE chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  last_message_time TEXT,
  channel TEXT,
  is_group INTEGER DEFAULT 0
);
```

### `messages` — Message storage

```sql
CREATE TABLE messages (
  id TEXT,
  chat_jid TEXT,
  sender TEXT,
  sender_name TEXT,
  content TEXT,
  timestamp TEXT,
  is_from_me INTEGER,
  is_bot_message INTEGER DEFAULT 0,
  PRIMARY KEY (id, chat_jid),
  FOREIGN KEY (chat_jid) REFERENCES chats(jid)
);
CREATE INDEX idx_timestamp ON messages(timestamp);
```

### `registered_groups` — Group configuration

```sql
CREATE TABLE registered_groups (
  jid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL UNIQUE,
  trigger_pattern TEXT NOT NULL,
  added_at TEXT NOT NULL,
  container_config TEXT,       -- JSON
  requires_trigger INTEGER DEFAULT 1,
  is_main INTEGER DEFAULT 0
);
```

### `scheduled_tasks` — Task definitions

```sql
CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  group_folder TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_type TEXT NOT NULL,
  schedule_value TEXT NOT NULL,
  context_mode TEXT DEFAULT 'isolated',
  next_run TEXT,
  last_run TEXT,
  last_result TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_next_run ON scheduled_tasks(next_run);
CREATE INDEX idx_status ON scheduled_tasks(status);
```

### `task_run_logs` — Task execution history

```sql
CREATE TABLE task_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  run_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
);
CREATE INDEX idx_task_run_logs ON task_run_logs(task_id, run_at);
```

### `router_state` — Persistent cursors

```sql
CREATE TABLE router_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Keys: 'last_timestamp', 'last_agent_timestamp' (JSON object of per-group timestamps)
```

### `sessions` — Claude session IDs

```sql
CREATE TABLE sessions (
  group_folder TEXT PRIMARY KEY,
  session_id TEXT NOT NULL
);
```

---

## Signal Channel Implementation

### `src/channels/signal.ts`

**Environment variables:**
- `SIGNAL_BOT_PHONE` — The bot's phone number (signal-cli account)
- `SIGNAL_USER_PHONE` — Owner's phone for DM routing (optional)

**JID format:** `signal:{phone-or-group-id}`

**Connection:** Creates `SignalCli` instance from `signal-sdk`, listens for `message` events.

**Message handling:**

1. Parse envelope from SDK event
2. Determine message type:
   - `dataMessage` — incoming message (group or DM)
   - `syncMessage.sentMessage` — synced from another device (Note to Self)
3. For sync messages: only process if `destinationNumber === botPhone` (Note to Self / bot echo)
4. For data messages: extract group ID or use bot phone as chat identifier for DMs
5. Detect bot messages by `{ASSISTANT_NAME}:` prefix
6. Handle attachments:
   - Audio → transcribe via OpenAI Whisper
   - Images → process with sharp, save to group folder
7. Construct JID: `signal:{chatPhone}`
8. Emit metadata for chat discovery
9. Deliver message only to registered groups

**Sending:**

```typescript
async sendMessage(jid: string, text: string): Promise<void> {
  const rawId = jidToPhone(jid);  // strip "signal:" prefix
  const isGroup = this.isGroupId(rawId);
  // For DMs to self, redirect to user's phone
  const recipient = isGroup ? rawId
    : (rawId === botPhone && userPhone) ? userPhone : rawId;
  await this.signal.sendMessage(recipient, text);
}
```

**Group detection:** Signal group IDs are base64-encoded and contain `=`, `/`, or non-leading `+`.

**Outgoing queue:** Messages sent while disconnected are queued and flushed on reconnect.

### Signal Authentication

Signal uses `signal-cli` under the hood. Two modes:

**Linked device (recommended):**
1. Run `signal link --name NanoClaw`
2. SDK generates QR code URI
3. User scans with Signal mobile app
4. No SMS needed

**Primary device:**
1. `signal register -u +1234567890`
2. User receives SMS verification code
3. `signal verify <code>`
4. Set profile: `updateProfile --given-name Andy`

---

## Container System

### Lifecycle

1. **Spawn**: `docker run -i --rm --name nanoclaw-{folder}-{timestamp} ...`
2. **Input**: JSON piped to stdin (prompt, session ID, group info, image attachments)
3. **Processing**: Agent SDK runs tools, writes results to stdout
4. **Streaming**: Host parses output markers in real-time
5. **IPC loop**: After initial query, container waits for IPC messages
6. **Cleanup**: Container exits on `_close` sentinel or timeout

### Volume Mounts (detailed)

The `buildVolumeMounts()` function constructs mounts based on group type:

**Per-group Claude sessions:**
- A `settings.json` is created with experimental flags:
  - `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` — enables subagent orchestration
  - `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` — loads CLAUDE.md from extra mounts
  - `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` — enables persistent memory

**Skills sync:** Files from `container/skills/` are copied into each group's `.claude/skills/` directory before container start.

**Agent runner source:** Copied once from `container/agent-runner/src/` to per-group `data/sessions/{folder}/agent-runner-src/`. This allows groups to customize the agent runner without affecting others. The container entrypoint recompiles from this source on each start.

### Container Arguments

```bash
docker run -i --rm \
  --name nanoclaw-signal_main-1711900000000 \
  -e TZ=Europe/London \
  -e ANTHROPIC_BASE_URL=http://host.docker.internal:3001 \
  -e ANTHROPIC_API_KEY=placeholder \
  --user 501:20 \
  -e HOME=/home/node \
  -v /path/to/groups/signal_main:/workspace/group \
  -v /path/to/groups/global:/workspace/global:ro \
  -v /path/to/data/sessions/signal_main/.claude:/home/node/.claude \
  -v /path/to/data/ipc/signal_main:/workspace/ipc \
  -v /path/to/data/sessions/signal_main/agent-runner-src:/app/src \
  nanoclaw-agent:latest
```

---

## Credential Proxy

### `src/credential-proxy.ts`

HTTP proxy running on `localhost:3001`. Containers route all API traffic through it.

**How it works:**
1. Host starts proxy with real API key loaded from `.env`
2. Containers configured with `ANTHROPIC_BASE_URL=http://host.docker.internal:3001`
3. Containers send requests with placeholder auth (`ANTHROPIC_API_KEY=placeholder`)
4. Proxy strips placeholder, injects real credentials, forwards to `api.anthropic.com`

**Two auth modes:**

| Mode | Container Gets | Proxy Injects |
|------|---------------|---------------|
| API Key | `ANTHROPIC_API_KEY=placeholder` | Real `x-api-key` header |
| OAuth | `CLAUDE_CODE_OAUTH_TOKEN=placeholder` | Real `Authorization: Bearer` token |

Detection: if `ANTHROPIC_API_KEY` exists in `.env`, use API key mode. Otherwise, OAuth.

**Binding:**
- macOS: `127.0.0.1` (Docker Desktop routes `host.docker.internal` to loopback)
- Linux: docker0 bridge IP (so only containers can reach it)

---

## IPC System

### Directory Structure

```
data/ipc/
├── signal_main/          # Group's IPC namespace
│   ├── messages/         # Outbound messages (container → host → channel)
│   │   └── 1711900000-abc123.json
│   ├── tasks/            # Task operations (schedule, pause, cancel, register)
│   │   └── 1711900001-def456.json
│   ├── input/            # Inbound messages (host → container)
│   │   ├── 1711900002-ghi789.json
│   │   └── _close        # Sentinel: close the container
│   ├── current_tasks.json    # Snapshot of scheduled tasks
│   └── available_groups.json # Snapshot of discoverable groups
└── main/
    └── ...
```

### Message format

```json
{
  "type": "message",
  "chatJid": "signal:+1234567890",
  "text": "Hello from the agent!",
  "groupFolder": "signal_main",
  "timestamp": "2026-03-31T11:30:00.000Z"
}
```

### Atomic writes

All IPC files use atomic write: write to `.tmp` file then rename. This prevents partial reads.

---

## Task Scheduler

The scheduler runs in the host process, polling `scheduled_tasks` every 60 seconds.

### Schedule types

| Type | Value Format | Example |
|------|-------------|---------|
| `cron` | Cron expression | `0 9 * * *` (daily 9am) |
| `interval` | Milliseconds | `3600000` (1 hour) |
| `once` | Local ISO timestamp (no Z) | `2026-03-31T15:30:00` |

### Context modes

- **`group`**: Task runs with the group's existing Claude session, accessing chat history and memory
- **`isolated`**: Task runs in a fresh session with no prior context

### Drift resistance

Interval tasks anchor to their scheduled time, not `Date.now()`. If a task misses intervals (e.g., machine was asleep), it catches up to the next future interval rather than running multiple times.

---

## Security Model

### 1. Container Isolation (primary boundary)

- Agents run in Docker containers with only explicitly mounted directories
- Non-root `node` user (UID 1000)
- `--rm` flag auto-cleans containers
- Host UID mapping via `--user` flag

### 2. Credential Isolation

- Real API keys exist only in `.env` and the credential proxy process
- `.env` is shadowed with `/dev/null` in main group's project mount
- Containers receive placeholder credentials only
- Proxy injects real credentials per-request

### 3. Filesystem Isolation

- Non-main groups: only see their own folder + global (read-only)
- Main group: project root (read-only) + own folder (read-write)
- Additional mounts validated against external allowlist

### 4. IPC Authorization

- Group identity determined by IPC directory path (not self-declared)
- Main can send to any chat, schedule for any group
- Non-main can only send to own chat, schedule for self
- `isMain` cannot be set via IPC (defense in depth)

### 5. Mount Security

- Allowlist at `~/.config/nanoclaw/mount-allowlist.json` (never mounted)
- Default blocked: `.ssh`, `.gnupg`, `.aws`, `.env`, `credentials`, etc.
- Path traversal protection via `resolveGroupFolderPath()`
- Symlink resolution via `fs.realpathSync()`

### 6. Sender Allowlist

Optional per-group filtering at `~/.config/nanoclaw/sender-allowlist.json`:
- **Trigger mode**: Everyone's messages stored, but only allowed senders can trigger
- **Drop mode**: Non-allowed sender messages not stored at all

---

## Group Configuration

### Directory structure

Each group gets a folder under `groups/`:

```
groups/
├── main/           # Admin group
│   └── CLAUDE.md   # Instructions for admin context
├── global/
│   └── CLAUDE.md   # Shared instructions loaded by all groups
└── signal_main/    # Signal 1:1 chat
    ├── CLAUDE.md   # Group-specific instructions
    ├── conversations/  # Archived transcripts
    └── logs/       # Container run logs
```

### Naming convention

Channel prefix + underscore + group name: `{channel}_{name}`
- `signal_main` — Signal main chat
- `whatsapp_family-chat` — WhatsApp group
- `telegram_dev-team` — Telegram group

### CLAUDE.md

The `CLAUDE.md` file in each group folder is loaded by the Claude Agent SDK as project instructions. It defines:
- The agent's persona and capabilities
- Communication style and formatting rules
- Available tools and how to use them
- Group-specific behavior (e.g., email triage rules)

The `global/CLAUDE.md` is appended to all non-main group prompts via the SDK's `systemPrompt.append` option.

### Registration

Groups are registered in the `registered_groups` SQLite table. The main group can register new groups via the `register_group` MCP tool.

---

## Service Setup

### macOS (launchd)

Create `~/Library/LaunchAgents/com.nanoclaw.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/node</string>
        <string>/path/to/nanoclaw/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/nanoclaw</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/yourusername</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/path/to/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>/path/to/logs/nanoclaw.error.log</string>
</dict>
</plist>
```

Commands:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart
```

### Linux (systemd)

```ini
[Unit]
Description=NanoClaw Personal Assistant
After=network.target docker.service

[Service]
Type=simple
WorkingDirectory=/path/to/nanoclaw
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable nanoclaw
systemctl --user start nanoclaw
```

---

## Build & Run

### Prerequisites

- Node.js >= 20
- Docker (Docker Desktop on macOS, or Docker Engine on Linux)
- Java runtime (for signal-cli)
- Anthropic API key or Claude OAuth token

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cat > .env << 'EOF'
ASSISTANT_NAME=Andy
SIGNAL_BOT_PHONE=+1234567890
SIGNAL_USER_PHONE=+0987654321
ANTHROPIC_API_KEY=sk-ant-...
EOF

# 3. Build host process
npm run build

# 4. Build container image
./container/build.sh

# 5. Authenticate Signal (linked device mode)
# This will display a QR code — scan with Signal mobile app
npx tsx setup/signal-auth.ts

# 6. Create initial group directories
mkdir -p groups/main groups/global groups/signal_main store data

# 7. Register your main group in the database
# (The agent does this automatically when you first message it,
#  or you can do it via the setup skill)

# 8. Run
npm start
# or with hot reload:
npm run dev
```

### TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## Environment Variables

### `.env` file (secrets — never mounted into containers)

| Variable | Required | Description |
|----------|----------|-------------|
| `ASSISTANT_NAME` | No | Bot name (default: `Andy`) |
| `SIGNAL_BOT_PHONE` | Yes | Bot's Signal phone number |
| `SIGNAL_USER_PHONE` | No | Owner's phone for DM routing |
| `ANTHROPIC_API_KEY` | Yes* | Anthropic API key |
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes* | Alternative: OAuth token |
| `ANTHROPIC_AUTH_TOKEN` | No | Legacy OAuth token alias |
| `OPENAI_API_KEY` | No | For voice transcription |
| `ASSISTANT_HAS_OWN_NUMBER` | No | `true` if bot has dedicated number |

\* One of `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is required.

### Process environment (optional overrides)

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTAINER_IMAGE` | `nanoclaw-agent:latest` | Docker image |
| `CONTAINER_TIMEOUT` | `1800000` | Container timeout (ms) |
| `CREDENTIAL_PROXY_PORT` | `3001` | Proxy port |
| `IDLE_TIMEOUT` | `1800000` | Idle cleanup timeout (ms) |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Max parallel containers |
| `LOG_LEVEL` | `info` | Pino log level |
| `TZ` | System | Timezone for scheduling |

---

## Summary

NanoClaw is ~2,500 lines of TypeScript (host) + ~600 lines (container agent). The key insight is that **the host process is just a message router** — all intelligence lives in the containerized Claude Agent SDK. The container boundary provides security isolation while the credential proxy ensures secrets never enter untrusted environments.

To build this from scratch with Signal:
1. Implement the host process (index.ts, config, db, router, ipc, container-runner)
2. Implement the Signal channel (signal.ts + registry)
3. Build the container image with agent-runner
4. Configure Signal authentication
5. Set up the service
