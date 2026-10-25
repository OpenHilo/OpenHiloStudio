// Generic SQLite storage: application definitions are installed explicitly.
import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import { FailableError } from '@openhilo/runtime-contracts';
import { isJsonValue } from '@openhilo/ai-contracts';

export class EntityReadError extends Error {
  readonly statusCode = 500;
}

function storedRecord(raw: string, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    record(value, label);
    return value as Record<string, unknown>;
  } catch {
    throw new EntityReadError(`${label} is unreadable. Stored data was not changed; restore it from a valid backup before editing.`);
  }
}

export class EntityValidationError extends FailableError {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message); this.name = 'EntityValidationError';
    Object.setPrototypeOf(this, EntityValidationError.prototype);
  }
}

function record(value: unknown, label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !isJsonValue(value)) {
    throw new EntityValidationError(`${label} must be a JSON object without lossy values`);
  }
}
function text(value: unknown, label: string): void {
  if (typeof value !== 'string' || !value.length) throw new EntityValidationError(`${label} must be a nonempty string`);
}
function tagsRecord(value: unknown): void {
  record(value, 'tags');
  if (Object.values(value as Record<string, unknown>).some(item => typeof item !== 'string')) throw new EntityValidationError('Tag values must be strings');
}

export class CasConflictError extends FailableError {
  constructor(entityId: string, expected: number) {
    super(`CAS conflict on entity '${entityId}': expected version ${expected}`);
    this.name = 'CasConflictError';
    Object.setPrototypeOf(this, CasConflictError.prototype);
  }
}

export interface TagDefinition {
  name: string;
  appliesTo: 'class' | 'entity' | 'intent';
  valueType: 'enum' | 'bool';
  allowedValues: string[];
  isOrdered: boolean;
  required: boolean;
  defaultValue: string | null;
  parentTag: string | null;
  parentAllowedValues?: Record<string, string[]>;
  createdAt: number;
}

export type TagDefinitionInput = Omit<TagDefinition, 'createdAt' | 'allowedValues' | 'parentAllowedValues'> & {
  allowedValues: readonly string[];
  parentAllowedValues?: Readonly<Record<string, readonly string[]>>;
};

export interface TagCondition {
  tag: string;
  values: string[];
}

