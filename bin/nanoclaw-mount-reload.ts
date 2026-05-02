#!/usr/bin/env node
/**
 * nanoclaw-mount-reload — invalidate cached mount-allowlist and
 * dangerous-commands config so the next container spawn picks up
 * any hand-edits you made.
 *
 * Usage: nanoclaw-mount-reload
 *
 * This works by sending SIGUSR1 to the running NanoClaw process.
 * NanoClaw's signal handler (added in src/index.ts) calls the
 * invalidate functions in-process. If NanoClaw isn't running,
 * editing the files takes effect on next start anyway, so this
 * exits successfully with a note.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const PID_FILE = path.join(os.homedir(), '.config', 'nanoclaw', 'nanoclaw.pid');

function main(): void {
  if (!fs.existsSync(PID_FILE)) {
    console.log(
      'nanoclaw-mount-reload: no PID file at',
      PID_FILE,
      '\nNanoClaw is probably not running. Edits take effect on next start.',
    );
    return;
  }
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
  if (Number.isNaN(pid)) {
    console.error('Invalid PID in', PID_FILE);
    process.exit(1);
  }
  try {
    process.kill(pid, 'SIGUSR1');
    console.log('nanoclaw-mount-reload: signalled PID', pid);
  } catch (err) {
    console.error('Failed to signal NanoClaw:', err);
    process.exit(1);
  }
}

main();
