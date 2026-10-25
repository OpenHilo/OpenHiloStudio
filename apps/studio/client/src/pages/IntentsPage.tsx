import { getStudioApplication } from '../api/application';
import { GENERIC_STUDIO_APPLICATION, type StudioApplication } from '@openhilo/studio-contracts';
import { TagBadge } from '../components/TagBadge';
import { filterWorkflowMetadata } from '../lib/workflow-presentation';
import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { listNamespaces, getNamespaceDetail } from '../api/namespaces';
import { getIntentItt } from '../api/namespaces';
import type { NamespaceIndex, NsDetail, IntentDetail, IttJson } from '../api/namespaces';
import { CodeViewer } from '../components/CodeViewer';
import { RunTriggerDialog } from '../components/RunTriggerDialog';
import { IttFlowchart } from '../components/IttFlowchart';
import { WorkflowGraph } from '../components/WorkflowGraph';
import { listIntents } from '../api/entities';
import {resolveWorkflowReference} from '../lib/workflow-links';

export function IntentsPage() {
  const navigate = useNavigate();
  const [application, setApplication] = useState<StudioApplication>(GENERIC_STUDIO_APPLICATION);
  const [applicationError, setApplicationError] = useState('');
  const [facetFilter, setFacetFilter] = useState('');
  const [tagFilters, setTagFilters] = useState<Record<string, string>>({});
  useEffect(() => {
    const controller = new AbortController();
    void getStudioApplication(controller.signal).then(setApplication).catch(error => { if (!controller.signal.aborted) setApplicationError(String(error)); });
    return () => controller.abort();
  }, []);
  const [search, setSearch] = useSearchParams();
  const source = search.get('source') ?? undefined, hint = search.get('intent') ?? undefined;
  const fromRun = search.get('fromRun');
  const [referenceError, setReferenceError] = useState('');
  const [referenceTarget, setReferenceTarget] = useState<{ns:string; name:string} | null>(null);
  const openedReference = useRef('');
  const [namespaces, setNamespaces] = useState<NamespaceIndex[]>([]);
  const [selectedNs, setSelectedNs] = useState<string | null>(null);
  const [nsDetail, setNsDetail] = useState<NsDetail | null>(null);
  const [nsLoading, setNsLoading] = useState(false);
  const [openItt, setOpenItt] = useState<string | null>(null);
  const [ittData, setIttData] = useState<IttJson | null>(null);
  const [ittTab, setIttTab] = useState<'ts' | 'graph' | 'impl' | 'leaf'>('ts');
  const [ittLoading, setIttLoading] = useState(false);
  const [runIntent, setRunIntent] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [nsError, setNsError] = useState<string | null>(null);
  const [ittError, setIttError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [nsReload, setNsReload] = useState(0);
  const ittController = useRef<AbortController | null>(null);
  const ittRequest = useRef(0);
  useEffect(() => () => { ittRequest.current++; ittController.current?.abort(); }, []);

  // Load namespace list on mount
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setListLoading(true); setListError(null);
    listNamespaces(controller.signal, facetFilter)
      .then(list => {
        if (!active) return;
        setNamespaces(list);
        setSelectedNs(prev => {
          const stillValid = list.find(n => n.namespace === prev);
          return stillValid ? prev : (!source && !hint && list.length > 0 ? list[0].namespace : null);
        });
      })
      .catch(error => { if (active) setListError(String(error)); })
      .finally(() => { if (active) setListLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [reload, facetFilter]);

  useEffect(() => {
    if ((!source && !hint) || !namespaces.length) return;
    let active = true;
    openedReference.current = ''; setReferenceTarget(null); setSelectedNs(null); setReferenceError('');
    void listIntents().then(items => {
      if (!active) return;
      const found = resolveWorkflowReference(items, source, hint);
      const matches = found ? namespaces.flatMap(ns => ns.intents.filter(name => `${ns.namespace}.${name}` === found.name).map(name => ({ns:ns.namespace,name}))) : [];
      if (matches.length !== 1) {setReferenceError('This workflow definition is no longer available, or its identity is ambiguous. The original run remains available.'); return;}
      setSelectedNs(matches[0].ns); setReferenceTarget(matches[0]);
    }).catch(error => {if (active) setReferenceError(`Unable to locate this workflow: ${String(error)}`);});
    return () => {active = false;};
  }, [source, hint, namespaces]);
  useEffect(() => {
    if (!referenceTarget || nsDetail?.namespace !== referenceTarget.ns || nsLoading) return;
    const key = `${source ?? hint}:${referenceTarget.ns}:${referenceTarget.name}`;
    if (openedReference.current === key) return;
    openedReference.current = key;
    void handleToggleItt(referenceTarget.name, true);
  }, [referenceTarget, nsDetail, nsLoading]);

  // Load namespace detail when selection changes
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    ittController.current?.abort();
    ittRequest.current++;
    if (!selectedNs) { setNsDetail(null); setNsLoading(false); setNsError(null); return; }
    setNsLoading(true);
    setNsError(null);
    setNsDetail(null);
    setOpenItt(null);
    getNamespaceDetail(selectedNs, controller.signal)
      .then(detail => { if (active) setNsDetail(detail); })
      .catch(error => { if (active) setNsError(String(error)); })
      .finally(() => { if (active) setNsLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [selectedNs, nsReload]);

  function handleFacetSelect(value: string) {
    if (value === facetFilter) return;
    const next = new URLSearchParams(search);
    next.delete('source'); next.delete('intent');
    setSearch(next, { replace: true });
    setReferenceTarget(null); setReferenceError('');
    setTagFilters({}); setFacetFilter(value);
    setNamespaces([]); setSelectedNs(null); setNsDetail(null); setListLoading(true);
  }

  function handleNsSelect(ns: string) {
    if (ns === selectedNs) return;
    ittRequest.current++;
    setTagFilters({});
    setSelectedNs(ns);
    setNsDetail(null);
    setNsLoading(true);
    setOpenItt(null);
  }

  async function handleToggleItt(intentName: string, retry = false) {
    ittController.current?.abort();
    const request = ++ittRequest.current;
    if (openItt === intentName && !retry) { setOpenItt(null); setIttLoading(false); return; }
    if (!selectedNs) return;
    setIttLoading(true);
    setOpenItt(intentName);
    setIttData(null);
    setIttError(null);
    const controller = new AbortController(); ittController.current = controller;
    try {
      const data = await getIntentItt(selectedNs, intentName, controller.signal);
      if (request !== ittRequest.current) return;
      setIttData(data);
      // Default tab: TS if available, else graph if impl exists, else leaf
      setIttTab(data.ts ? 'ts' : data.impl ? 'graph' : 'leaf');
    } catch (error) {
      if (request === ittRequest.current) { setIttData(null); setIttError(String(error)); }
    } finally {
      if (request === ittRequest.current) setIttLoading(false);
    }
  }

  const visibleIntents = filterWorkflowMetadata(nsDetail?.intents ?? [], facetFilter, tagFilters);
  const visibleEntries = visibleIntents.filter(intent => intent.isEntry).map(intent => intent.name);

  return (
    <div>
      <header className="page-heading"><div><h1>Workflow library</h1><p>Explore your workflows and their reusable functions.</p></div><Link to="/translate" className="primary-action">Create workflow</Link></header>
      {fromRun && <p className="mb-4 text-sm text-muted">Library definitions show the current version. <Link className="subtle-link" to={`/runs/${encodeURIComponent(fromRun)}`}>Return to original run</Link></p>}
      {referenceError && <p role="alert" className="mb-4 border border-amber-200 bg-amber-50 text-amber-900 p-3 rounded">{referenceError}</p>}
      {listError && <div role="alert" className="mb-3 text-sm text-red-600">Unable to load the workflow library: {listError} <button className="underline" onClick={() => setReload(v => v + 1)}>Retry library</button></div>}

      {applicationError && <p role="alert" className="mb-3 text-sm text-red-700">Application display settings unavailable: {applicationError}</p>}
      <div className="flex flex-col md:flex-row gap-3 min-h-[70vh]">
        {application.workflowFacet && <nav aria-label={`Workflow ${application.workflowFacet.label} groups`} className="flex md:flex-col gap-1 md:w-28 shrink-0 overflow-x-auto md:overflow-visible border-b md:border-b-0 md:border-r border-gray-200 pb-2 md:pb-0 md:pr-2">
          {[{ value: '', label: 'All' }, ...application.workflowFacet.values].map(entry => <button
            key={entry.value}
            type="button"
            aria-pressed={facetFilter === entry.value}
            onClick={() => handleFacetSelect(entry.value)}
            className={`shrink-0 px-3 py-3 rounded text-left text-sm transition-colors ${facetFilter === entry.value ? 'bg-teal-50 text-teal-800 font-semibold ring-1 ring-inset ring-teal-200' : 'text-gray-600 hover:bg-gray-100'}`}
          >{entry.label}</button>)}
        </nav>}
        {/* Sidebar */}
        <div className="w-full md:w-44 max-h-48 md:max-h-[70vh] shrink-0 bg-white border border-gray-200 rounded-lg overflow-hidden flex flex-col">
          {/* Namespace list */}
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {listLoading && <div role="status" className="p-3 text-sm">Loading library…</div>}
            {!listLoading && !listError && namespaces.length === 0 && (
              <div className="text-xs text-gray-600 px-2 py-4 text-center">{facetFilter ? 'No matching namespaces' : 'No namespaces'}</div>
            )}
            {namespaces.map(n => (
              <button
                key={n.namespace}
                onClick={() => handleNsSelect(n.namespace)}
                className={`w-full text-left px-2 py-2 rounded text-sm transition-colors ${
                  selectedNs === n.namespace
                    ? 'bg-blue-50 text-teal-800 font-medium'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span>{n.namespace}</span>
                  <span className="text-xs text-gray-600">{n.intents.length}</span>
                </div>
                {n.entries.length > 0 && (
                  <div className="text-xs text-green-600 mt-0.5 truncate">⬤ {n.entries.join(', ')}</div>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Detail panel */}
        <div className="flex-1 min-w-0 bg-white border border-gray-200 rounded-lg overflow-auto">
          {nsLoading && (
            <div className="p-8 text-sm text-gray-600 text-center">Loading…</div>
          )}

          {nsError && <div role="alert" className="p-4 text-sm text-red-600">Unable to load this namespace: {nsError} <button className="underline" onClick={() => setNsReload(v => v + 1)}>Retry namespace</button></div>}
          {!listLoading && !listError && !nsLoading && !nsError && !nsDetail && (
            namespaces.length === 0 && facetFilter ? <div className="p-8 text-sm text-gray-600 text-center">No workflows in this group. <button className="subtle-link" onClick={() => handleFacetSelect('')}>View all workflows</button></div> : namespaces.length === 0 ? <div className="p-8 text-sm text-gray-600 text-center">
              <h2 className="text-lg font-semibold text-gray-900 mb-2">No workflows yet</h2>
              <p>Describe a task, review the generated workflow and approve it to add it to this library.</p>
              <button onClick={() => navigate('/translate')} className="mt-4 px-3 py-2 rounded bg-teal-700 text-white">Create your first workflow</button>
            </div> : <div className="p-8 text-sm text-gray-600 text-center">Select a namespace</div>
          )}

          {!nsLoading && nsDetail && (
            <>
              {/* Header */}
              <div className="px-5 py-3 border-b border-gray-100 flex flex-wrap gap-2 items-center justify-between">
                <div className="flex flex-wrap items-center gap-3 break-all">
                  <span className="font-semibold text-gray-900">{nsDetail.namespace}</span>
                  <span className="text-xs text-gray-600">{visibleIntents.length} function{visibleIntents.length !== 1 ? 's' : ''}</span>
                  {visibleEntries.length > 0 && (
                    <span className="text-xs bg-green-50 text-green-700 border border-green-200 rounded px-2 py-0.5">
                      {visibleEntries.length === 1 ? 'entry' : 'entries'}: {visibleEntries.join(', ')}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => navigate('/translate')}
                  className="text-xs text-gray-500 hover:text-gray-700"
                >
                  + Create workflow →
                </button>
              </div>

              {!!application.workflowFilterTags?.length && <div className="px-5 py-3 flex flex-wrap gap-3">
                {application.workflowFilterTags?.map(tag => <label key={tag} className="text-sm">{tag}<select className="block rounded border p-2" value={tagFilters[tag] ?? ''} onChange={e => setTagFilters(previous => ({ ...previous, [tag]: e.target.value }))}><option value="">All</option>{[...new Set(nsDetail.intents.flatMap(i => i.tags?.[tag] ? [i.tags[tag]] : []))].sort().map(value => <option key={value}>{value}</option>)}</select></label>)}
              </div>}
              {nsDetail.intents.length > 0 && !visibleIntents.length && <p className="p-5 text-sm">No workflows match these filters.</p>}
              {/* Intent rows */}
              {nsDetail.intents.length === 0 && (
                <div className="p-8 text-sm text-gray-600 text-center">No functions in this namespace</div>
              )}
              {visibleIntents.map((intent: IntentDetail) => (
                <div key={intent.name} className="border-b border-gray-50 last:border-0">
                  <div className="px-5 py-3 flex flex-wrap gap-2 items-center justify-between hover:bg-gray-50 transition-colors">
                    {/* Left: name + badges */}
                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                      <button onClick={() => void handleToggleItt(intent.name)} className="font-mono text-sm font-semibold text-teal-800 hover:underline">{intent.name}</button>
                      {application.workflowFacet && <span className="text-xs text-gray-600">{application.workflowFacet.label}: {application.workflowFacet.values.find(v => v.value === intent.facet)?.label ?? intent.facet ?? 'Not recorded'}</span>}
                      {Object.entries(intent.tags ?? {}).map(([key,value]) => <TagBadge key={key} tagName={key} value={value} presentation={application.tags[key]} />)}
                      {intent.isEntry && (
                        <span className="text-xs bg-green-50 text-green-700 border border-green-200 rounded px-1.5 py-0.5">entry</span>
                      )}
                      {intent.hasTs && (
                        <span className="text-xs text-purple-600 font-mono">.ts</span>
                      )}
                      {intent.desc && (
                        <span className="text-xs text-gray-600 truncate max-w-xs">{intent.desc}</span>
                      )}
                    </div>

                    {/* Right: actions */}
                    <div className="flex gap-2 shrink-0 ml-3">
                      <button
                        onClick={() => setRunIntent(`${nsDetail.namespace}.${intent.name}`)}
                        className="text-xs px-2.5 py-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 font-medium"
                      >
                        ▶ Run
                      </button>
                      <button
                        onClick={() => void handleToggleItt(intent.name)}
                        className={`text-xs px-2.5 py-1 rounded border font-medium ${
                          openItt === intent.name
                            ? 'bg-blue-50 border-blue-200 text-teal-800'
                            : 'border-blue-100 text-teal-700 hover:bg-blue-50'
                        }`}
                      >
                        {openItt === intent.name ? 'Hide details' : 'View details'}
                      </button>
                      <button
                        onClick={() => intent.hasTs && navigate('/translate', { state: { naturalLanguage: `Update the existing workflow ${selectedNs}.${intent.name}. Preserve its existing source and behavior unless requested otherwise.\nRequested changes: ` } })}
                        disabled={!intent.hasTs}
                        title={intent.hasTs ? 'Describe changes to this workflow; review the generated changes before publishing' : 'No .ts source — created without translator'}
                        className="text-xs px-2.5 py-1 rounded border border-purple-100 text-purple-600 hover:bg-purple-50 font-medium disabled:opacity-40 disabled:cursor-default"
                      >
                        Revise
                      </button>
                    </div>
                  </div>

                  {/* Workflow definition viewer */}
                  {openItt === intent.name && (
                    <div className="px-5 pb-3">
                      {ittLoading ? (
                        <div className="text-xs text-gray-600 py-2">Loading…</div>
                      ) : ittData ? (
                        <div className="border border-gray-200 rounded-lg overflow-hidden">
                          {/* Tab bar */}
                          <div className="flex border-b border-gray-200 bg-gray-50">
                            {([
                              ...(ittData.ts ? [{ key: 'ts' as const, label: 'TypeScript' }] : []),
                              ...(ittData.impl ? [{ key: 'graph' as const, label: 'Workflow' }] : []),
                              ...(ittData.impl ? [{ key: 'impl' as const, label: 'Execution JSON' }] : []),
                              { key: 'leaf' as const, label: 'Interface JSON' },
                            ]).map(({ key, label }) => (
                              <button
                                key={key}
                                onClick={() => setIttTab(key)}
                                className={`px-3 py-1.5 text-xs font-semibold border-b-2 transition-colors -mb-px ${
                                  ittTab === key
                                    ? 'border-blue-300 text-teal-800 bg-white'
                                    : 'border-transparent text-gray-500 hover:text-gray-700'
                                }`}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                          {/* Content */}
                          <div className="min-w-0">
                            {ittTab === 'ts' && ittData.ts && (
                              <CodeViewer code={ittData.ts} lang="typescript" className="text-xs" />
                            )}
                            {ittTab === 'graph' && ittData.impl && (() => {
                              const impl = ittData.impl as { nodes: Record<string, unknown>; entry: string };
                              return <div className="p-3"><WorkflowGraph nodes={impl.nodes as never} entry={impl.entry} /></div>;
                            })()}
                            {ittTab === 'impl' && ittData.impl && (
                              <CodeViewer code={JSON.stringify(ittData.impl, null, 2)} lang="json" className="text-xs" />
                            )}
                            {ittTab === 'leaf' && (
                              <CodeViewer code={JSON.stringify(ittData.leaf, null, 2)} lang="json" className="text-xs" />
                            )}
                          </div>
                        </div>
                      ) : (
                        <div role="alert" className="text-xs text-red-500 py-2">Failed to load workflow: {ittError} <button className="underline" onClick={() => void handleToggleItt(intent.name, true)}>Retry</button></div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Run dialog */}
      <RunTriggerDialog
        open={runIntent !== null}
        onOpenChange={open => { if (!open) setRunIntent(null); }}
        prefillIntent={runIntent ?? undefined}
      />
    </div>
  );
}
