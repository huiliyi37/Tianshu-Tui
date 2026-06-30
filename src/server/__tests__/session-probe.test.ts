// Probe test: find session log files for "mr0aziel"
import { describe, it } from 'node:test';
import { deepStrictEqual } from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const sessionsDir = join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Local'), '.rivet', 'sessions');

describe('session probe', () => {
  it('finds mr0aziel session', () => {
    const slug = 'Tianshu-Tui-' + createHash('sha256').update('D:\\Tianshu-Tui').digest('hex').slice(0, 6);
    const slugDir = join(sessionsDir, slug);

    console.log('sessionsDir:', sessionsDir);
    console.log('sessionsDir exists:', existsSync(sessionsDir));
    console.log('slug:', slug);
    console.log('slugDir exists:', existsSync(slugDir));

    if (existsSync(sessionsDir)) {
      const dirs = readdirSync(sessionsDir);
      console.log('Top-level entries:', dirs);
    }

    if (existsSync(slugDir)) {
      const files = readdirSync(slugDir);
      console.log('Session files:', files);
      const match = files.filter(f => f.includes('mr0aziel'));
      console.log('Matching files:', match);
      for (const f of match) {
        const content = readFileSync(join(slugDir, f), 'utf8');
        console.log('File:', f, 'size:', content.length);
      }
    }

    deepStrictEqual(true, true);
  });
});
