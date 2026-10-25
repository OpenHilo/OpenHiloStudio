import { isJsonValue, type JsonObject } from '@openhilo/ai-contracts';
import * as fs from 'fs';
import * as path from 'path';
import { migrateDataCopy, type MigrationReport } from './data-migration';

const FORMAT = 'intentorch.deployment';
/** Legacy field ownership is supplied by the deployment that originally owned it. */
export interface DeploymentCompatibility {
  domain?: { id: string; fields: readonly string[] };
  implementation?: { id: string; fields: readonly string[] };
  defaultApplication?: JsonObject;
  defaultExecution?: JsonObject;
  fallbacks?: Readonly<Record<string, { from: string; archiveKey: string }>>;
}
export interface DeploymentConfig extends JsonObject {
  format: 'intentorch.deployment';
  version: 1;
  core: JsonObject;
  domain: JsonObject;
  ai: JsonObject;
  legacy: JsonObject;
}
export class DeploymentConfigError extends Error {
  constructor(message: string) { super(`deployment configuration: ${message}`); this.name = 'DeploymentConfigError'; }
}
function object(value: unknown, at: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !isJsonValue(value)) throw new DeploymentConfigError(`${at} must be a JSON object`);
  return value as JsonObject;
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function isDeploymentConfig(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).format === FORMAT;
}
function legacyRecord(raw: unknown): JsonObject {
  const record = object(raw, 'configuration');
  if (typeof record.format === 'string' && record.format.startsWith('intentorch.')) throw new DeploymentConfigError('unsupported format');
  return object(record.defaults ?? record, 'defaults');
}
/** Create a codec without importing or guessing an application's business policy. */
export function createDeploymentConfigCodec(options: DeploymentCompatibility = {}) {
  const policy = clone(options);
  const nativeFields = policy.implementation?.fields ?? [];
  const domainFields = policy.domain?.fields ?? [];
  const fallbacks = policy.fallbacks ?? {};
  const fields = [...nativeFields, ...domainFields, ...Object.values(fallbacks).map(value => value.from), 'application', 'ai_execution'];
  if (new Set(fields).size !== fields.length) throw new DeploymentConfigError('compatibility fields must have unique owners');
  for (const group of [policy.domain, policy.implementation]) {
    if (group && (!group.id || ['__proto__', 'constructor', 'prototype'].includes(group.id))) throw new DeploymentConfigError('invalid compatibility namespace');
  }
  for (const field of [...fields, ...Object.values(fallbacks).map(value => value.archiveKey)]) {
    if (!field || ['__proto__', 'constructor', 'prototype'].includes(field)) throw new DeploymentConfigError('invalid compatibility field');
  }
  for (const field of Object.keys(fallbacks)) if (!nativeFields.includes(field) && !domainFields.includes(field)) throw new DeploymentConfigError('fallback must reference an owned field');
  const ownedFields = new Set(fields);
  const selection = (value: unknown, fallback: JsonObject | undefined, label: string): JsonObject => {
    if (value === undefined && fallback === undefined) throw new DeploymentConfigError(`${label} must be selected explicitly`);
    return object(value === undefined ? fallback : value, label);
  };
  /** Structural envelope validation; selected deployments still validate their own provider/policy schemas. */
  function parseDeploymentConfig(raw: unknown): DeploymentConfig {
    const root = object(raw, 'configuration');
    if (root.format !== FORMAT || root.version !== 1) throw new DeploymentConfigError('unsupported format or version');
    const core = object(root.core, 'core'), domain = object(root.domain, 'domain'), ai = object(root.ai, 'ai');
    object(root.legacy, 'legacy');
    const retained = object(core.legacyFields, 'core.legacyFields');
    if (Object.keys(retained).some(key => ownedFields.has(key))) throw new DeploymentConfigError('legacy fields duplicate a domain or AI setting');
    object(domain.selection, 'domain.selection');
    const applications = object(domain.applications, 'domain.applications');
    for (const value of Object.values(applications)) object(value, 'domain application');
    object(ai.execution, 'ai.execution');
    const implementations = object(ai.implementations, 'ai.implementations');
    for (const value of Object.values(implementations)) object(value, 'AI implementation');
    return clone(root) as DeploymentConfig;
  }

  /** Preserve effective legacy values and inactive wrapper data without reading credentials or paths. */
  function toDeploymentConfig(raw: unknown): DeploymentConfig {
    if (isDeploymentConfig(raw)) return parseDeploymentConfig(raw);
    const root = object(raw, 'configuration'), source = legacyRecord(raw);
    const native: JsonObject = {};
    for (const field of nativeFields) if (Object.hasOwn(source, field)) native[field] = clone(source[field]);
    const domain: JsonObject = {};
    for (const field of domainFields) if (Object.hasOwn(source, field)) domain[field] = clone(source[field]);
    for (const [field, fallback] of Object.entries(fallbacks)) {
      if (source[field] == null && Object.hasOwn(source, fallback.from)) (nativeFields.includes(field) ? native : domain)[field] = clone(source[fallback.from]);
    }
    const application = selection(source.application, policy.defaultApplication, 'application');
    const execution = selection(source.ai_execution, policy.defaultExecution, 'AI execution');
    const legacy: JsonObject = {};
    if (root.defaults !== undefined && root.defaults !== null) legacy.wrapper = Object.fromEntries(Object.entries(root).filter(([key]) => key !== 'defaults'));
    for (const fallback of Object.values(fallbacks)) if (Object.hasOwn(source, fallback.from)) legacy[fallback.archiveKey] = clone(source[fallback.from]);
    return parseDeploymentConfig({ format: FORMAT, version: 1,
      core: { legacyFields: Object.fromEntries(Object.entries(source).filter(([key]) => !ownedFields.has(key))) },
      domain: { selection: application, applications: policy.domain ? { [policy.domain.id]: domain } : {} },
      ai: { execution, implementations: policy.implementation ? { [policy.implementation.id]: native } : {} }, legacy,
    });
  }

  /** Compatibility projection, never a public HTTP projection: it may contain private adapter values. */
  function readCompatibleConfig(raw: unknown): Record<string, unknown> {
    if (!isDeploymentConfig(raw)) {
      // In-memory compatibility configurations can contain undefined optional fields.
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DeploymentConfigError('configuration must be an object');
      const root = raw as Record<string, unknown>;
      if (typeof root.format === 'string' && root.format.startsWith('intentorch.')) throw new DeploymentConfigError('unsupported format');
      const source = root.defaults ?? root;
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw new DeploymentConfigError('defaults must be an object');
      return { ...source };
    }
    const config = parseDeploymentConfig(raw);
    const applications = config.domain.applications as JsonObject, implementations = config.ai.implementations as JsonObject;
    const native = (policy.implementation ? implementations[policy.implementation.id] ?? {} : {}) as JsonObject;
    const domain = (policy.domain ? applications[policy.domain.id] ?? {} : {}) as JsonObject;
    return { ...(config.core.legacyFields as JsonObject),
      ...Object.fromEntries(nativeFields.filter(key => Object.hasOwn(native, key)).map(key => [key, native[key]])),
      application: config.domain.selection, ai_execution: config.ai.execution,
      ...Object.fromEntries(domainFields.filter(key => Object.hasOwn(domain, key)).map(key => [key, domain[key]])),
    };
  }

  /** Retain storage shape and unknown namespaces while applying a validated compatibility patch. */
  function writeCompatibleConfig(original: unknown, updated: object, patch: object): object {
    const normalized = updated as Record<string, unknown>;
    if (!isDeploymentConfig(original)) {
      const root = object(clone(original), 'configuration'); legacyRecord(root);
      const effective = { ...normalized, ...Object.fromEntries(Object.entries(readCompatibleConfig(root)).filter(([key]) => !Object.hasOwn(normalized, key))) };
      return root.defaults !== undefined && root.defaults !== null ? { ...root, defaults: effective } : effective;
    }
    const config = parseDeploymentConfig(original);
    const applications = config.domain.applications as JsonObject, implementations = config.ai.implementations as JsonObject;
    for (const key of Object.keys(patch)) {
      let target: JsonObject, field = key;
      if (key === 'application') { target = config.domain; field = 'selection'; }
      else if (key === 'ai_execution') { target = config.ai; field = 'execution'; }
      else if (domainFields.includes(key)) target = (applications[policy.domain!.id] ??= {}) as JsonObject;
      else if (nativeFields.includes(key)) target = (implementations[policy.implementation!.id] ??= {}) as JsonObject;
      else target = config.core.legacyFields as JsonObject;
      const value = normalized[key];
      if (value === undefined) {
        // Clearing a legacy optional selector preserves its original default explicitly in the new format.
        if (key === 'ai_execution') target[field] = clone(selection(undefined, policy.defaultExecution, 'AI execution'));
        else if (key === 'application') target[field] = clone(selection(undefined, policy.defaultApplication, 'application'));
        else delete target[field];
      } else {
        if (!isJsonValue(value)) throw new DeploymentConfigError('updated field must be JSON serializable');
        Object.defineProperty(target, field, { value: clone(value), enumerable: true, writable: true, configurable: true });
      }
    }
    return parseDeploymentConfig(config);
  }

  function migrateConfigurationCopy(options: { sourceDir: string; bundleDir: string }): Promise<MigrationReport> {
    return migrateDataCopy({ ...options, steps: [{ id: 'platform.configuration-namespaces', version: 1,
      apply(dataDir) {
        const file = path.join(dataDir, 'config.json');
        const converted = toDeploymentConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
        fs.writeFileSync(file, JSON.stringify(converted, null, 2) + '\n');
        fs.chmodSync(file, 0o600);
      },
    }] });
  }

  return { parseDeploymentConfig, toDeploymentConfig, readCompatibleConfig, writeCompatibleConfig, migrateConfigurationCopy };
}

export const { parseDeploymentConfig, toDeploymentConfig, readCompatibleConfig, writeCompatibleConfig, migrateConfigurationCopy } = createDeploymentConfigCodec();
