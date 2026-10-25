// Generic Brain compiler configuration and platform system declarations. No application seeds.
export const BRAIN_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2020',
    module: 'ESNext',
    moduleResolution: 'bundler',
    strict: true,
    lib: ['ES2020'],
    noEmit: true,
    types: [],
    typeRoots: [],
  },
  files: ['sys-globals.d.ts'],
  include: ['**/*.ts'],
}, null, 2);

// Fixed content — ambient declarations for _by_sys methods used in brain/ TS files.
// Shared by the legacy setup facade and the standalone local initializer.
export const SYS_GLOBALS_DTS = `\
// sys-globals.d.ts
// System-generated — do not edit manually.
// Global ambient declarations for OpenHilo _by_sys methods.
// Included via tsconfig.json in Brain root — no import needed in session files.

declare function createEntity_by_sys(className: string, name: string, initData: object, desc: string, tags: object): Promise<{ id: string; created: boolean }>;
declare function getEntityField_by_sys(entityId: string, fieldJsonPath: string): Promise<{ value: any; entityVersion: number }>;
declare function updateEntityField_by_sys(entityId: string, fieldJsonPath: string, value: any, expectedVersion: number): Promise<{}>;
declare function queryEntities_by_sys(className: string): Promise<{ result: object }>;
declare function getEntity_by_sys(entityId: string): Promise<{ result: object }>;
declare function deleteEntity_by_sys(entityId: string): Promise<{ result: boolean }>;
declare function scheduleIntent_by_sys(cron: string, intentName: string, params: object, workdir?: string): Promise<{ result: string }>;
declare function scheduleFlexibleIntent_by_sys(cron: string, intentName: string, params: object, workdir?: string): Promise<{ result: string }>;
declare function deleteClass_by_sys(className: string): Promise<{ result: boolean }>;
declare function queryClasses_by_sys(): Promise<{ result: object }>;
declare function queryClassInfo_by_sys(className: string): Promise<{ result: object }>;
declare function querySchedulors_by_sys(): Promise<{ result: object }>;
declare function cancelSchedulor_by_sys(schedulorId: string): Promise<{ result: boolean }>;
declare function querySchedulorInfo_by_sys(schedulorId: string): Promise<{ result: object }>;
declare function queryIntents_by_sys(): Promise<{ result: object }>;
declare function queryIntentInfo_by_sys(intentName: string): Promise<{ result: object }>;
declare function updateEntityTag_by_sys(entityId: string, tagName: string, tagValue: string): Promise<{}>;
declare function defineTagDimension_by_sys(name: string, appliesTo: string, valueType: string, allowedValues: object, isOrdered: boolean, required: boolean, defaultValue: string, parentTag: string): Promise<{}>;
declare function addTagEnumValue_by_sys(tagName: string, newValue: string): Promise<{}>;
declare function getTagDefinitions_by_sys(): Promise<{ result: object }>;
declare function queryClassesByTags_by_sys(conditions: object): Promise<{ result: object }>;
declare function queryEntitiesByTags_by_sys(className: string, conditions: object): Promise<{ result: object }>;
declare function queryIntentsByTags_by_sys(conditions: object): Promise<{ result: object }>;
declare function getWorkdir_by_sys(): Promise<{ path: string }>;
`;
