/**
 * dev-access-handler.ts
 *
 * Host-side IPC watcher that processes developer access requests from containers.
 * Watches /data/ipc/<group>/access-requests/ for incoming JSON files, validates
 * them against hard rails, queues approved requests, and prompts the user via the
 * registered channel. On reply, grants or denies access by mutating the mount
 * allowlist and the group's containerConfig.additionalMounts.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR, IPC_POLL_INTERVAL } from './config.js';
import { logger } from './logger.js';
import { loadMountAllowlist } from './mount-security.js';
import {
  addSubdirEntry,
  removeSubdirEntry,
  listWritableSubdirs,
} from './allowlist-writer.js';
import { appendAuditEntry } from './dev-access/audit-log.js';
import { validateAccessRequest } from './dev-access/hard-rails.js';
import { PendingQueue, PendingRequest } from './dev-access/pending-queue.js';
import { classifyReply } from './dev-access/reply-classifier.js';
import { RegisteredGroup } from './types.js';

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

// The main group returned by getMainGroup() includes its jid (map key from DB).
// RegisteredGroup itself does not carry jid — it's the DB map key. We extend
// inline here to avoid modifying the shared type for a single use-case.
type MainGroupWithJid = RegisteredGroup & { jid: string };

export interface DevAccessDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  /** Returns the main group augmented with its jid, or null. */
  getMainGroup: () => MainGroupWithJid | null;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  updateGroupConfig: (jid: string, group: RegisteredGroup) => void;
  nanoclawDir: string;
}

interface DevAccessIncomingRequest {
  id: string;
  command: 'request' | 'revoke' | 'list' | 'clone';
  project?: string;
  owner?: string;
  reason?: string;
  requestedAt: string;
}

export interface DevAccessHandler {
  /** Stop the watcher (used in tests and on process exit). */
  stop: () => void;
  /** Returns true if any pending request exists for the group. */
  hasPending: (groupFolder: string) => boolean;
  /** List pending requests for a group. */
  getPendingForGroup: (groupFolder: string) => PendingRequest[];
  /**
   * Try to resolve a pending request from an inbound user reply. Returns
   * true if the reply was consumed (and should NOT be forwarded to Andy).
   */
  tryConsumeReply: (groupFolder: string, text: string) => Promise<boolean>;
}

