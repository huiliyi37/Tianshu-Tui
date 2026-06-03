/**
 * Extract recordToolHistory and requestThetaCheck from AgentLoop to standalone modules.
 *
 * Usage: npm exec -- tsx scripts/refactor-loop-task45.ts
 */
import { Project, SyntaxKind } from 'ts-morph';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOOP_FILE = path.join(ROOT, 'src/agent/loop.ts');
const HISTORY_FILE = path.join(ROOT, 'src/agent/tool-history-recorder.ts');
const THETA_FILE = path.join(ROOT, 'src/agent/theta-controller.ts');

// ═══════════════════════════════════
// Pass 1: Collect data from AST
// ═══════════════════════════════════
console.log('=== Pass 1: Collect data ===');

const p1 = new Project({ tsConfigFilePath: path.join(ROOT, 'tsconfig.json'), skipAddingFilesFromTsConfig: true });
const sf1 = p1.addSourceFileAtPath(LOOP_FILE);
const agentLoop1 = sf1.getClass('AgentLoop')!;

// ── recordToolHistory ──
const rthMethod = agentLoop1.getMethod('recordToolHistory');
if (!rthMethod) throw new Error('recordToolHistory not found');
const rthBody = rthMethod.getBody()!;
const rthInner = rthBody.getText().slice(1, -1).trim();
const rthSelfBody = rthInner.replace(/\bthis\./g, 'self.');

const rthFields = new Set<string>();
rthBody.forEachDescendant((node: any) => {
  if (node.getKind() === SyntaxKind.PropertyAccessExpression) {
    if (node.getExpression().getKind() === SyntaxKind.ThisKeyword) {
      rthFields.add(node.getName());
    }
  }
});
console.log(`recordToolHistory: ${rthSelfBody.split('\n').length} lines, ${rthFields.size} fields`);

// ── requestThetaCheck ──
const thetaMethod = agentLoop1.getMethod('requestThetaCheck');
if (!thetaMethod) throw new Error('requestThetaCheck not found');
const thetaBody = thetaMethod.getBody()!;
const thetaInner = thetaBody.getText().slice(1, -1).trim();
// Replace this. but NOT AgentLoop. (AgentLoop.THETA_MAX_* are static)
let thetaSelfBody = thetaInner.replace(/\bthis\./g, 'self.');
// Replace AgentLoop.THETA_MAX_* with module-level constants
thetaSelfBody = thetaSelfBody.replace(/AgentLoop\.THETA_MAX_SESSION/g, 'THETA_MAX_SESSION');
thetaSelfBody = thetaSelfBody.replace(/AgentLoop\.THETA_MAX_PER_TURN/g, 'THETA_MAX_PER_TURN');

const thetaFields = new Set<string>();
thetaBody.forEachDescendant((node: any) => {
  if (node.getKind() === SyntaxKind.PropertyAccessExpression) {
    if (node.getExpression().getKind() === SyntaxKind.ThisKeyword) {
      thetaFields.add(node.getName());
    }
  }
});
console.log(`requestThetaCheck: ${thetaSelfBody.split('\n').length} lines, ${thetaFields.size} fields`);

// Collect private ranges for new fields
const allNewFields = new Set([...rthFields, ...thetaFields]);
const newPrivateRanges: { start: number; end: number }[] = [];

const ctor1 = agentLoop1.getConstructors()[0]!;
for (const param of ctor1.getParameters()) {
  if (allNewFields.has(param.getName())) {
    for (const mod of param.getModifiers()) {
      if (mod.getKind() === SyntaxKind.PrivateKeyword) {
        newPrivateRanges.push({ start: mod.getStart(), end: mod.getEnd() + 1 });
      }
    }
  }
}

for (const fieldName of allNewFields) {
  const prop = agentLoop1.getProperty(fieldName);
  if (prop) {
    for (const mod of prop.getModifiers()) {
      if (mod.getKind() === SyntaxKind.PrivateKeyword) {
        newPrivateRanges.push({ start: mod.getStart(), end: mod.getEnd() + 1 });
        break;
      }
    }
  }
  const method = agentLoop1.getMethod(fieldName);
  if (method) {
    for (const mod of method.getModifiers()) {
      if (mod.getKind() === SyntaxKind.PrivateKeyword) {
        newPrivateRanges.push({ start: mod.getStart(), end: mod.getEnd() + 1 });
        break;
      }
    }
  }
}
console.log(`New private ranges: ${newPrivateRanges.length}`);

