import { describe, it, expect } from 'vitest';
import path from 'path';
import { validateAccessRequest } from './hard-rails.js';

const NANOCLAW_DIR = '/Volumes/1tbSSD/nanoclaw';

describe('validateAccessRequest', () => {
  it('blocks the NanoClaw self-dir', () => {
    const result = validateAccessRequest({
      requestedPath: NANOCLAW_DIR,
      nanoclawDir: NANOCLAW_DIR,
      blockedPatterns: ['.ssh', '.env'],
      allowedRootPaths: ['/Volumes/1tbSSD'],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/nanoclaw/i);
  });

  it('blocks subpaths inside NanoClaw self-dir', () => {
    const result = validateAccessRequest({
      requestedPath: path.join(NANOCLAW_DIR, 'src'),
      nanoclawDir: NANOCLAW_DIR,
      blockedPatterns: [],
      allowedRootPaths: ['/Volumes/1tbSSD'],
    });
    expect(result.allowed).toBe(false);
  });

  it('blocks paths matching a default secret pattern', () => {
    const result = validateAccessRequest({
      requestedPath: '/Volumes/1tbSSD/MyProj/.ssh',
      nanoclawDir: NANOCLAW_DIR,
      blockedPatterns: ['.ssh'],
      allowedRootPaths: ['/Volumes/1tbSSD'],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/blocked pattern/i);
  });

  it('blocks path traversal attempts', () => {
    const result = validateAccessRequest({
      requestedPath: '/Volumes/1tbSSD/MyProj/../../etc',
      nanoclawDir: NANOCLAW_DIR,
      blockedPatterns: [],
      allowedRootPaths: ['/Volumes/1tbSSD'],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/traversal|outside/i);
  });

  it('blocks paths outside any allowed root', () => {
    const result = validateAccessRequest({
      requestedPath: '/etc/passwd',
      nanoclawDir: NANOCLAW_DIR,
      blockedPatterns: [],
      allowedRootPaths: ['/Volumes/1tbSSD'],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/outside.*allowed root/i);
  });

  it('allows a normal project inside the allowed root', () => {
    const result = validateAccessRequest({
      requestedPath: '/Volumes/1tbSSD/VoltWise',
      nanoclawDir: NANOCLAW_DIR,
      blockedPatterns: ['.ssh', '.env'],
      allowedRootPaths: ['/Volumes/1tbSSD'],
    });
    expect(result.allowed).toBe(true);
  });
});
