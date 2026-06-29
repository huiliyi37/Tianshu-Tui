#!/usr/bin/env node
// codesign-nested.js — Developer ID sign the nested Mach-O binaries that Tauri
// does NOT sign automatically.
//
// Why this exists: Tauri v2 only auto-signs nested code in standard bundle
// locations (Contents/MacOS, Frameworks, PlugIns, XPCServices, Helpers — see
// tauri-apps/tauri#8259). 天枢 ships its runtime under Contents/Resources:
//   - the bundled Node.js binary (resources/node/<os>-<arch>/node)
//   - better_sqlite3.node and other .node addons (dist/native, dist/node_modules)
//   - the esbuild Go binary (dist/node_modules/@esbuild/.../bin/esbuild)
// Apple notarization rejects any unsigned Mach-O anywhere in the bundle, so we
// must sign these ourselves. Signatures travel with the file when Tauri copies
// the resource into the .app, so we sign the SOURCE files here (in
// beforeBuildCommand, right before `tauri build` assembles the bundle).
//
// Gated on APPLE_SIGNING_IDENTITY: with no identity this is a no-op, so the
// normal unsigned build path is unaffected.

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, '..');
const repoRoot = resolve(desktopDir, '..');

const identity = process.env.APPLE_SIGNING_IDENTITY;
if (!identity) {
  console.log('[codesign-nested] APPLE_SIGNING_IDENTITY 未设置 → 跳过(未签名构建)。');
  process.exit(0);
}

if (process.platform !== 'darwin') {
  console.log('[codesign-nested] 非 macOS → 跳过。');
  process.exit(0);
}

const entitlements = join(desktopDir, 'src-tauri', 'entitlements.plist');

// Mach-O magic numbers (thin + universal/fat, both endiannesses).
const MACHO_MAGICS = new Set([
  0xfeedface, // 32-bit
  0xfeedfacf, // 64-bit
  0xcefaedfe, // 32-bit, byte-swapped
  0xcffaedfe, // 64-bit, byte-swapped
  0xcafebabe, // fat (universal)
  0xbebafeca, // fat, byte-swapped
]);

function isMachO(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(4);
    const n = readSync(fd, buf, 0, 4, 0);
    if (n < 4) return false;
    return MACHO_MAGICS.has(buf.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      walk(full, out);
    } else if (ent.isFile()) {
      out.push(full);
    }
  }
}

const roots = [
  join(repoRoot, 'dist'),
  join(desktopDir, 'src-tauri', 'resources', 'node'),
];

const candidates = [];
for (const root of roots) {
  try {
    statSync(root);
  } catch {
    console.log(`[codesign-nested] 跳过不存在的目录：${root}`);
    continue;
  }
  walk(root, candidates);
}

const binaries = candidates.filter(isMachO);

if (binaries.length === 0) {
  console.error('[codesign-nested] ✗ 未在 dist/ 与 resources/node 找到任何 Mach-O。');
  console.error('  期望至少有 Node 运行时与 better_sqlite3.node。请确认 stage/fetch 步骤已执行。');
  process.exit(1);
}

console.log(`[codesign-nested] 用 "${identity}" 签名 ${binaries.length} 个嵌套 Mach-O…`);
for (const bin of binaries) {
  try {
    execFileSync(
      'codesign',
      [
        '--force',
        '--timestamp',
        '--options', 'runtime',
        '--entitlements', entitlements,
        '--sign', identity,
        bin,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] }
    );
    console.log(`  ✓ ${bin.replace(repoRoot + '/', '')}`);
  } catch (err) {
    console.error(`[codesign-nested] ✗ 签名失败：${bin}`);
    throw err;
  }
}
console.log('[codesign-nested] ✓ 嵌套二进制全部签名完成。');