const thetaMaxSession = agentLoop1.getStaticProperty('THETA_MAX_SESSION');
const thetaMaxPerTurn = agentLoop1.getStaticProperty('THETA_MAX_PER_TURN');
const thetaMaxSessionVal = thetaMaxSession?.getInitializer()?.getText() ?? '40';
const thetaMaxPerTurnVal = thetaMaxPerTurn?.getInitializer()?.getText() ?? '2';

// ═══════════════════════════════════
// Pass 2: Remove private keywords
// ═══════════════════════════════════
console.log('\n=== Pass 2: Remove private keywords ===');
{
  const p2 = new Project({ tsConfigFilePath: path.join(ROOT, 'tsconfig.json'), skipAddingFilesFromTsConfig: true });
  const sf2 = p2.addSourceFileAtPath(LOOP_FILE);
  const edits = [...newPrivateRanges];
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) sf2.replaceText([e.start, e.end], '');
  await sf2.save();
  console.log(`Removed ${edits.length} private keywords`);
}

// ═══════════════════════════════════
// Pass 3: Replace methods + add imports
// ═══════════════════════════════════
console.log('\n=== Pass 3: Replace methods + add imports ===');
{
  const p3 = new Project({ tsConfigFilePath: path.join(ROOT, 'tsconfig.json'), skipAddingFilesFromTsConfig: true });
  const sf3 = p3.addSourceFileAtPath(LOOP_FILE);
  const agentLoop3 = sf3.getClass('AgentLoop')!;

  const rth = agentLoop3.getMethod('recordToolHistory')!;
  const rthParams = rth.getParameters().map((p: any) => p.getName()).join(', ');
  rth.setBodyText(`recordToolHistory(this, ${rthParams});`);

  const theta = agentLoop3.getMethod('requestThetaCheck')!;
  const thetaParams = theta.getParameters().map((p: any) => p.getName()).join(', ');
  theta.setBodyText(`requestThetaCheck(this, ${thetaParams});`);

  // Replace AgentLoop.THETA_MAX_* in the new body
  const thetaNewBody = theta.getBody()!;
  thetaNewBody.forEachDescendant((node: any) => {
    if (node.getKind() === SyntaxKind.PropertyAccessExpression) {
      if (node.getText() === 'AgentLoop.THETA_MAX_SESSION') {
        node.replaceWithText('THETA_MAX_SESSION');
      }
      if (node.getText() === 'AgentLoop.THETA_MAX_PER_TURN') {
        node.replaceWithText('THETA_MAX_PER_TURN');
      }
    }
  });

  const importDecs = sf3.getImportDeclarations();
  const loopTypesImport = importDecs.find(d => d.getModuleSpecifierValue() === './loop-types.js');
  if (loopTypesImport) {
    const idx = importDecs.indexOf(loopTypesImport);
    sf3.insertImportDeclaration(idx + 1, {
      namedImports: ['recordToolHistory'],
      moduleSpecifier: './tool-history-recorder.js',
    });
    sf3.insertImportDeclaration(idx + 2, {
      namedImports: ['requestThetaCheck'],
      moduleSpecifier: './theta-controller.js',
    });
  }

  await sf3.save();
  console.log('Replaced methods, added imports');
}

// ═══════════════════════════════════
// Pass 4: Build extracted files
// ═══════════════════════════════════
console.log('\n=== Pass 4: Build extracted files ===');

const historyContent = `import type { AgentLoop } from './loop.js'
import type { HealthSignal } from './trajectory-health.js'

/**
 * Record tool execution history and trigger deferred post-tool processing.
 * Extracted from AgentLoop.recordToolHistory.
 */
export function recordToolHistory(
  self: AgentLoop,
  name: string,
  input: Record<string, unknown>,
  isError: boolean,
  result: string,
): void {
${rthSelfBody}
}
`;
fs.writeFileSync(HISTORY_FILE, historyContent);
console.log(`Written: ${HISTORY_FILE} (${historyContent.split('\n').length} lines)`);

const thetaContent = `import type { AgentLoop } from './loop.js'
import { runThetaCheck } from './theta-check.js'

export const THETA_MAX_SESSION = ${thetaMaxSessionVal};
export const THETA_MAX_PER_TURN = ${thetaMaxPerTurnVal};

/**
 * Request a theta (typecheck) check with gating and backoff.
 * Extracted from AgentLoop.requestThetaCheck.
 */
export function requestThetaCheck(
  self: AgentLoop,
  reason: string,
): void {
${thetaSelfBody}
}
`;
fs.writeFileSync(THETA_FILE, thetaContent);
console.log(`Written: ${THETA_FILE} (${thetaContent.split('\n').length} lines)`);

console.log('\nDone. Run npx tsc --noEmit to verify.');
