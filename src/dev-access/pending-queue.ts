export type PendingCommand = 'request' | 'revoke' | 'clone';

export interface PendingRequest {
  id: string;
  groupFolder: string;
  command: PendingCommand;
  project?: string;
  owner?: string;
  reason?: string;
  requestedAt: string; // ISO
  // For dangerous-command requests these fields are populated instead:
  fullCommand?: string;
  cwd?: string;
}

export class PendingQueue {
  private byGroup = new Map<string, PendingRequest[]>();

  add(req: PendingRequest): void {
    const list = this.byGroup.get(req.groupFolder) ?? [];
    list.push(req);
    this.byGroup.set(req.groupFolder, list);
  }

  peekOldest(groupFolder: string): PendingRequest | null {
    const list = this.byGroup.get(groupFolder);
    return list && list.length > 0 ? list[0] : null;
  }

  resolveOldest(groupFolder: string): PendingRequest | null {
    const list = this.byGroup.get(groupFolder);
    if (!list || list.length === 0) return null;
    return list.shift() ?? null;
  }

  resolveByProject(
    groupFolder: string,
    project: string,
  ): PendingRequest | null {
    const list = this.byGroup.get(groupFolder);
    if (!list) return null;
    const idx = list.findIndex((r) => r.project === project);
    if (idx === -1) return null;
    const [resolved] = list.splice(idx, 1);
    return resolved;
  }

  resolveById(groupFolder: string, id: string): PendingRequest | null {
    const list = this.byGroup.get(groupFolder);
    if (!list) return null;
    const idx = list.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    const [resolved] = list.splice(idx, 1);
    return resolved;
  }

  list(groupFolder: string): PendingRequest[] {
    return [...(this.byGroup.get(groupFolder) ?? [])];
  }

  /**
   * Remove requests requested before the cutoff timestamp.
   * Returns the removed entries so the caller can write timeout responses.
   */
  expireOlderThan(cutoffMs: number): PendingRequest[] {
    const expired: PendingRequest[] = [];
    for (const [group, list] of this.byGroup.entries()) {
      const remaining: PendingRequest[] = [];
      for (const r of list) {
        if (Date.parse(r.requestedAt) < cutoffMs) {
          expired.push(r);
        } else {
          remaining.push(r);
        }
      }
      this.byGroup.set(group, remaining);
    }
    return expired;
  }
}
