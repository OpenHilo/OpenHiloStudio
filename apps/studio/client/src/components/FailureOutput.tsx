import type {NodeIo} from '../api/run-artifacts';
import {CodeViewer} from './CodeViewer';
export function FailureOutput({data}: {data?: Pick<NodeIo, 'error' | 'diagnostics'>}) {
 const d=data?.diagnostics;
 return <section className="space-y-3 text-sm">
  <p className="text-muted">No validated output was recorded for this attempt.</p>
  {d?.rawOutputs !== undefined && <div><h4 className="font-semibold">Output before validation</h4><CodeViewer code={d.rawOutputs} /></div>}
  {d?.exitCode !== undefined && <p>Process exit code: {d.exitCode}</p>}
  {d?.stdout && <div><h4 className="font-semibold">stdout</h4><pre className="overflow-auto whitespace-pre-wrap break-words text-xs bg-slate-50 p-3 rounded">{d.stdout}</pre></div>}
  {d?.stderr && <div><h4 className="font-semibold">stderr</h4><pre className="overflow-auto whitespace-pre-wrap break-words text-xs bg-slate-50 p-3 rounded">{d.stderr}</pre></div>}
  {d?.truncated && <p className="text-muted">Diagnostic output was truncated.</p>}
  {!d && data?.error && <p className="text-red-700 whitespace-pre-wrap">{data.error}</p>}
 </section>;
}
