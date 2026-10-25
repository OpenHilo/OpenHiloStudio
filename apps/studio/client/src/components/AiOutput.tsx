import {useEffect, useRef, useState} from 'react';

/** Provider messages and tool output only; plain text, bounded and independently scrollable. */
export function AiOutput({text, live = false}: {text: string; live?: boolean}) {
  const viewport = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  const [follow, setFollow] = useState(true);
  useEffect(() => { if (following.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }, [text]);
  if (!text && !live) return null;
  return <details className="ai-output my-3 rounded-lg border border-slate-200 bg-white" open={live || undefined}>
    <summary className="cursor-pointer px-4 py-2 text-sm font-semibold text-slate-700">AI output{live ? ' · Live' : ''}</summary>
    <pre ref={viewport} aria-label="AI output" onScroll={() => {
      const el = viewport.current!; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32; setFollow(following.current);
    }} className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-4 py-3 text-xs font-mono font-normal text-slate-700 border-t border-slate-100">{text.slice(-64_000) || 'Waiting for provider output…'}</pre>
    {!follow && <button className="text-xs underline px-4 py-2 text-teal-700" onClick={() => { following.current = true; setFollow(true); if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }}>Follow latest output</button>}
  </details>;
}
