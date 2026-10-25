import {useEffect, useRef, type ReactNode} from 'react';

export interface GraphWorkspaceProps {
  children: ReactNode; details?: ReactNode; title?: string; subtitle?: string;
  selectionKey?: string; onClose(): void;
}

/** Keep the inspected step beside the graph, with independent scroll positions. */
export function GraphWorkspace({children, details, title, subtitle, selectionKey, onClose}: GraphWorkspaceProps) {
  const panel = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLElement | SVGElement | null>(null);
  const dismiss = useRef(onClose);
  dismiss.current = onClose;
  function dismissPanel() {
    dismiss.current();
    if (trigger.current?.isConnected) trigger.current.focus({preventScroll: true});
  }
  useEffect(() => {
    if (!selectionKey) return;
    const active = document.activeElement;
    if ((active instanceof HTMLElement || active instanceof SVGElement) && !panel.current?.contains(active)) trigger.current = active;
    if (body.current) body.current.scrollTop = 0;
    close.current?.focus({preventScroll: true});
  }, [selectionKey]);
  useEffect(() => {
    if (!selectionKey) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); dismissPanel(); }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [selectionKey]);
  return <div className="graph-workspace" data-inspecting={Boolean(selectionKey)}>
    <div className="graph-viewport">{children}</div>
    {selectionKey && <aside ref={panel} className="graph-inspector" aria-label={`Step details: ${title}`}>
      <header className="graph-inspector-heading">
        <div className="min-w-0"><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div>
        <button ref={close} onClick={dismissPanel} aria-label="Close step details" className="inspector-close">×</button>
      </header>
      <div ref={body} className="graph-inspector-body">{details}</div>
    </aside>}
  </div>;
}
