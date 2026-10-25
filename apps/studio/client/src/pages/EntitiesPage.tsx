// platform/client/src/pages/EntitiesPage.tsx
import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { CodeViewer } from '../components/CodeViewer';
import { SmartParamInput, type ValueType } from '../components/SmartParamInput';
import { ClassFieldsEditor, emptyClassFieldsDraft, schemaFromClassDraft } from '../components/ClassFieldsEditor';
import { TagBadge } from '../components/TagBadge';
import { TagSection } from '../components/TagSection';
import { GENERIC_STUDIO_APPLICATION, type StudioApplication } from '@openhilo/studio-contracts';
import { getStudioApplication } from '../api/application';
import { studioTones } from '../lib/studio-tones';
import { allowedTagValues, effectiveTagValues, submittedTagValues } from '../lib/tag-values';
import { entityFieldMap } from '../lib/entity-schema';
import {
  listClasses, getClass, createClass, deleteClass as apiDeleteClass,
  listEntities, createEntity, updateEntity, deleteEntity as apiDeleteEntity,
  getTagDefinitions, updateEntityTag,
  type TagDefinition,
} from '../api/entities';

interface ClassInfo { name: string; desc: string; tags: Record<string, string> }
interface EntityRow { id: string; name: string; desc: string; data: Record<string, unknown> | null; version: number | null; tags: Record<string, string>; readError?: string }

