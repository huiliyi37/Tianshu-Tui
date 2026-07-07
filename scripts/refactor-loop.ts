/**
 * Multi-pass AST refactoring for loop.ts → loop-factory.ts extraction.
 *
 * Usage: npm exec -- tsx scripts/refactor-loop.ts
 */
import { Project, SyntaxKind } from 'ts-morph';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOOP_FILE = path.join(ROOT, 'src/agent/loop.ts');
const FACTORY_FILE = path.join(ROOT, 'src/agent/loop-factory.ts');

const factoryMethodNames = [
  'createTurnStreamController',
  'createTurnCompletionController',
  'createToolExecutionController',
  'buildRuntimeSnapshot',
];

// ═══════════════════════════════════
// Pass 1: Collect all data from AST
// ═══════════════════════════════════
console.log('=== Pass 1: Collect data ===');

const p1 = new Project({ tsConfigFilePath: path.join(ROOT, 'tsconfig.json'), skipAddingFilesFromTsConfig: true });
const sf1 = p1.addSourceFileAtPath(LOOP_FILE);
const agentLoop1 = sf1.getClass('AgentLoop')!;
const ctor1 = agentLoop1.getConstructors()[0]!;

const accessedFields = new Set<string>();
const methodBodies = new Map<string, string>();
const methodReplacements = new Map<string, string>();

for (const name of factoryMethodNames) {
  const method = agentLoop1.getMethod(name);
  if (!method) continue;
  const body = method.getBody();
  if (!body) continue;
  body.forEachDescendant((node: any) => {
    if (node.getKind() === SyntaxKind.PropertyAccessExpression) {
      if (node.getExpression().getKind() === SyntaxKind.ThisKeyword) {
        accessedFields.add(node.getName());
      }
    }
  });
  const inner = body.getText().slice(1, -1).trim();
  methodBodies.set(name, inner.replace(/\bthis\./g, 'self.'));
  const params = method.getParameters().map((p: any) => p.getName());
  const callArgs = ['this', ...params].join(', ');
  if (name === 'buildRuntimeSnapshot')
    methodReplacements.set(name, `return buildRuntimeSnapshot(${callArgs});`);
  else if (name === 'createTurnCompletionController')
    methodReplacements.set(name, `return createTurnCompletionController(${callArgs});`);
  else
    methodReplacements.set(name, `return ${name}(${callArgs});`);
  console.log(`  ${name}: ${methodBodies.get(name)!.split('\n').length} body lines`);
}

interface Range { start: number; end: number }
const ctorPrivateRanges: { name: string; range: Range; type: string }[] = [];
for (const param of ctor1.getParameters()) {
  if (accessedFields.has(param.getName())) {
    for (const mod of param.getModifiers()) {
      if (mod.getKind() === SyntaxKind.PrivateKeyword) {
        ctorPrivateRanges.push({
          name: param.getName(), type: param.getTypeNode()?.getText() ?? 'any',
          range: { start: mod.getStart(), end: mod.getEnd() + 1 },
        });
      }
    }
  }
}

const propPrivateRanges: Range[] = [];
for (const fieldName of accessedFields) {
  const prop = agentLoop1.getProperty(fieldName);
  if (prop) {
    for (const mod of prop.getModifiers()) {
      if (mod.getKind() === SyntaxKind.PrivateKeyword) {
        propPrivateRanges.push({ start: mod.getStart(), end: mod.getEnd() + 1 });
        break;
      }
    }
  }
  // Also check methods (accessedFields includes method names too)
  const method = agentLoop1.getMethod(fieldName);
  if (method) {
    for (const mod of method.getModifiers()) {
      if (mod.getKind() === SyntaxKind.PrivateKeyword) {
        propPrivateRanges.push({ start: mod.getStart(), end: mod.getEnd() + 1 });
        break;
      }
    }
  }
}
console.log(`Fields: ${accessedFields.size}, ctor-private: ${ctorPrivateRanges.length}, prop-private: ${propPrivateRanges.length}`);

// ═══════════════════════════════════
// Pass 2a: Remove private keywords (text edits only, then save)
// ═══════════════════════════════════
console.log('\n=== Pass 2a: Remove private keywords ===');

{
  const p2 = new Project({ tsConfigFilePath: path.join(ROOT, 'tsconfig.json'), skipAddingFilesFromTsConfig: true });
  const sf2 = p2.addSourceFileAtPath(LOOP_FILE);
  const edits = [...ctorPrivateRanges.map(r => r.range), ...propPrivateRanges];
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) sf2.replaceText([e.start, e.end], '');
  await sf2.save();
  console.log(`Removed ${edits.length} private keywords`);
}