export class EntityStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS classes (
        name        TEXT    PRIMARY KEY,
        schema      TEXT    NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entities (
        id          TEXT    PRIMARY KEY,
        class_name  TEXT    NOT NULL,
        data        TEXT    NOT NULL,
        _version    INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
    `);
    // Idempotent migration without relying on driver-specific duplicate-column errors.
    this.ensureColumn('classes', 'desc', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('entities', 'desc', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('entities', 'name', "TEXT NOT NULL DEFAULT ''");
    // Backfill existing rows so the unique index can be created without conflicts
    this.db.exec(`UPDATE entities SET name = id WHERE name = ''`);
    this.ensureIndex('uq_entities_class_name', 'entities', 'class_name, name');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tag_definitions (
        name           TEXT    NOT NULL PRIMARY KEY,
        applies_to     TEXT    NOT NULL,
        value_type     TEXT    NOT NULL,
        allowed_values TEXT    NOT NULL,
        is_ordered     INTEGER NOT NULL DEFAULT 0,
        required       INTEGER NOT NULL DEFAULT 0,
        default_value  TEXT,
        parent_tag     TEXT,
        created_at     INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS class_tags (
        class_name  TEXT NOT NULL REFERENCES classes(name) ON DELETE CASCADE,
        tag_name    TEXT NOT NULL REFERENCES tag_definitions(name),
        tag_value   TEXT NOT NULL,
        PRIMARY KEY (class_name, tag_name)
      );
      CREATE INDEX IF NOT EXISTS idx_class_tags ON class_tags(tag_name, tag_value);
      CREATE TABLE IF NOT EXISTS entity_tags (
        entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        tag_name   TEXT NOT NULL REFERENCES tag_definitions(name),
        tag_value  TEXT NOT NULL,
        PRIMARY KEY (entity_id, tag_name)
      );
      CREATE INDEX IF NOT EXISTS idx_entity_tags ON entity_tags(tag_name, tag_value);
    `);
    // Migrate tag_definitions PK from (name) to (name, applies_to) if needed
    if (this.needsTagDefPkMigration()) {
      this.migrateTagDefPk();
    }
    // New tables for intents
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intents (
        name         TEXT PRIMARY KEY,
        desc         TEXT NOT NULL DEFAULT '',
        inputs_json  TEXT NOT NULL DEFAULT '{}',
        outputs_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS intent_tags (
        intent_name  TEXT NOT NULL REFERENCES intents(name) ON DELETE CASCADE,
        tag_name     TEXT NOT NULL,
        tag_value    TEXT NOT NULL,
        PRIMARY KEY (intent_name, tag_name)
      );
    `);
    this.ensureColumn('tag_definitions', 'parent_allowed_values', 'TEXT');
    this.db.exec(`CREATE TABLE IF NOT EXISTS application_migrations (
      application_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      applied_at INTEGER NOT NULL,
      PRIMARY KEY (application_id, version)
    )`);
  }

  private ensureColumn(table: 'classes' | 'entities' | 'tag_definitions', column: string, columnDDL: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const hasColumn = rows.some(r => r.name === column);
    if (!hasColumn) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDDL}`);
    }
  }

  private ensureIndex(indexName: string, table: string, columns: string): void {
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${indexName} ON ${table}(${columns})`);
  }

  private needsTagDefPkMigration(): boolean {
    const info = this.db.prepare('PRAGMA table_info(tag_definitions)').all() as Array<{ pk: number }>;
    // Old schema: single-column PK (pk=1 on 'name' only); new schema: two PK columns
    return info.filter(c => c.pk > 0).length === 1;
  }

  private migrateTagDefPk(): void {
    this.db.pragma('foreign_keys = OFF');
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE tag_definitions_new (
          name           TEXT    NOT NULL,
          applies_to     TEXT    NOT NULL,
          value_type     TEXT    NOT NULL,
          allowed_values TEXT    NOT NULL,
          is_ordered     INTEGER NOT NULL DEFAULT 0,
          required       INTEGER NOT NULL DEFAULT 0,
          default_value  TEXT,
          parent_tag     TEXT,
          created_at     INTEGER NOT NULL,
          PRIMARY KEY (name, applies_to)
        );
        INSERT INTO tag_definitions_new SELECT * FROM tag_definitions;
        DROP TABLE tag_definitions;
        ALTER TABLE tag_definitions_new RENAME TO tag_definitions;
        CREATE TABLE class_tags_new (
          class_name  TEXT NOT NULL REFERENCES classes(name) ON DELETE CASCADE,
          tag_name    TEXT NOT NULL,
          tag_value   TEXT NOT NULL,
          PRIMARY KEY (class_name, tag_name)
        );
        INSERT INTO class_tags_new SELECT * FROM class_tags;
        DROP TABLE class_tags;
        ALTER TABLE class_tags_new RENAME TO class_tags;
        CREATE INDEX IF NOT EXISTS idx_class_tags ON class_tags(tag_name, tag_value);
        CREATE TABLE entity_tags_new (
          entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          tag_name   TEXT NOT NULL,
          tag_value  TEXT NOT NULL,
          PRIMARY KEY (entity_id, tag_name)
        );
        INSERT INTO entity_tags_new SELECT * FROM entity_tags;
        DROP TABLE entity_tags;
        ALTER TABLE entity_tags_new RENAME TO entity_tags;
        CREATE INDEX IF NOT EXISTS idx_entity_tags ON entity_tags(tag_name, tag_value);
      `);
    });
    try { migrate(); } finally { this.db.pragma('foreign_keys = ON'); }
  }

  /** Add an application's definitions once, preserving all existing records and custom values. */
  installTagDefinitions(applicationId: string, version: number, definitions: readonly TagDefinitionInput[]): void {
    if (!applicationId || !Number.isSafeInteger(version) || version < 1) {
      throw new FailableError('Application id and positive integer schema version are required');
    }
    this.db.transaction(() => {
      const applied = this.db.prepare(
        'SELECT 1 FROM application_migrations WHERE application_id = ? AND version = ?'
      ).get(applicationId, version);
      if (applied) return;
      for (const definition of definitions) {
        this.registerTagDefinition(definition);
        // Legacy definitions have no parent constraint metadata. Backfill only the new field.
        if (definition.parentAllowedValues) {
          this.db.prepare(`UPDATE tag_definitions SET parent_allowed_values = ?
            WHERE name = ? AND applies_to = ? AND parent_allowed_values IS NULL`)
            .run(JSON.stringify(definition.parentAllowedValues), definition.name, definition.appliesTo);
        }
      }
      this.db.prepare('INSERT INTO application_migrations VALUES (?, ?, ?)')
        .run(applicationId, version, Date.now());
    })();
  }

  registerTagDefinition(definition: TagDefinitionInput): void {
    if (definition.defaultValue !== null && !definition.allowedValues.includes(definition.defaultValue)) {
      throw new FailableError(`Invalid default for tag '${definition.name}'`);
    }
    if (definition.parentAllowedValues && !definition.parentTag) {
      throw new FailableError(`Parent constraints require a parent tag for '${definition.name}'`);
    }
    this.db.prepare(`INSERT OR IGNORE INTO tag_definitions
      (name, applies_to, value_type, allowed_values, is_ordered, required, default_value,
       parent_tag, parent_allowed_values, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(definition.name, definition.appliesTo, definition.valueType, JSON.stringify(definition.allowedValues),
        definition.isOrdered ? 1 : 0, definition.required ? 1 : 0, definition.defaultValue,
        definition.parentTag, definition.parentAllowedValues ? JSON.stringify(definition.parentAllowedValues) : null,
        Date.now());
  }

  getTagDefinitions(): TagDefinition[] {
    const rows = this.db.prepare('SELECT * FROM tag_definitions ORDER BY name').all() as Array<{
      name: string; applies_to: string; value_type: string; allowed_values: string;
      is_ordered: number; required: number; default_value: string | null;
      parent_tag: string | null; parent_allowed_values: string | null; created_at: number;
    }>;
    return rows.map(r => ({
      name: r.name,
      appliesTo: r.applies_to as 'class' | 'entity' | 'intent',
      valueType: r.value_type as 'enum' | 'bool',
      allowedValues: JSON.parse(r.allowed_values) as string[],
      isOrdered: r.is_ordered === 1,
      required: r.required === 1,
      defaultValue: r.default_value,
      parentTag: r.parent_tag,
      ...(r.parent_allowed_values ? { parentAllowedValues: JSON.parse(r.parent_allowed_values) as Record<string, string[]> } : {}),
      createdAt: r.created_at,
    }));
  }

  defineClass(name: string, schema: unknown, desc: string, tags: Record<string, string>): boolean {
    text(name, 'Class name'); text(desc, 'Class description');
    record(schema, 'Class schema'); tagsRecord(tags);
    this.validateClassTags(tags);
    try {
      this.db.prepare(`
        INSERT INTO classes (name, schema, desc, created_at)
        VALUES (?, ?, ?, ?)
      `).run(name, JSON.stringify(schema), desc, Date.now());
    } catch (err: unknown) {
      if ((err as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
        throw new FailableError(`Class '${name}' already exists`);
      }
      throw err;
    }
    const defs = this.getTagDefinitions().filter(d => d.appliesTo === 'class');
    const upsertTag = this.db.prepare(`
      INSERT INTO class_tags (class_name, tag_name, tag_value) VALUES (?, ?, ?)
      ON CONFLICT(class_name, tag_name) DO UPDATE SET tag_value = excluded.tag_value
    `);
    for (const def of defs) {
      const val = tags[def.name] ?? def.defaultValue;
      if (val != null) upsertTag.run(name, def.name, val);
    }
    return true;
  }

  private validateClassTags(tags: Record<string, string>): void {
    const defs = this.getTagDefinitions().filter(d => d.appliesTo === 'class');
    for (const def of defs) {
      if (def.required && !(def.name in tags)) {
        throw new FailableError(`Missing required class tag: ${def.name}`);
      }
      if (def.name in tags && !def.allowedValues.includes(tags[def.name])) {
        throw new FailableError(`Invalid value '${tags[def.name]}' for tag '${def.name}'. Allowed: ${def.allowedValues.join(', ')}`);
      }
    }
    this.validateParentTags(defs, tags);
  }

  private validateParentTags(definitions: TagDefinition[], tags: Record<string, string>): void {
    for (const def of definitions) {
      if (!def.parentTag || !def.parentAllowedValues) continue;
      const value = tags[def.name] ?? def.defaultValue;
      if (value === null || value === undefined) continue;
      const parentDef = definitions.find(d => d.name === def.parentTag);
      const parent = tags[def.parentTag] ?? parentDef?.defaultValue;
      const allowed = parent && Object.hasOwn(def.parentAllowedValues, parent)
        ? def.parentAllowedValues[parent] : [];
      if (!allowed.includes(value)) {
        throw new FailableError(`${def.name} '${value}' is not valid for ${def.parentTag} '${parent}'. Allowed: ${allowed.join(', ')}`);
      }
    }
  }

  createEntity(
    className: string,
    name: string,
    initData: Record<string, unknown>,
    desc: string,
    tags: Record<string, string>,
  ): { id: string; created: boolean } {
    text(className, 'Class name'); text(name, 'Entity name'); text(desc, 'Entity description');
    record(initData, 'Entity data'); tagsRecord(tags);
    this.validateEntityTags(tags);
    const id = `${className.toLowerCase()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = Date.now();
    try {
      this.db.prepare(`
        INSERT INTO entities (id, class_name, name, data, desc, _version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(id, className, name, JSON.stringify(initData), desc, now, now);
    } catch (err: unknown) {
      if ((err as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
        const existing = this.db.prepare(
          `SELECT id FROM entities WHERE class_name = ? AND name = ?`
        ).get(className, name) as { id: string } | undefined;
        if (existing) return { id: existing.id, created: false };
        throw err;
      }
      throw err;
    }
    const defs = this.getTagDefinitions().filter(d => d.appliesTo === 'entity');
    const insertTag = this.db.prepare(`INSERT INTO entity_tags (entity_id, tag_name, tag_value) VALUES (?, ?, ?)`);
    for (const def of defs) {
      const val = tags[def.name] ?? def.defaultValue;
      if (val != null) insertTag.run(id, def.name, val);
    }
    return { id, created: true };
  }

  private validateEntityTags(tags: Record<string, string>): void {
    const defs = this.getTagDefinitions().filter(d => d.appliesTo === 'entity');
    for (const def of defs) {
      if (def.required && !(def.name in tags)) {
        throw new FailableError(`Missing required entity tag: ${def.name}`);
      }
      if (def.name in tags && !def.allowedValues.includes(tags[def.name])) {
        throw new FailableError(`Invalid value '${tags[def.name]}' for tag '${def.name}'. Allowed: ${def.allowedValues.join(', ')}`);
      }
    }
    this.validateParentTags(defs, tags);
  }

  updateEntityTag(entityId: string, tagName: string, tagValue: string): void {
    const definitions = this.getTagDefinitions();
    const def = definitions.find(d => d.name === tagName && d.appliesTo === 'entity');
    if (!def) {
      if (definitions.some(d => d.name === tagName)) throw new FailableError(`'${tagName}' is not an entity tag`);
      throw new FailableError(`Unknown tag: '${tagName}'`);
    }
    if (!def.allowedValues.includes(tagValue)) {
      throw new FailableError(`Invalid value '${tagValue}' for tag '${tagName}'. Allowed: ${def.allowedValues.join(', ')}`);
    }
    this.validateParentTags(this.getTagDefinitions().filter(d => d.appliesTo === 'entity'),
      { ...this.getEntity(entityId).tags, [tagName]: tagValue });
    this.db.prepare(`
      INSERT INTO entity_tags (entity_id, tag_name, tag_value) VALUES (?, ?, ?)
      ON CONFLICT(entity_id, tag_name) DO UPDATE SET tag_value = excluded.tag_value
    `).run(entityId, tagName, tagValue);
  }

  getEntityField(entityId: string, fieldJsonPath: string): { value: unknown; entityVersion: number } {
    const row = this.db.prepare(
      `SELECT json_extract(data, ?) AS value, json_type(data, ?) AS value_type, _version FROM entities WHERE id = ?`
    ).get(fieldJsonPath, fieldJsonPath, entityId) as { value: unknown; value_type: string | null; _version: number } | undefined;
    if (!row) throw new FailableError(`Entity not found: '${entityId}'`);
    // SQLite exposes containers as text and JSON booleans as integers.
    // Inspect the stored JSON type so actual text such as "false" stays text.
    const value = row.value_type === 'object' || row.value_type === 'array'
      ? JSON.parse(row.value as string)
      : row.value_type === 'true' ? true : row.value_type === 'false' ? false : row.value;
    return { value, entityVersion: row._version };
  }

  updateEntityField(entityId: string, fieldJsonPath: string, value: unknown, expectedVersion: number): void {
    if (!isJsonValue(value)) throw new EntityValidationError('Entity field must be a JSON value without lossy serialization');
    // Use json() in json_set to correctly handle all types (number, string, boolean, null, object, array)
    // via JSON-stringified values without requiring manual type detection.
    const result = this.db.prepare(`
      UPDATE entities
      SET data = json_set(data, ?, json(?)), _version = _version + 1, updated_at = ?
      WHERE id = ? AND _version = ?
    `).run(fieldJsonPath, JSON.stringify(value), Date.now(), entityId, expectedVersion);
    if (result.changes === 0) {
      const exists = this.db.prepare('SELECT 1 FROM entities WHERE id = ?').get(entityId);
      if (!exists) throw new FailableError(`Entity not found: '${entityId}'`);
      throw new CasConflictError(entityId, expectedVersion);
    }
  }

  /** Apply an editor patch atomically; stale versions never overwrite newer data. */
  updateEntityFields(entityId: string, fields: Record<string, unknown>, expectedVersion?: number): void {
    record(fields, 'Entity fields');
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw new EntityValidationError('expectedVersion must be a positive integer');
    }
    this.db.transaction(() => {
      const current = this.getEntity(entityId);
      if (expectedVersion !== undefined && current.version !== expectedVersion) throw new CasConflictError(entityId, expectedVersion);
      let version = current.version;
      for (const [key, value] of Object.entries(fields)) {
        const jsonPath = key.startsWith('$') ? key : `$.${key}`;
        try {
          this.getEntityField(entityId, jsonPath); // Preserve the field-path diagnostics of the single-field API.
          this.updateEntityField(entityId, jsonPath, value, version++);
        } catch (err) {
          (err as Error & { failedField?: string }).failedField = key;
          throw err;
        }
      }
    }).immediate();
  }

  queryEntities(className: string): string[] {
    const rows = this.db.prepare(
      `SELECT id FROM entities WHERE class_name = ?`
    ).all(className) as { id: string }[];
    return rows.map(r => r.id);
  }

  deleteEntity(entityId: string): boolean {
    const result = this.db.prepare(`DELETE FROM entities WHERE id = ?`).run(entityId);
    return result.changes > 0;
  }

  deleteClass(name: string): boolean {
    const hasEntities = this.db.prepare(
      `SELECT 1 FROM entities WHERE class_name = ? LIMIT 1`
    ).get(name);
    if (hasEntities) throw new FailableError(`Cannot delete class '${name}': entities exist`);
    const result = this.db.prepare(`DELETE FROM classes WHERE name = ?`).run(name);
    return result.changes > 0;
  }

  defineTagDimension(
    name: string,
    appliesTo: 'class' | 'entity' | 'intent',
    valueType: 'enum' | 'bool',
    allowedValues: string[],
    isOrdered = false,
    required = false,
    defaultValue?: string,
    parentTag?: string,
  ): void {
    this.registerTagDefinition({ name, appliesTo, valueType, allowedValues, isOrdered, required,
      defaultValue: defaultValue ?? null, parentTag: parentTag ?? null });
  }

  addTagEnumValue(tagName: string, newValue: string): void {
    const row = this.db.prepare(
      `SELECT allowed_values FROM tag_definitions WHERE name = ?`
    ).get(tagName) as { allowed_values: string } | undefined;
    if (!row) throw new FailableError(`Unknown tag: '${tagName}'`);
    const values = JSON.parse(row.allowed_values) as string[];
    if (!values.includes(newValue)) {
      values.push(newValue);
      this.db.prepare(`UPDATE tag_definitions SET allowed_values = ? WHERE name = ?`)
        .run(JSON.stringify(values), tagName);
    }
  }

  queryClassesByTags(conditions: TagCondition[]): { name: string; desc: string; tags: Record<string, string> }[] {
    let sql = 'SELECT name, desc FROM classes';
    const params: unknown[] = [];
    for (let i = 0; i < conditions.length; i++) {
      const cond = conditions[i];
      const placeholders = cond.values.map(() => '?').join(', ');
      sql += ` ${i === 0 ? 'WHERE' : 'AND'} EXISTS (
        SELECT 1 FROM class_tags
        WHERE class_tags.class_name = classes.name
          AND class_tags.tag_name = ?
          AND class_tags.tag_value IN (${placeholders})
      )`;
      params.push(cond.tag, ...cond.values);
    }
    const rows = this.db.prepare(sql).all(...params) as { name: string; desc: string }[];
    return rows.map(r => {
      const tagRows = this.db.prepare(
        `SELECT tag_name, tag_value FROM class_tags WHERE class_name = ?`
      ).all(r.name) as { tag_name: string; tag_value: string }[];
      const tags: Record<string, string> = {};
      for (const t of tagRows) tags[t.tag_name] = t.tag_value;
      return { name: r.name, desc: r.desc, tags };
    });
  }

  queryEntitiesByTags(className: string, conditions: TagCondition[]): string[] {
    let sql = 'SELECT id FROM entities WHERE class_name = ?';
    const params: unknown[] = [className];
    for (const cond of conditions) {
      const placeholders = cond.values.map(() => '?').join(', ');
      sql += ` AND EXISTS (
        SELECT 1 FROM entity_tags
        WHERE entity_tags.entity_id = entities.id
          AND entity_tags.tag_name = ?
          AND entity_tags.tag_value IN (${placeholders})
      )`;
      params.push(cond.tag, ...cond.values);
    }
    const rows = this.db.prepare(sql).all(...params) as { id: string }[];
    return rows.map(r => r.id);
  }

  queryClasses(): { name: string; desc: string; tags: Record<string, string> }[] {
    const rows = this.db.prepare(`SELECT name, desc FROM classes`).all() as { name: string; desc: string }[];
    return rows.map(r => {
      const tagRows = this.db.prepare(
        `SELECT tag_name, tag_value FROM class_tags WHERE class_name = ?`
      ).all(r.name) as { tag_name: string; tag_value: string }[];
      const tags: Record<string, string> = {};
      for (const t of tagRows) tags[t.tag_name] = t.tag_value;
      return { name: r.name, desc: r.desc, tags };
    });
  }

  queryClassInfo(name: string): { desc: string; schema: unknown } {
    const row = this.db.prepare(
      `SELECT schema, desc FROM classes WHERE name = ?`
    ).get(name) as { schema: string; desc: string } | undefined;
    if (!row) throw new FailableError(`Class not found: '${name}'`);
    return { desc: row.desc, schema: storedRecord(row.schema, `Class '${name}' schema`) };
  }

  getEntity(entityId: string): { id: string; className: string; name: string; desc: string; data: Record<string, unknown>; version: number; tags: Record<string, string> } {
    const row = this.db.prepare(
      `SELECT id, class_name, name, data, desc, _version FROM entities WHERE id = ?`
    ).get(entityId) as { id: string; class_name: string; name: string; data: string; desc: string; _version: number } | undefined;
    if (!row) throw new FailableError(`Entity not found: '${entityId}'`);
    const tagRows = this.db.prepare(
      `SELECT tag_name, tag_value FROM entity_tags WHERE entity_id = ?`
    ).all(entityId) as { tag_name: string; tag_value: string }[];
    const tags: Record<string, string> = {};
    for (const t of tagRows) tags[t.tag_name] = t.tag_value;
    return { id: row.id, className: row.class_name, name: row.name, desc: row.desc, data: storedRecord(row.data, `Entity '${row.id}' fields`), version: row._version, tags };
  }

  listEntities(className: string): { id: string; name: string; desc: string; data: Record<string, unknown>; version: number }[] {
    const rows = this.db.prepare(
      `SELECT id, name, data, desc, _version FROM entities WHERE class_name = ?`
    ).all(className) as { id: string; name: string; data: string; desc: string; _version: number }[];
    return rows.map(r => ({ id: r.id, name: r.name, desc: r.desc, data: storedRecord(r.data, `Entity '${r.id}' fields`), version: r._version }));
  }

  // ── Intent methods ───────────────────────────────────────────────────────

  upsertIntent(
    name: string,
    desc: string,
    tags: Record<string, string>,
    inputs: Record<string, unknown>,
    outputs: Record<string, unknown>,
  ): void {
    this.db.prepare(`
      INSERT INTO intents (name, desc, inputs_json, outputs_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        desc = excluded.desc,
        inputs_json = excluded.inputs_json,
        outputs_json = excluded.outputs_json
    `).run(name, desc, JSON.stringify(inputs), JSON.stringify(outputs));

    // Write tags from file
    const upsertTag = this.db.prepare(`
      INSERT INTO intent_tags (intent_name, tag_name, tag_value)
      VALUES (?, ?, ?)
      ON CONFLICT(intent_name, tag_name) DO UPDATE SET tag_value = excluded.tag_value
    `);
    for (const [tagName, tagValue] of Object.entries(tags)) {
      upsertTag.run(name, tagName, tagValue);
    }

    // Application-defined defaults never replace a value already supplied or edited by the user.
    const insertDefault = this.db.prepare(`INSERT OR IGNORE INTO intent_tags
      (intent_name, tag_name, tag_value) VALUES (?, ?, ?)`);
    for (const def of this.getTagDefinitions().filter(d => d.appliesTo === 'intent')) {
      if (def.defaultValue !== null) insertDefault.run(name, def.name, def.defaultValue);
    }
  }

  queryIntentsByTags(
    conditions: TagCondition[],
  ): { name: string; desc: string; tags: Record<string, string> }[] {
    let sql = `SELECT DISTINCT i.name, i.desc FROM intents i WHERE 1=1`;
    const params: string[] = [];
    for (const cond of conditions) {
      const placeholders = cond.values.map(() => '?').join(', ');
      sql += ` AND EXISTS (
        SELECT 1 FROM intent_tags it
        WHERE it.intent_name = i.name
          AND it.tag_name = ?
          AND it.tag_value IN (${placeholders})
      )`;
      params.push(cond.tag, ...cond.values);
    }
    const rows = this.db.prepare(sql).all(params) as Array<{ name: string; desc: string }>;
    return rows.map(r => {
      const tagRows = this.db.prepare(
        `SELECT tag_name, tag_value FROM intent_tags WHERE intent_name = ?`
      ).all(r.name) as Array<{ tag_name: string; tag_value: string }>;
      return {
        name: r.name,
        desc: r.desc,
        tags: Object.fromEntries(tagRows.map(t => [t.tag_name, t.tag_value])),
      };
    });
  }

  getIntentRecord(name: string): {
    name: string;
    desc: string;
    inputs: Record<string, unknown>;
    outputs: Record<string, unknown>;
    tags: Record<string, string>;
  } {
    const row = this.db.prepare(
      `SELECT name, desc, inputs_json, outputs_json FROM intents WHERE name = ?`
    ).get(name) as { name: string; desc: string; inputs_json: string; outputs_json: string } | undefined;
    if (!row) throw new FailableError(`Intent not found: ${name}`);
    const tagRows = this.db.prepare(
      `SELECT tag_name, tag_value FROM intent_tags WHERE intent_name = ?`
    ).all(name) as Array<{ tag_name: string; tag_value: string }>;
    return {
      name: row.name,
      desc: row.desc,
      inputs: JSON.parse(row.inputs_json) as Record<string, unknown>,
      outputs: JSON.parse(row.outputs_json) as Record<string, unknown>,
      tags: Object.fromEntries(tagRows.map(t => [t.tag_name, t.tag_value])),
    };
  }

  updateIntentTag(name: string, tagName: string, tagValue: string): void {
    const intent = this.db.prepare(`SELECT name FROM intents WHERE name = ?`).get(name);
    if (!intent) throw new FailableError(`Intent not found: ${name}`);
    this.db.prepare(`
      INSERT INTO intent_tags (intent_name, tag_name, tag_value)
      VALUES (?, ?, ?)
      ON CONFLICT(intent_name, tag_name) DO UPDATE SET tag_value = excluded.tag_value
    `).run(name, tagName, tagValue);
  }

  deleteIntentRecord(name: string): boolean {
    const result = this.db.prepare(`DELETE FROM intents WHERE name = ?`).run(name);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
