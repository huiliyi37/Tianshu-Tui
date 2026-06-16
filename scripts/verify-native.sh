#!/usr/bin/env bash
# Verify that native-resolver loads better-sqlite3 from dist/native/
# Simulates production environment (no node_modules on resolution path).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f dist/native/better_sqlite3.node ]; then
  echo "❌ dist/native/better_sqlite3.node not found. Run: bash scripts/pack-native.sh" >&2
  exit 1
fi

# Test: load native-resolver from source (tsx) with dist/main.js as moduleUrl
# This proves the native/ path resolution works without node_modules.
node --import tsx --input-type=module -e "
import { resolveBetterSqlite3 } from './src/repo/native-resolver.ts';
import { pathToFileURL } from 'node:url';

const distUrl = pathToFileURL(process.cwd() + '/dist/main.js').href;
const D = resolveBetterSqlite3(distUrl);
if (!D) { console.error('❌ FAIL: resolveBetterSqlite3 returned null'); process.exit(1); }

const db = new D(':memory:');
db.exec('CREATE TABLE t (x INTEGER)');
db.prepare('INSERT INTO t VALUES (?)').run(42);
const row = db.prepare('SELECT x FROM t').get();
if (row.x !== 42) { console.error('❌ FAIL: row.x =', row.x); process.exit(1); }
db.close();
console.log('✅ native-resolver loads from dist/native/ — Database works');
"