function FieldValue({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span className="text-gray-500">—</span>;
  if (typeof v === 'object') {
    return <CodeViewer code={JSON.stringify(v, null, 2)} lang="json" className="max-w-xs max-h-24" />;
  }
  const text = String(v);
  return <div tabIndex={text.length > 120 ? 0 : undefined} className="font-mono text-xs min-w-20 max-w-xs max-h-24 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{text}</div>;
}

function inferType(schemaType: unknown): ValueType {
  if (schemaType === 'boolean' || schemaType === 'bool') return 'boolean';
  if (schemaType === 'number' || schemaType === 'integer') return 'number';
  if (schemaType === 'object' || schemaType === 'array' || schemaType === 'json') return 'json';
  return 'text';
}

export function EntitiesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [application, setApplication] = useState<StudioApplication>(GENERIC_STUDIO_APPLICATION);
  const [applicationError, setApplicationError] = useState<string | null>(null);
  const [tagDefs, setTagDefs] = useState<TagDefinition[]>([]);
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [classesLoading, setClassesLoading] = useState(true);
  const [classesError, setClassesError] = useState<string | null>(null);
  const selectedClass = searchParams.get('class') ?? classes[0]?.name ?? null;
  const setSelectedClass = useCallback((value: string | null | ((current: string | null) => string | null)) => {
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      const selected = typeof value === 'function' ? value(previous.get('class')) : value;
      if (selected) next.set('class', selected); else next.delete('class');
      return next;
    });
  }, [setSearchParams]);
  const [classReady, setClassReady] = useState(false);
  const [classSchema, setClassSchema] = useState<Record<string, unknown>>({});
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tag filters for class list
  const [classFilterTags, setClassFilterTags] = useState<Record<string, string>>({});

  const [selectedFacet, setSelectedFacet] = useState('');
  const facet = application.classFacet;

  // Dialogs
  const [newClassOpen, setNewClassOpen] = useState(false);
  const classTrigger = useRef<HTMLButtonElement | null>(null);
  const classHeading = useRef<HTMLDivElement | null>(null);
  const entityTrigger = useRef<HTMLButtonElement | null>(null);
  const [entityDialogOpen, setEntityDialogOpen] = useState(false);
  const [editingEntity, setEditingEntity] = useState<EntityRow | null>(null);

  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ kind: 'class' | 'entity'; id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteBusy = useRef(false);

  // New class form
  const [newClassName, setNewClassName] = useState('');
  const [newClassDesc, setNewClassDesc] = useState('');
  const [classFieldsDraft, setClassFieldsDraft] = useState(emptyClassFieldsDraft);
  let classSchemaValid = true;
  try { schemaFromClassDraft(classFieldsDraft); } catch { classSchemaValid = false; }
  const [classFormError, setClassFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newClassTags, setNewClassTags] = useState<Record<string, string>>({});

  // Entity form
  const [entityName, setEntityName] = useState('');
  const [entityDesc, setEntityDesc] = useState('');
  const [entityFields, setEntityFields] = useState<Record<string, unknown>>({});
  const [entityFieldErrors, setEntityFieldErrors] = useState<Record<string, string>>({});
  const [entityFormError, setEntityFormError] = useState<string | null>(null);
  const [entityTags, setEntityTags] = useState<Record<string, string>>({});

  const classDefs = tagDefs.filter(d => d.appliesTo === 'class');
  const entityDefs = tagDefs.filter(d => d.appliesTo === 'entity');

  // Filtered class list (client-side)
  const filteredClasses = classes.filter(c => {
    const facetMatch = !facet || !selectedFacet || (c.tags ?? {})[facet.tag] === selectedFacet;
    const tagMatch = Object.entries(classFilterTags)
      .every(([tag, val]) => !val || (c.tags ?? {})[tag] === val);
    return facetMatch && tagMatch;
  });

  const loadClasses = useCallback(async () => {
    setClassesLoading(true); setClassesError(null);
    try {
      const list = await listClasses();
      setClasses(list);
    } catch (e) {
      setClassesError(e instanceof Error ? e.message : 'Failed to load classes');
    } finally { setClassesLoading(false); }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    getStudioApplication(controller.signal).then(value => { if (!controller.signal.aborted) setApplication(value); })
      .catch(e => { if (!controller.signal.aborted) setApplicationError(e.message); });
    getTagDefinitions().then(setTagDefs).catch(e => setError(e.message));
    loadClasses();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    let current = true;
    setClassReady(false); setClassSchema({}); setEntities([]); setError(null);
    if (!selectedClass) { setLoading(false); return; }
    setLoading(true);
    Promise.all([
      getClass(selectedClass),
      listEntities(selectedClass),
    ]).then(([cls, ents]) => {
      if (!current) return;
      setClassSchema(entityFieldMap(cls.schema));
      setEntities(ents); setClassReady(true);
    }).catch(e => { if (current) setError(e.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [selectedClass]);

  async function handleCreateClass() {
    if (!classSchemaValid || saving) return;
    setClassFormError(null); setSaving(true);
    try {
      if (!newClassName.trim()) throw new Error('Class name is required');
      const schema = schemaFromClassDraft(classFieldsDraft);
      await createClass(newClassName, schema, newClassDesc, submittedTagValues(classDefs, newClassTags));
      setNewClassName(''); setNewClassDesc(''); setClassFieldsDraft(emptyClassFieldsDraft()); setNewClassTags({});
      await loadClasses();
      setSelectedClass(newClassName);
      setNewClassOpen(false);
    } catch (e) {
      setClassFormError(e instanceof Error ? e.message : 'Failed to create class');
    } finally { setSaving(false); }
  }

  async function confirmDelete() {
    if (!deleteTarget || deleteBusy.current) return;
    const target = deleteTarget;
    deleteBusy.current = true; setDeleting(true); setDeleteError(null);
    try {
      if (target.kind === 'class') {
        await apiDeleteClass(target.id);
        setClasses(previous => previous.filter(item => item.name !== target.id));
        setSelectedClass(current => current === target.id ? null : current);
      } else {
        await apiDeleteEntity(target.id);
        setEntities(previous => previous.filter(item => item.id !== target.id));
      }
      setDeleteTarget(null);
    } catch (e) { setDeleteError(e instanceof Error ? e.message : 'Deletion was not confirmed. Reload before retrying.'); }
    finally { deleteBusy.current = false; setDeleting(false); }
  }

  function openNewEntity(event: React.MouseEvent<HTMLButtonElement>) {
    entityTrigger.current = event.currentTarget;
    setEditingEntity(null);
    setEntityName('');
    setEntityDesc('');
    setEntityFieldErrors({}); setEntityFormError(null);
    setEntityFields(Object.fromEntries(Object.entries(classSchema).map(([key, schema]) => {
      const type = inferType((schema as Record<string, unknown>)?.type ?? schema);
      return [key, type === 'json' ? null : type === 'boolean' ? false : type === 'number' ? 0 : ''];
    })));
    setEntityTags({});
    setEntityDialogOpen(true);
  }

  function openEditEntity(entity: EntityRow, trigger: HTMLButtonElement) {
    if (entity.readError || !entity.data || entity.version === null) return;
    entityTrigger.current = trigger;
    setEntityFieldErrors({}); setEntityFormError(null);
    setEditingEntity(entity);
    setEntityName(entity.name);
    setEntityDesc(entity.desc);
    setEntityFields({ ...entity.data });
    setEntityTags({ ...entity.tags });
    setEntityDialogOpen(true);
  }

  async function handleSaveEntity() {
    if (!selectedClass || saving || Object.keys(entityFieldErrors).length) return;
    setEntityFormError(null);
    // Validate required entity tags before hitting the server
    if (!editingEntity) {
      const missing = entityDefs.filter(d => d.required && !entityTags[d.name]).map(d => d.name);
      if (missing.length > 0) { setEntityFormError(`请选择必填 tag：${missing.join(', ')}`); return; }
    }
    setSaving(true);
    try {
      if (!editingEntity && !entityName.trim()) throw new Error('Entity name is required');
      if (editingEntity) {
        if (editingEntity.readError || editingEntity.version === null) throw new Error('This entity is unreadable. Reload before editing.');
        await updateEntity(editingEntity.id, entityFields, editingEntity.version);
      } else {
        await createEntity(selectedClass, entityName, entityFields, entityDesc, submittedTagValues(entityDefs, entityTags));
      }
      setEntityDialogOpen(false);
      const ents = await listEntities(selectedClass);
      setEntities(ents);
    } catch (e) {
      setEntityFormError(e instanceof Error ? e.message : 'Failed to save entity');
    } finally { setSaving(false); }
  }

  async function handleTagChange(entityId: string, tagName: string, tagValue: string) {
    await updateEntityTag(entityId, tagName, tagValue);
    setEntities(previous => previous.map(entity => entity.id === entityId
      ? { ...entity, tags: { ...entity.tags, [tagName]: tagValue } } : entity));
  }

  const schemaFields = Object.entries(classSchema);
  const selectedClassInfo = classes.find(c => c.name === selectedClass);
  function openNewClass(event: React.MouseEvent<HTMLButtonElement>) {
    classTrigger.current = event.currentTarget;
    setClassFormError(null); setNewClassOpen(true);
  }

  return (
    <><header className="page-heading"><div><h1>Data</h1><p>Store shared data your workflows can query and reuse across sessions and runs.</p></div></header><div className="surface flex flex-col md:flex-row min-h-[60vh]">
      {error && (
        <div role="alert" className="absolute top-4 right-4 bg-red-50 text-red-900 text-sm px-3 py-2 rounded z-50">
          {error} <button aria-label="Dismiss error" onClick={() => setError(null)} className="ml-2 text-red-700">×</button>
        </div>
      )}

      {applicationError && <div role="alert" className="p-3 text-red-700">{applicationError}. Application-specific controls are unavailable; reload to retry.</div>}

      {/* Left: application facets and schema-defined filters */}
      <div className="w-full md:w-56 md:flex-shrink-0 border-b md:border-b-0 md:border-r border-gray-200 bg-gray-50 flex flex-col">
        {/* Mobile: select */}
        <div className="md:hidden px-3 py-2">
          <select
            aria-label="Class"
            className="w-full bg-gray-50 border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-900"
            value={selectedClass ?? ''}
            onChange={e => setSelectedClass(e.target.value)}
          >
            {classes.length === 0 && <option value="">No classes</option>}
            {classes.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
          <button onClick={openNewClass} className="mt-2 text-sm bg-teal-700 text-white px-3 py-1 rounded">New Class</button>
        </div>

        {/* Desktop: two-column layout */}
        <div className="hidden md:flex flex-1 overflow-hidden">
          {facet && <div className="w-[80px] flex-shrink-0 border-r border-gray-200 flex flex-col pt-1" aria-label="Class groups">
            <button onClick={() => setSelectedFacet('')} aria-pressed={!selectedFacet}
              className={`w-full text-left px-2 py-2 text-xs font-semibold hover:bg-gray-100 ${selectedFacet ? 'text-gray-500' : 'text-gray-900 bg-gray-50'}`}>All</button>
            {facet.values.map(entry => (
              <button key={entry.value} onClick={() => setSelectedFacet(entry.value)}
                aria-pressed={selectedFacet === entry.value}
                className={`w-full text-left px-2 py-2 text-xs border-l-2 ${selectedFacet === entry.value ? `border-current ${studioTones[entry.tone ?? 'neutral']}` : 'border-transparent text-gray-500 hover:bg-gray-100'}`}>
                <div>{entry.label}</div>
                {entry.description && <div className="text-[10px] opacity-70">{entry.description}</div>}
              </button>
            ))}
          </div>}

          {/* Column 2: Class list (flex-1, ~140px) */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-2 py-2 border-b border-gray-200">
              <span className="text-xs text-gray-600 font-semibold truncate">
                {facet?.values.find(entry => entry.value === selectedFacet)?.label ?? 'Classes'}
              </span>
              <button aria-label="New Class" onClick={openNewClass} className="text-xs bg-teal-700 text-white px-1.5 py-0.5 rounded flex-shrink-0">+</button>
            </div>

            {classDefs.filter(def => def.name !== facet?.tag &&
              (application.classFilterTags === undefined || application.classFilterTags.includes(def.name))).map(def => (
              <div key={def.name} className="px-1.5 py-1.5 border-b border-gray-200">
                <select aria-label={`Filter ${def.name}`}
                  className="w-full bg-gray-50 border border-gray-200 rounded px-1 py-0.5 text-xs text-gray-600"
                  value={classFilterTags[def.name] ?? ''}
                  onChange={e => setClassFilterTags(prev => ({ ...prev, [def.name]: e.target.value }))}>
                  <option value="">{def.name}: all</option>
                  {def.allowedValues.map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>
            ))}

            {/* Class list */}
            <div className="flex-1 overflow-y-auto">
              {!classesLoading && !classesError && classes.length > 0 && filteredClasses.length === 0 && <p role="status" className="p-2 text-xs text-gray-600">No classes match these filters.</p>}
              {filteredClasses.map(c => (
                <button
                  key={c.name}
                  onClick={() => setSelectedClass(c.name)}
                  className={`w-full text-left px-2 py-1.5 border-b border-gray-200 ${selectedClass === c.name ? 'bg-blue-50/40 text-teal-800' : 'text-gray-600 hover:bg-gray-100'}`}
                >
                  <div className="text-xs font-medium truncate">{c.name}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Right: entities */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {classesLoading && <p role="status" className="p-4 text-sm text-gray-500">Loading classes…</p>}
        {classesError && <div role="alert" className="p-4 text-sm text-red-700">{classesError} <button onClick={() => void loadClasses()} className="underline">Retry classes</button></div>}
        {!selectedClass && !classesLoading && !classesError && <div className="p-6">
          <h2 className="text-xl font-semibold mb-2">No classes yet</h2>
          <p className="text-sm text-gray-500 mb-4">Create a class to define its fields, then add entities to store your data.</p>
          <button onClick={openNewClass} className="bg-teal-700 text-white px-3 py-2 rounded text-sm">Create your first class</button>
        </div>}
        {selectedClass && (
          <>
            <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between gap-2 flex-wrap">
              <div>
                <div ref={classHeading} tabIndex={-1} className="font-semibold text-gray-900 dark:text-gray-100">{selectedClass}</div>
                {selectedClassInfo && Object.keys(selectedClassInfo.tags ?? {}).length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5" aria-label="Classification from selected class">
                    <span className="text-xs text-gray-500">From class:</span>
                    {Object.entries(selectedClassInfo.tags).map(([k, v]) => (
                      <TagBadge key={k} presentation={application.tags[k]} tagName={k} value={v} />
                    ))}
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <button onClick={event => { if (selectedClass) { deleteTrigger.current = event.currentTarget; setDeleteError(null); setDeleteTarget({ kind: 'class', id: selectedClass, name: selectedClass }); } }} className="text-xs px-2 py-1 rounded bg-red-50/50 text-red-700 border border-red-300 hover:bg-red-100">Delete Class</button>
                <button disabled={!classReady || loading} onClick={openNewEntity} className="text-xs px-2 py-1 rounded bg-teal-700 text-white hover:bg-teal-800">+ New Entity</button>
              </div>
            </div>

            <div className="flex-1 overflow-auto px-4 py-3">
              {loading ? (
                <div className="text-sm text-gray-500">Loading…</div>
              ) : !classReady ? (
                <p role="status" className="text-sm text-gray-500">Class fields could not be loaded. Check the error above before creating an entity.</p>
              ) : (
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="text-xs text-gray-500 border-b border-gray-200 dark:border-gray-700">
                      <th className="text-left py-2 pr-4">Name</th>
                      <th className="text-left py-2 pr-4">Description</th>
                      {schemaFields.map(([k]) => <th key={k} className="text-left py-2 pr-4">{k}</th>)}
                      <th className="text-left py-2 pr-4">Tags</th>
                      <th className="text-left py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entities.length === 0 ? (
                      <tr>
                        <td colSpan={schemaFields.length + 4} className="py-4 text-sm text-gray-500">No entities. Create one above.</td>
                      </tr>
                    ) : entities.map(entity => (
                      <tr key={entity.id} className="border-b border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-100/30">
                        <td className="py-2 pr-4">
                          <button disabled={!!entity.readError || !entity.data} onClick={event => openEditEntity(entity, event.currentTarget)} className="subtle-link text-sm text-left font-medium min-w-24 max-w-48 max-h-24 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] disabled:no-underline disabled:text-muted">{entity.name}</button>
                          <div className="text-gray-600 dark:text-gray-600 font-mono text-[10px]">{entity.id.slice(-8)}</div>
                          {entity.readError && <p role="alert" className="text-xs text-red-700 max-w-md">{entity.readError}</p>}
                        </td>
                        <td className="py-2 pr-4 text-gray-700 dark:text-gray-300"><div tabIndex={entity.desc.length > 120 ? 0 : undefined} className="min-w-20 max-w-xs max-h-24 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{entity.desc}</div></td>
                        {schemaFields.map(([k]) => (
                          <td key={k} className="py-2 pr-4 text-gray-700 dark:text-gray-400">
                            {entity.readError ? <span className="text-xs text-red-700">Unreadable</span> : <FieldValue v={entity.data?.[k]} />}
                          </td>
                        ))}
                        <td className="py-2 pr-4">
                          <div className="flex flex-wrap gap-1">
                            {Object.entries(entity.tags ?? {}).map(([k, v]) => (
                              <TagBadge
                                key={k}
                                presentation={application.tags[k]}
                                tagName={k}
                                value={v}
                                entityName={entity.name}
                                tagDef={(() => {
                                  const def = entityDefs.find(d => d.name === k);
                                  return def ? { ...def, allowedValues: allowedTagValues(def, effectiveTagValues(entityDefs, entity.tags)) } : undefined;
                                })()}
                                onChangeConfirmed={newVal => handleTagChange(entity.id, k, newVal)}
                              />
                            ))}
                          </div>
                        </td>
                        <td className="py-2 whitespace-nowrap">
                          <button disabled={!!entity.readError || !entity.data} onClick={event => openEditEntity(entity, event.currentTarget)} className="text-teal-800 hover:underline text-xs mr-3 disabled:opacity-40">Edit</button>
                          <button onClick={event => { deleteTrigger.current = event.currentTarget; setDeleteError(null); setDeleteTarget({ kind: 'entity', id: entity.id, name: entity.name }); }} className="text-red-700 hover:underline text-xs">Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>

      <Dialog.Root open={deleteTarget !== null} onOpenChange={open => { if (!open && !deleteBusy.current) setDeleteTarget(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60 z-40" />
          <Dialog.Content onCloseAutoFocus={event => { event.preventDefault(); if (deleteTrigger.current?.isConnected) deleteTrigger.current.focus(); }} className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(28rem,90vw)] bg-gray-50 text-gray-900 rounded-xl shadow-2xl p-5">
            <Dialog.Title className="text-lg font-semibold">Delete {deleteTarget?.kind} “{deleteTarget?.name}”?</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-gray-600">
              {deleteTarget?.kind === 'class' ? 'This permanently removes the empty class. Classes that still contain entities cannot be deleted.' : 'This permanently removes the selected entity.'} This cannot be undone.
            </Dialog.Description>
            {deleteError && <p role="alert" className="mt-3 text-sm text-red-700">{deleteError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close asChild><button disabled={deleting} className="rounded border px-3 py-1.5 text-sm">Cancel</button></Dialog.Close>
              <button disabled={deleting} onClick={() => void confirmDelete()} className="rounded bg-red-600 px-3 py-1.5 text-sm disabled:opacity-50">{deleting ? 'Deleting…' : `Delete ${deleteTarget?.kind ?? ''}`}</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* New Class Dialog */}
      <Dialog.Root open={newClassOpen} onOpenChange={open => { if (!saving) setNewClassOpen(open); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60 z-40" />
          <Dialog.Content onCloseAutoFocus={event => { event.preventDefault(); (classTrigger.current?.isConnected ? classTrigger.current : classHeading.current)?.focus(); }} className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-gray-50 border border-gray-200 rounded-xl shadow-2xl p-4 max-h-[85vh] overflow-y-auto">
            <Dialog.Title className="text-base font-semibold text-gray-900 mb-4">New Class</Dialog.Title>
            <Dialog.Description className="text-xs text-gray-600 mb-3">Add fields and choose their types. These fields become the form used to create and edit entities.</Dialog.Description>
            <div className="space-y-3">
              <div>
                <div className="text-xs text-gray-600 mb-1">Name</div>
                <input disabled={saving} aria-label="Class name" className="w-full bg-gray-50 border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-900" value={newClassName} onChange={e => { setNewClassName(e.target.value); setClassFormError(null); }} />
              </div>
              <div>
                <div className="text-xs text-gray-600 mb-1">Description</div>
                <input disabled={saving} aria-label="Class description" className="w-full bg-gray-50 border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-900" value={newClassDesc} onChange={e => { setNewClassDesc(e.target.value); setClassFormError(null); }} />
              </div>
              <ClassFieldsEditor value={classFieldsDraft} disabled={saving} onChange={draft => { setClassFieldsDraft(draft); setClassFormError(null); }} />
              {classDefs.length > 0 && (
                <div>
                  <div className="text-xs text-gray-500 font-semibold tracking-wide border-t border-gray-200 pt-3 mb-2">Class Tags</div>
                  <TagSection tagDefs={classDefs} values={newClassTags} onChange={setNewClassTags} />
                </div>
              )}
            </div>
            {classFormError && <p role="alert" className="text-sm text-red-700 mt-3">{classFormError}</p>}
            <div className="flex justify-end gap-2 mt-4">
              <Dialog.Close disabled={saving} className="px-3 py-1.5 text-sm bg-gray-50 text-gray-600 rounded">Cancel</Dialog.Close>
              <button onClick={handleCreateClass} disabled={saving || !classSchemaValid} className="px-4 py-1.5 text-sm bg-teal-700 text-white rounded disabled:opacity-50">{saving ? 'Creating…' : 'Create'}</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Entity Edit/Create Dialog */}
      <Dialog.Root open={entityDialogOpen} onOpenChange={setEntityDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60 z-40" />
          <Dialog.Content onCloseAutoFocus={event => { event.preventDefault(); if (entityTrigger.current?.isConnected) entityTrigger.current.focus(); }} className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-gray-50 border border-gray-200 rounded-xl shadow-2xl p-4 max-h-[85vh] overflow-y-auto">
            <Dialog.Title className="text-base font-semibold text-gray-900 mb-4">
              {editingEntity ? 'Edit Entity' : 'New Entity'}
            </Dialog.Title>
            <Dialog.Description className="text-xs text-gray-500 mb-3">Changes are saved only when you select Save. Closing this form, refreshing or leaving the page discards unsaved changes.</Dialog.Description>
            <div className="space-y-3">
              <div>
                <div className="text-xs text-gray-600 mb-1">Name {!editingEntity && <span className="text-red-700">*</span>}</div>
                <input
                  className="w-full bg-gray-50 border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-900 disabled:opacity-50"
                  aria-label="Entity name"
                  value={entityName}
                  onChange={e => { setEntityName(e.target.value); setEntityFormError(null); }}
                  disabled={!!editingEntity}
                />
              </div>
              <div>
                <div className="text-xs text-gray-600 mb-1">Description</div>
                <input aria-label="Entity description" disabled={!!editingEntity} className="w-full bg-gray-50 border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-900 disabled:opacity-50" value={entityDesc} onChange={e => setEntityDesc(e.target.value)} />
              </div>
              {editingEntity && <p className="text-xs text-gray-600">Name and description are set when the entity is created.</p>}
              {schemaFields.length > 0 && (
                <>
                  <div className="text-xs text-gray-500 font-semibold tracking-wide border-t border-gray-200 pt-3">Data Fields</div>
                  {schemaFields.map(([key, schemaVal]) => (
                    <SmartParamInput
                      key={key}
                      label={key}
                      type={inferType((schemaVal as Record<string, unknown>)?.type ?? schemaVal)}
                      value={entityFields[key]}
                      error={entityFieldErrors[key]}
                      onValidityChange={message => setEntityFieldErrors(previous => {
                        const next = { ...previous }; if (message) next[key] = message; else delete next[key]; return next;
                      })}
                      onChange={v => setEntityFields(prev => ({ ...prev, [key]: v }))}
                    />
                  ))}
                </>
              )}
              {!editingEntity && entityDefs.length > 0 && (
                <div>
                  <div className="text-xs text-gray-500 font-semibold tracking-wide border-t border-gray-200 pt-3 mb-2">Entity Tags</div>
                  <TagSection tagDefs={entityDefs} values={entityTags} onChange={setEntityTags} />
                </div>
              )}
              {editingEntity && Object.keys(editingEntity.tags ?? {}).length > 0 && (
                <div>
                  <div className="text-xs text-gray-500 font-semibold tracking-wide border-t border-gray-200 pt-3 mb-2">Tags</div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(editingEntity.tags).map(([k, v]) => (
                      <TagBadge key={k} presentation={application.tags[k]} tagName={k} value={v} />
                    ))}
                  </div>
                  <p className="text-xs text-gray-600 mt-2">Change tags by clicking badges in the table.</p>
                </div>
              )}
            </div>
            {entityFormError && <p role="alert" className="text-sm text-red-700 mt-3">{entityFormError}</p>}
            <div className="flex justify-end gap-2 mt-4">
              <Dialog.Close className="px-3 py-1.5 text-sm bg-gray-50 text-gray-600 rounded">Cancel</Dialog.Close>
              <button onClick={handleSaveEntity} disabled={saving || Object.keys(entityFieldErrors).length > 0} className="px-4 py-1.5 text-sm bg-teal-700 text-white rounded disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div></>
  );
}