// ═══════════════════════════════════
// Pass 2b: Add property declarations + constructor assignments for converted ctor params
// ═══════════════════════════════════
console.log('\n=== Pass 2b: Add property declarations + ctor assignments ===');

{
  const p2b = new Project({ tsConfigFilePath: path.join(ROOT, 'tsconfig.json'), skipAddingFilesFromTsConfig: true });
  const sf2b = p2b.addSourceFileAtPath(LOOP_FILE);
  const agentLoop2b = sf2b.getClass('AgentLoop')!;
  const ctor2b = agentLoop2b.getConstructors()[0]!;

  for (const cpr of ctorPrivateRanges) {
    const prop = agentLoop2b.insertProperty(0, { name: cpr.name, type: cpr.type });
    prop.setHasExclamationToken(true);
    console.log(`  Added property: ${cpr.name}!: ${cpr.type}`);
  }

  // Insert this.config = config; this.session = session; at start of constructor body
  const ctorBody = ctor2b.getBody();
  if (ctorBody) {
    const stmts = ctorBody.getStatements();
    if (stmts.length > 0) {
      const firstStmt = stmts[0]!;
      const assignText = ctorPrivateRanges.map(r => `this.${r.name} = ${r.name};`).join(' ');
      ctorBody.insertStatements(0, assignText);
      console.log(`  Inserted ctor assignments: ${assignText}`);
    }
  }

  await sf2b.save();
}

// ═══════════════════════════════════
// Pass 3: Replace method bodies + add import
// ═══════════════════════════════════
console.log('\n=== Pass 3: Replace methods + import ===');

{
  const p3 = new Project({ tsConfigFilePath: path.join(ROOT, 'tsconfig.json'), skipAddingFilesFromTsConfig: true });
  const sf3 = p3.addSourceFileAtPath(LOOP_FILE);
  const agentLoop3 = sf3.getClass('AgentLoop')!;

  for (const name of factoryMethodNames) {
    const method = agentLoop3.getMethod(name);
    if (!method) continue;
    method.setBodyText(methodReplacements.get(name)!);
    console.log(`  ${name} → delegation`);
  }

  const importDecs = sf3.getImportDeclarations();
  const loopTypesImport = importDecs.find(d => d.getModuleSpecifierValue() === './loop-types.js');
  if (loopTypesImport) {
    sf3.insertImportDeclaration(importDecs.indexOf(loopTypesImport) + 1, {
      namedImports: factoryMethodNames,
      moduleSpecifier: './loop-factory.js',
    });
    console.log('  Added import');
  }
  await sf3.save();
  console.log(`Written: ${LOOP_FILE}`);
}

// ═══════════════════════════════════
// Pass 4: Build loop-factory.ts
// ═══════════════════════════════════
console.log('\n=== Pass 4: Build loop-factory.ts ===');

const factoryFuncs: string[] = [];
const specs: [string, string, string][] = [
  ['createTurnStreamController', 'TurnStreamController', ''],
  ['createTurnCompletionController', 'TurnCompletionController', ', callbacks?: AgentCallbacks'],
  ['createToolExecutionController', 'ToolExecutionController', ''],
  ['buildRuntimeSnapshot', 'RuntimeHookSnapshot', ', extra?: Partial<RuntimeHookSnapshot>'],
];
for (const [name, returnType, extraParams] of specs) {
  const bodyText = methodBodies.get(name);
  if (!bodyText) continue;
  factoryFuncs.push(`export function ${name}(self: AgentLoop${extraParams}): ${returnType} {
${bodyText}
}`);
}

const factoryContent = `import type { AgentLoop } from './loop.js'
import { TurnStreamController } from './turn-stream.js'
import { TurnCompletionController } from './turn-completion.js'
import { ToolExecutionController } from './tool-execution.js'
import type { RuntimeHookSnapshot } from './runtime-hooks.js'
import { createRuntimeHookContext } from './runtime-hooks.js'
import { buildPrewarmValue } from './prewarm-file.js'
import { join } from 'node:path'
import type { AgentCallbacks } from './loop-types.js'

${factoryFuncs.join('\n')}
`;

fs.writeFileSync(FACTORY_FILE, factoryContent);
console.log(`Written: ${FACTORY_FILE} (${factoryContent.split('\n').length} lines)`);
console.log('\nDone. Run npx tsc --noEmit to verify.');