export function startDevAccessHandler(deps: DevAccessDeps): DevAccessHandler {
  const queue = new PendingQueue();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // ---------------------------------------------------------------------------
  // Path helpers
  // ---------------------------------------------------------------------------

  const getRequestsDir = (groupFolder: string) =>
    path.join(DATA_DIR, 'ipc', groupFolder, 'access-requests');

  const getResponsesDir = (groupFolder: string) =>
    path.join(DATA_DIR, 'ipc', groupFolder, 'access-responses');

  const auditPath = (groupFolder: string) =>
    path.join(GROUPS_DIR, groupFolder, 'dev-access.log');

  // ---------------------------------------------------------------------------
  // Response writer
  // ---------------------------------------------------------------------------

  function writeResponse(groupFolder: string, id: string, body: object): void {
    const dir = getResponsesDir(groupFolder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(body));
  }

  // ---------------------------------------------------------------------------
  // Allowlist root resolution
  // ---------------------------------------------------------------------------

  function resolveApprovalRoot(): string | null {
    const allowlist = loadMountAllowlist();
    const root = allowlist?.allowedRoots.find((r) => r.requireApproval);
    if (!root) return null;
    if (root.path.startsWith('~/')) {
      return path.join(process.env.HOME || '', root.path.slice(2));
    }
    if (root.path === '~') {
      return process.env.HOME || '';
    }
    return root.path;
  }

  // ---------------------------------------------------------------------------
  // Request processing
  // ---------------------------------------------------------------------------

  async function processRequestFile(
    groupFolder: string,
    filePath: string,
  ): Promise<void> {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      // File may have been consumed by a concurrent tick — skip silently.
      return;
    }

    // Remove the file immediately so we don't reprocess on the next tick.
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Already deleted — skip.
      return;
    }

    let req: DevAccessIncomingRequest;
    try {
      req = JSON.parse(raw);
    } catch (err) {
      logger.warn(
        { filePath, err },
        'dev-access: failed to parse request file',
      );
      return;
    }

    if (req.command === 'list') {
      await handleList(groupFolder, req);
      return;
    }

    if (!req.project) {
      writeResponse(groupFolder, req.id, {
        id: req.id,
        status: 'blocked',
        message: 'Missing project field',
      });
      return;
    }

    const allowlist = loadMountAllowlist();
    const approvalRoot = resolveApprovalRoot();
    const allowedRootPaths = approvalRoot ? [approvalRoot] : [];

    // Resolve the absolute path for the requested project.
    const absPath = approvalRoot
      ? path.join(approvalRoot, req.project)
      : path.normalize(req.project);

    const validation = validateAccessRequest({
      requestedPath: absPath,
      nanoclawDir: deps.nanoclawDir,
      blockedPatterns: allowlist?.blockedPatterns ?? [],
      allowedRootPaths,
    });

    if (!validation.allowed) {
      appendAuditEntry(auditPath(groupFolder), {
        timestamp: new Date().toISOString(),
        action: 'request-blocked',
        project: req.project,
        source: 'auto-block',
        details: { reason: validation.reason, command: req.command },
      });
      writeResponse(groupFolder, req.id, {
        id: req.id,
        status: 'blocked',
        message: validation.reason,
      });
      return;
    }

    // Queue the request.
    queue.add({
      id: req.id,
      groupFolder,
      command: req.command as 'request' | 'revoke' | 'clone',
      project: req.project,
      owner: req.owner,
      reason: req.reason,
      requestedAt: req.requestedAt,
    });

    // Send prompt to the user via the registered channel.
    const main = deps.getMainGroup();
    if (!main) {
      writeResponse(groupFolder, req.id, {
        id: req.id,
        status: 'timeout',
        message: 'No main group registered to deliver prompt',
      });
      queue.resolveById(groupFolder, req.id);
      return;
    }

    const prompt = formatPrompt(req);
    try {
      await deps.sendMessage(main.jid, prompt);
    } catch (err) {
      logger.warn(
        { err, requestId: req.id },
        'dev-access: failed to deliver prompt to user',
      );
      writeResponse(groupFolder, req.id, {
        id: req.id,
        status: 'timeout',
        message: 'Could not deliver prompt to user',
      });
      queue.resolveById(groupFolder, req.id);
    }
  }

  // ---------------------------------------------------------------------------
  // Prompt formatting
  // ---------------------------------------------------------------------------

  function formatPrompt(req: DevAccessIncomingRequest): string {
    if (req.command === 'request') {
      return (
        `Andy wants write access to ${req.project}` +
        (req.reason ? ` — "${req.reason}"` : '') +
        `. Reply yes/no.`
      );
    }
    if (req.command === 'revoke') {
      return `Andy wants to revoke write access to ${req.project}. Reply yes/no.`;
    }
    if (req.command === 'clone') {
      const repoRef = req.owner
        ? `${req.owner}/${req.project}`
        : (req.project ?? '(unknown)');
      return `Andy wants to clone ${repoRef} into your projects drive. Reply yes/no.`;
    }
    return `Andy sent an access request: ${JSON.stringify(req)}. Reply yes/no.`;
  }

  // ---------------------------------------------------------------------------
  // List command (synchronous read)
  // ---------------------------------------------------------------------------

  async function handleList(
    groupFolder: string,
    req: DevAccessIncomingRequest,
  ): Promise<void> {
    const approvalRoot = resolveApprovalRoot();
    const writable = approvalRoot ? listWritableSubdirs(approvalRoot) : [];
    writeResponse(groupFolder, req.id, {
      id: req.id,
      status: 'granted',
      message: 'list ok',
      details: { writable },
    });
  }

  // ---------------------------------------------------------------------------
  // Stale request expiry
  // ---------------------------------------------------------------------------

  async function expireStale(): Promise<void> {
    const cutoff = Date.now() - REQUEST_TIMEOUT_MS;
    const expired = queue.expireOlderThan(cutoff);
    for (const r of expired) {
      writeResponse(r.groupFolder, r.id, {
        id: r.id,
        status: 'timeout',
        message: 'No reply received within 5 minutes',
      });
      appendAuditEntry(auditPath(r.groupFolder), {
        timestamp: new Date().toISOString(),
        action: 'timeout',
        project: r.project,
        source: 'timeout',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Poll tick
  // ---------------------------------------------------------------------------

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const ipcBase = path.join(DATA_DIR, 'ipc');
      if (fs.existsSync(ipcBase)) {
        const groupFolders = fs
          .readdirSync(ipcBase)
          .filter((f) => fs.statSync(path.join(ipcBase, f)).isDirectory());

        for (const groupFolder of groupFolders) {
          const dir = getRequestsDir(groupFolder);
          if (!fs.existsSync(dir)) continue;
          const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
          for (const file of files) {
            await processRequestFile(groupFolder, path.join(dir, file));
          }
        }
      }
      await expireStale();
    } catch (err) {
      logger.error({ err }, 'dev-access-handler tick error');
    }
    if (!stopped) {
      timer = setTimeout(tick, IPC_POLL_INTERVAL);
    }
  }

  // ---------------------------------------------------------------------------
  // Reply classifier + grant/deny execution
  // ---------------------------------------------------------------------------

  async function tryConsumeReply(
    groupFolder: string,
    text: string,
  ): Promise<boolean> {
    if (!queue.peekOldest(groupFolder)) return false;

    const classified = classifyReply(text);
    if (classified.decision === 'none') return false;

    const resolved = classified.project
      ? queue.resolveByProject(groupFolder, classified.project)
      : queue.resolveOldest(groupFolder);

    if (!resolved) return false;

    if (classified.decision === 'affirmative') {
      await applyGrant(resolved);
    } else {
      await applyDenial(resolved);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Grant logic
  // ---------------------------------------------------------------------------

  async function applyGrant(req: PendingRequest): Promise<void> {
    const approvalRoot = resolveApprovalRoot() ?? '/';
    const projectPath = path.join(approvalRoot, req.project!);

    if (req.command === 'clone') {
      // The orchestrator (Task 10+) will perform the actual `gh repo clone`.
      // We pre-register the allowlist entry so it's ready after clone completes.
      addSubdirEntry({
        path: projectPath,
        description: `Granted via dev-access clone on ${new Date().toISOString().slice(0, 10)}`,
      });
      registerMountInGroup(req.groupFolder, projectPath, req.project!);
      writeResponse(req.groupFolder, req.id, {
        id: req.id,
        status: 'granted',
        message: 'clone-and-mount queued; orchestrator will run gh repo clone',
        details: {
          project: req.project,
          mountPath: `/workspace/dev/${req.project}`,
        },
      });
      appendAuditEntry(auditPath(req.groupFolder), {
        timestamp: new Date().toISOString(),
        action: 'clone',
        project: req.project,
        source: 'signal-reply',
        details: { owner: req.owner },
      });
      return;
    }

    if (req.command === 'revoke') {
      removeSubdirEntry(projectPath);
      unregisterMountInGroup(req.groupFolder, projectPath);
      writeResponse(req.groupFolder, req.id, {
        id: req.id,
        status: 'granted',
        message: `Revoked write access to ${req.project}`,
      });
      appendAuditEntry(auditPath(req.groupFolder), {
        timestamp: new Date().toISOString(),
        action: 'revoke',
        project: req.project,
        source: 'signal-reply',
      });
      return;
    }

    // command === 'request'
    addSubdirEntry({
      path: projectPath,
      description: `Granted via dev-access on ${new Date().toISOString().slice(0, 10)}`,
    });
    registerMountInGroup(req.groupFolder, projectPath, req.project!);
    writeResponse(req.groupFolder, req.id, {
      id: req.id,
      status: 'granted',
      message: `Granted write access to ${req.project}. Tell Greg to ping you to retry.`,
      details: {
        project: req.project,
        mountPath: `/workspace/dev/${req.project}`,
      },
    });
    appendAuditEntry(auditPath(req.groupFolder), {
      timestamp: new Date().toISOString(),
      action: 'grant',
      project: req.project,
      source: 'signal-reply',
      details: { reason: req.reason },
    });
  }

  // ---------------------------------------------------------------------------
  // Denial logic
  // ---------------------------------------------------------------------------

  async function applyDenial(req: PendingRequest): Promise<void> {
    writeResponse(req.groupFolder, req.id, {
      id: req.id,
      status: 'denied',
      message: 'Greg said no.',
    });
    appendAuditEntry(auditPath(req.groupFolder), {
      timestamp: new Date().toISOString(),
      // Treat a denied revoke as just 'revoke' (grant of "keep revoked" makes
      // less sense); everything else is request-blocked.
      action: req.command === 'revoke' ? 'revoke' : 'request-blocked',
      project: req.project,
      source: 'signal-reply',
      details: { command: req.command, denied: true },
    });
  }

  // ---------------------------------------------------------------------------
  // Mount registration helpers
  // ---------------------------------------------------------------------------

  /**
   * Add an additionalMount entry to the group's containerConfig and persist
   * via deps.updateGroupConfig(). The devOverlay flag causes mount-security to
   * place the mount at /workspace/dev/{containerName} instead of
   * /workspace/extra/{containerName}, achieving RW overlay semantics over the
   * read-only /workspace/dev/ root mount.
   */
  function registerMountInGroup(
    groupFolder: string,
    hostPath: string,
    containerName: string,
  ): void {
    const groups = deps.getRegisteredGroups();
    const entry = Object.entries(groups).find(
      ([, g]) => g.folder === groupFolder,
    );
    if (!entry) {
      logger.warn(
        { groupFolder },
        'dev-access: registerMountInGroup — group not found',
      );
      return;
    }
    const [jid, group] = entry;
    const config = group.containerConfig ?? {};
    const mounts = [...(config.additionalMounts ?? [])];
    if (mounts.some((m) => m.containerPath === containerName && m.devOverlay)) return;
    mounts.push({ hostPath, containerPath: containerName, readonly: false, devOverlay: true });
    const updated: RegisteredGroup = {
      ...group,
      containerConfig: { ...config, additionalMounts: mounts },
    };
    deps.updateGroupConfig(jid, updated);
  }

  function unregisterMountInGroup(groupFolder: string, hostPath: string): void {
    const groups = deps.getRegisteredGroups();
    const entry = Object.entries(groups).find(
      ([, g]) => g.folder === groupFolder,
    );
    if (!entry) return;
    const [jid, group] = entry;
    const config = group.containerConfig;
    if (!config?.additionalMounts) return;
    const remaining = config.additionalMounts.filter(
      (m) => m.hostPath !== hostPath,
    );
    if (remaining.length === config.additionalMounts.length) return;
    const updated: RegisteredGroup = {
      ...group,
      containerConfig: { ...config, additionalMounts: remaining },
    };
    deps.updateGroupConfig(jid, updated);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  timer = setTimeout(tick, IPC_POLL_INTERVAL);

  return {
    stop(): void {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    hasPending: (groupFolder) => queue.peekOldest(groupFolder) !== null,
    getPendingForGroup: (groupFolder) => queue.list(groupFolder),
    tryConsumeReply,
  };
}
