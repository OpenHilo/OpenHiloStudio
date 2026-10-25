import type { ValueType } from '@openhilo/itt-contracts';

export const platformSystemMethods: Record<string, {
  params: string[];
  outputs: { name: string; kind: ValueType }[];
}> = {
  createEntity:       { params: ['className', 'name', 'initData', 'desc', 'tags'], outputs: [{ name: 'id', kind: 'text' }, { name: 'created', kind: 'boolean' }] },
  getEntityField:     { params: ['entityId', 'fieldJsonPath'],              outputs: [{ name: 'value', kind: 'json' }, { name: 'entityVersion', kind: 'number' }] },
  updateEntityField:  { params: ['entityId', 'fieldJsonPath', 'value', 'expectedVersion'], outputs: [] },
  queryEntities:      { params: ['className'],                              outputs: [{ name: 'result', kind: 'json' }] },
  getEntity:          { params: ['entityId'],                               outputs: [{ name: 'result', kind: 'json' }] },
  deleteEntity:       { params: ['entityId'],                               outputs: [{ name: 'result', kind: 'boolean' }] },
  scheduleIntent:         { params: ['cron', 'intentName', 'params', 'workdir'], outputs: [{ name: 'result', kind: 'text' }] },
  scheduleFlexibleIntent: { params: ['cron', 'intentName', 'params', 'workdir'], outputs: [{ name: 'result', kind: 'text' }] },
  deleteClass:        { params: ['className'],                              outputs: [{ name: 'result', kind: 'boolean' }] },
  queryClasses:       { params: [],                                         outputs: [{ name: 'result', kind: 'json' }] },
  queryClassInfo:     { params: ['className'],                              outputs: [{ name: 'result', kind: 'json' }] },
  querySchedulors:    { params: [],                                         outputs: [{ name: 'result', kind: 'json' }] },
  cancelSchedulor:    { params: ['schedulorId'],                            outputs: [{ name: 'result', kind: 'boolean' }] },
  querySchedulorInfo: { params: ['schedulorId'],                            outputs: [{ name: 'result', kind: 'json' }] },
  queryIntents:       { params: [],                                         outputs: [{ name: 'result', kind: 'json' }] },
  queryIntentInfo:    { params: ['intentName'],                             outputs: [{ name: 'result', kind: 'json' }] },
  updateEntityTag:    { params: ['entityId', 'tagName', 'tagValue'],        outputs: [] },
  defineTagDimension: { params: ['name', 'appliesTo', 'valueType', 'allowedValues', 'isOrdered', 'required', 'defaultValue', 'parentTag'], outputs: [] },
  addTagEnumValue:    { params: ['tagName', 'newValue'],                    outputs: [] },
  getTagDefinitions:  { params: [],                                         outputs: [{ name: 'result', kind: 'json' }] },
  queryClassesByTags: { params: ['conditions'],                             outputs: [{ name: 'result', kind: 'json' }] },
  queryEntitiesByTags:{ params: ['className', 'conditions'],                outputs: [{ name: 'result', kind: 'json' }] },
  queryIntentsByTags: { params: ['conditions'],                             outputs: [{ name: 'result', kind: 'json' as ValueType }] },
  getWorkdir:         { params: [],                                         outputs: [{ name: 'path', kind: 'dir' as ValueType }] },
};
