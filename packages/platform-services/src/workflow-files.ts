/** Filesystem adapter for the historical namespace/workflow artifact layout. */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as ts from 'typescript';
import { compileMultiIntent, buildFunctionRegistry, type MultiIntentResult } from '@openhilo/compiler/multi-intent-compiler';
import { platformSystemMethods } from './compiler-capabilities';
import { getEntryTag } from '@openhilo/compiler/multi-intent-compiler';
import { buildImportMap } from '@openhilo/compiler/import-resolver';
import type { CFGITT, LeafITT, ValueType } from '@openhilo/itt-contracts';
import type { CallDeclaration, AIPrefixParams, HumanPrefixParams, CodePrefixParams } from '@openhilo/compiler/ts-validator';
import type { FunctionSignature } from '@openhilo/compiler/ast-to-itt';
import type { GenerationPreflightOptions } from './generation-ports';

export interface SplitIntent {
  name: string;
  namespace: string;
  leafItt: LeafITT;
  implItt: CFGITT;
  sourceTs: string;  // single-function TS extracted from session
}

export interface SessionSplitResult {
  namespace: string;
  entry: string | null;
  intents: SplitIntent[];
}

function formatDatetime(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function extractFunctionSource(source: string, fnName: string): string {
  const sf = ts.createSourceFile('s.ts', source, ts.ScriptTarget.Latest, true);
  for (const stmt of sf.statements) {
    if (!ts.isFunctionDeclaration(stmt)) continue;
    if (stmt.name?.text !== fnName) continue;
    return source.slice(stmt.getFullStart(), stmt.getEnd()).trim();
  }
  return '';
}

function sha256(content: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
}

/** Build a CallDeclaration from an async function signature using executor-suffix rules. */
function signatureToCallDecl(
  fnName: string,
  sig: FunctionSignature,
  qualifiedCallee: string,
): CallDeclaration {
  if (fnName.endsWith('_by_ai')) {
    const hasConstraints = sig.params.length >= 3 && sig.params[2]?.name === 'constraints';
    const prefixCount = hasConstraints ? 3 : 2;
    const businessParams = sig.params.slice(prefixCount);
    const hasSkills = businessParams.length > 0 && businessParams[businessParams.length - 1].name === 'skills';
    const inputs = hasSkills ? businessParams.slice(0, -1) : businessParams;
    return { fnName, executor: 'ai', callee: qualifiedCallee, prefixCount,
             prefixParams: { role: '', prompt: '' } as AIPrefixParams, inputs, outputs: sig.outputs };
  }
  if (fnName.endsWith('_by_human')) {
    const hasConstraints = sig.params.length >= 2 && sig.params[1]?.name === 'constraints';
    const prefixCount = hasConstraints ? 2 : 1;
    return { fnName, executor: 'human', callee: qualifiedCallee, prefixCount,
             prefixParams: { prompt: '' } as HumanPrefixParams,
             inputs: sig.params.slice(prefixCount), outputs: sig.outputs };
  }
  if (fnName.endsWith('_by_code')) {
    // New format: (lang, script, inputs?: { ... })
    // Always prefixCount=2; inputs parsed from object literal at call site (ast-to-itt)
    return { fnName, executor: 'code', callee: qualifiedCallee, prefixCount: 2,
             prefixParams: { lang: 'bash' } as CodePrefixParams,
             inputs: [], outputs: sig.outputs };
  }
  return { fnName, executor: 'intent', callee: qualifiedCallee, prefixCount: 0,
           prefixParams: {} as AIPrefixParams, inputs: sig.params, outputs: sig.outputs };
}

/** Generate a .itt.json leaf for a placeholder executor-suffix intent. */
function generatePlaceholderItt(
  intentName: string,
  namespace: string,
  decl: CallDeclaration,
  ittPath: string,
): void {
  const inputsSchema = Object.fromEntries(decl.inputs.map(input => [input.name, { kind: input.kind }]));
  const outputsSchema = Object.fromEntries(decl.outputs.map(output => [output.name, output.kind]));
  const leaf: LeafITT = {
    version: 2, name: intentName, namespace,
    executor: decl.executor as 'ai' | 'human' | 'intent',
    inputs: inputsSchema, outputs: outputsSchema, nodes: {}, entry: intentName,
  };
  fs.writeFileSync(ittPath, JSON.stringify(leaf, null, 2));
}

/**
 * Build extraDeclarations for all imported names by reading Brain files.
 * For _by_* imports: reads placeholder .ts → extracts signature → generates .itt.json if missing.
 * For regular intent imports: reads .itt.json for inputs/outputs.
 */
function buildExtraDeclarations(
  source: string,
  nsPath: string,
  brainDir: string,
  intentsDir: string,
): CallDeclaration[] {
  const importMap = buildImportMap(source, nsPath);
  const extraDecls: CallDeclaration[] = [];

  for (const [localName, qualifiedCallee] of importMap) {
    const parts = qualifiedCallee.split('.');
    const intentName = parts[parts.length - 1];
    const namespace = parts.slice(0, -1).join('.');

    const isExecutorPlaceholder = ['_by_ai', '_by_human', '_by_code'].some(s => intentName.endsWith(s));

    if (isExecutorPlaceholder) {
      // Find placeholder .ts in Brain (AI should have written it alongside the session)
      let tsSource: string | null = null;
      let ittDir: string | null = null;
      const nsSegments = namespace ? namespace.split('.') : [];
      const tsPath = path.join(brainDir, ...nsSegments, `${intentName}.ts`);
      if (fs.existsSync(tsPath)) {
        tsSource = fs.readFileSync(tsPath, 'utf-8');
        ittDir = path.join(intentsDir, ...nsSegments, intentName);
      }

      if (!tsSource || !ittDir) {
        console.warn(`[session-splitter] placeholder .ts not found: ${qualifiedCallee} — skipping`);
        continue;
      }

      // Parse signature from the placeholder async function
      const reg = buildFunctionRegistry(tsSource);
      const sig = reg.get(intentName);
      if (!sig) continue;

      const decl = signatureToCallDecl(intentName, sig, qualifiedCallee);

      // Generate .itt.json if it doesn't exist yet
      const ittPath = path.join(ittDir, `${intentName}.itt.json`);
      if (!fs.existsSync(ittPath)) {
        fs.mkdirSync(ittDir, { recursive: true });
        generatePlaceholderItt(intentName, namespace, decl, ittPath);
      }

      extraDecls.push(decl);
    } else {
      // Regular intent: read .itt.json for inputs/outputs
      const nsSegs = namespace ? namespace.split('.') : [];
      const leafPath = path.join(intentsDir, ...nsSegs, intentName, `${intentName}.itt.json`);
      if (fs.existsSync(leafPath)) {
        const leaf = JSON.parse(fs.readFileSync(leafPath, 'utf-8')) as LeafITT;
        const inputs = Object.entries(leaf.inputs ?? {}).map(([name, v]) => ({
          name, kind: (v as { kind: ValueType }).kind,
        }));
        const outputs = Object.entries(leaf.outputs ?? {}).map(([name, kind]) => ({
          name, kind: kind as ValueType,
        }));
        extraDecls.push({
          fnName: localName,
          executor: 'intent',
          callee: qualifiedCallee,
          prefixCount: 0,
          prefixParams: {} as AIPrefixParams,
          inputs,
          outputs,
        });
      }
    }
  }

  return extraDecls;
}

export interface SplitOptions extends GenerationPreflightOptions {
  writeSources?: boolean;
  /** Application validation is injected; the default compiler has no business tags. */
  compile?: (source: string, namespace: string, declarations: CallDeclaration[], options: SplitOptions) => MultiIntentResult;
}

export function splitSession(
  source: string,
  brainDir: string,
  intentsDir: string,
  nsPath: string,
  options: SplitOptions = {},
): SessionSplitResult {
  if (!nsPath) return { namespace: '', entry: null, intents: [] };

  // Detect @entry async functions (exported with @entry tag)
  const sf = ts.createSourceFile('session.ts', source, ts.ScriptTarget.Latest, true);
  const entrySet = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isFunctionDeclaration(stmt)) continue;
    if (!stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) continue;
    const name = stmt.name?.text;
    if (!name) continue;
    const isPublic = stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (isPublic && getEntryTag(stmt, sf)) entrySet.add(name);
  }

  // Build extra declarations from imported Brain files
  const extraDeclarations = buildExtraDeclarations(source, nsPath, brainDir, intentsDir);

  // Compile the full session
  const compiled = options.compile
    ? options.compile(source, nsPath, extraDeclarations, options)
    : compileMultiIntent(source, nsPath, extraDeclarations, { systemMethods: platformSystemMethods });

  const results: SplitIntent[] = [];
  for (const intent of compiled.intents) {
    const fnSource = extractFunctionSource(source, intent.name);
    const sourceTsHash = sha256(fnSource);
    const implWithHash: CFGITT = { ...intent.implementation, sourceTs: sourceTsHash } as any;
    results.push({
      name: intent.name,
      namespace: nsPath,
      leafItt: intent.declaration,
      implItt: implWithHash,
      sourceTs: fnSource,
    });
  }

  const entry = entrySet.size > 0 ? Array.from(entrySet)[0] : null;

  // Write files
  const nsSegsBrain = nsPath ? nsPath.split('.') : [];
  const brainNsDir = path.join(brainDir, ...nsSegsBrain);
  fs.mkdirSync(brainNsDir, { recursive: true });

  for (const intent of results) {
    // Write .ts source to brain/<ns>/
    if (options.writeSources !== false) fs.writeFileSync(path.join(brainNsDir, `${intent.name}.ts`), intent.sourceTs, 'utf-8');
    // Write JSON to intents/<ns>/<intentName>/
    const intentDir = nsPath
      ? path.join(intentsDir, ...nsPath.split('.'), intent.name)
      : path.join(intentsDir, intent.name);
    fs.mkdirSync(intentDir, { recursive: true });
    fs.writeFileSync(
      path.join(intentDir, `${intent.name}.itt.json`),
      JSON.stringify({ ...intent.leafItt, sourceTs: (intent.implItt as any).sourceTs }, null, 2),
    );
    fs.writeFileSync(
      path.join(intentDir, `${intent.name}.itt.impl.json`),
      JSON.stringify(intent.implItt, null, 2),
    );
  }

  // Write session backup to brain/<ns>/
  const sessionFile = path.join(brainNsDir, `_session_${formatDatetime()}.ts`);
  if (options.writeSources !== false) fs.writeFileSync(sessionFile, source, 'utf-8');
  // No _index.json in flat layout

  return { namespace: nsPath, entry, intents: results };
}
