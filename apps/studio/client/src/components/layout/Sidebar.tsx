import type { StudioBrand } from '../../lib/studio-brand';
// platform/client/src/components/layout/Sidebar.tsx
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { listFilters, type SavedFilter } from '../../api/filters';
import { useStudioFeature, useStudioFeaturesStatus } from '../../context/StudioFeatures';
import type { StudioPageExtension } from '../../router';

const wordmarkUrl = new URL('../../assets/openhilo-navbar.png', import.meta.url).href;
const thirdPartyNoticesUrl = new URL('../../../../THIRD_PARTY_NOTICES.html', import.meta.url).href;

function ExtensionLink({ page, className }: { page: StudioPageExtension; className: string | ((props: { isActive: boolean }) => string) }) {
  const enabled = useStudioFeature(page.feature ?? '');
  return !page.feature || enabled ? <NavLink to={page.path} className={className}>{page.title}</NavLink> : null;
}

export function Sidebar({ extensions, brand }: { extensions: readonly StudioPageExtension[]; brand?: StudioBrand }) {
  const [failedLogo, setFailedLogo] = useState<string | undefined>();
  const logo = brand ? brand.logoUrl : wordmarkUrl;
  const features = useStudioFeaturesStatus();
  const [filters, setFilters] = useState<SavedFilter[]>([]);
  const [filtersError, setFiltersError] = useState('');
  const [filtersLoading, setFiltersLoading] = useState(false);
  const [filtersReload, setFiltersReload] = useState(0);
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    let active = true;
    let controller: AbortController;
    const refresh = () => {
      controller?.abort();
      const request = new AbortController(); controller = request;
      setFiltersLoading(true);
      void listFilters(request.signal)
        .then(next => { if (active && !request.signal.aborted) { setFilters(next); setFiltersError(''); } })
        .catch(error => { if (active && !request.signal.aborted) setFiltersError(error instanceof Error ? error.message : 'Could not load saved views.'); })
        .finally(() => { if (active && !request.signal.aborted) setFiltersLoading(false); });
    };
    refresh(); window.addEventListener('intentorch:filters-updated', refresh);
    return () => { active = false; controller.abort(); window.removeEventListener('intentorch:filters-updated', refresh); };
  }, [filtersReload]);

  const linkClass = () => 'studio-nav-link';

  return (
    <aside className="studio-sidebar"
      onKeyDown={event => { if (event.key === 'Escape' && open) { setOpen(false); toggle.current?.focus(); } }}>
      <div className="flex items-center justify-between gap-3 md:mb-6">
        <Link to="/" className="studio-brand" aria-label={`${brand?.name ?? 'OpenHilo Studio'} home`}>
          {logo && failedLogo !== logo ? <img src={logo} width="600" height="156" alt={brand?.name ?? 'OpenHilo'} onError={() => setFailedLogo(logo)} /> : <span className="font-bold text-xl break-words">{brand?.name ?? 'OpenHilo'}</span>}
          {!brand && <small>Studio</small>}
        </Link>
        <button ref={toggle} type="button" aria-expanded={open} aria-controls="studio-navigation" onClick={() => setOpen(value => !value)}
          className="md:hidden shrink-0 rounded border px-3 py-1.5 text-sm text-gray-700 focus-visible:ring-2 focus-visible:ring-blue-500">{open ? 'Close menu' : 'Menu'}</button>
      </div>
      <nav id="studio-navigation" aria-label="Main navigation" className={`${open ? 'flex' : 'hidden'} md:flex flex-col min-h-0 md:flex-1 overflow-y-auto max-h-[70dvh] md:max-h-none mt-3 md:mt-0`}>
      <NavLink to="/" end className={linkClass}>Overview</NavLink>
      <NavLink to="/history" className={linkClass}>Runs</NavLink>
      <NavLink to="/human" className={linkClass}>Human inbox</NavLink>
      <div className="studio-nav-label">Build</div>
      <NavLink to="/translate" className={linkClass}>Create workflow</NavLink>
      <NavLink to="/intents" className={linkClass}>Workflow library</NavLink>
      <div className="studio-nav-label">Workspace</div>
      <NavLink to="/entities" className={linkClass}>Data</NavLink>
      <NavLink to="/schedules" className={linkClass}>Schedules</NavLink>
      {filters.length > 0 && <div className="studio-nav-label">Saved views</div>}
      {filtersError && <div role="alert" className="px-3 text-xs text-red-700">Could not load saved views. {filtersError} <button disabled={filtersLoading} className="underline disabled:opacity-40" onClick={() => setFiltersReload(value => value + 1)}>Retry saved views</button></div>}
      {filters.map(f => (
        <NavLink key={f.id} to={`/topics/${f.id}`} className={linkClass}>{f.name}</NavLink>
      ))}
      {features.error && <div role="alert" className="px-3 py-2 text-xs text-red-700">Could not check optional pages. {features.error} <button disabled={features.loading} className="underline disabled:opacity-40" onClick={features.retry}>{features.loading ? 'Checking optional pages…' : 'Retry optional pages'}</button></div>}
      {extensions.map(page => <ExtensionLink key={page.path} page={page} className={linkClass} />)}
      <NavLink to="/settings" className={() => `${linkClass()} mt-auto`}>Settings</NavLink>
      <a href={thirdPartyNoticesUrl} className="mt-2 px-3 text-xs text-gray-500 hover:underline">Third-party notices</a>
      </nav>
    </aside>
  );
}
