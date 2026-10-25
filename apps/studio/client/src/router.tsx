import type { StudioBrand } from './lib/studio-brand';
import { createBrowserRouter, Link, Outlet } from 'react-router-dom';
import { Sidebar } from './components/layout/Sidebar';
import { DashboardPage } from './pages/DashboardPage';
import { HistoryPage } from './pages/HistoryPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { HumanNodePage } from './pages/HumanNodePage';
import { HumanInboxPage } from './pages/HumanInboxPage';
import { TranslatePage } from './pages/TranslatePage';
import { SchedulesPage } from './pages/SchedulesPage';
import { EntitiesPage } from './pages/EntitiesPage';
import { TopicsPage } from './pages/TopicsPage';
import { SettingsPage, type StudioSettingsExtension } from './pages/SettingsPage';
import { IntentsPage } from './pages/IntentsPage';
import type { ReactNode } from 'react';
import { useStudioFeature } from './context/StudioFeatures';

export interface StudioPageExtension {
  path: string;
  title: string;
  element: ReactNode;
  feature?: string;
  disabledMessage?: string;
}

function ExtensionRoute({ page }: { page: StudioPageExtension }) {
  const enabled = useStudioFeature(page.feature ?? '');
  return !page.feature || enabled ? page.element : <div>{page.disabledMessage ?? 'This feature is not enabled in this deployment.'}</div>;
}

function Layout({ extensions, brand }: { extensions: readonly StudioPageExtension[]; brand?: StudioBrand }) {
  return (
    <div className="studio-shell">
      <Sidebar extensions={extensions} brand={brand} />
      <main className="studio-main">
        <Outlet />
      </main>
    </div>
  );
}

export function createStudioRouter(extensions: readonly StudioPageExtension[] = [], settings: readonly StudioSettingsExtension[] = [], brand?: StudioBrand) {
  return createBrowserRouter([
    {
      element: <Layout extensions={extensions} brand={brand} />,
      children: [
        { path: '/', element: <DashboardPage /> },
        { path: '/history', element: <HistoryPage /> },
        { path: '/human', element: <HumanInboxPage /> },
        { path: '/topics/:filterId', element: <TopicsPage /> },
        { path: '/entities', element: <EntitiesPage /> },
        { path: '/runs/:id', element: <RunDetailPage /> },
        { path: '/runs/:id/human', element: <HumanNodePage /> },
        { path: '/translate', element: <TranslatePage /> },
        { path: '/translate/:sid', element: <TranslatePage /> },
        { path: '/intents', element: <IntentsPage /> },
        { path: '/schedules', element: <SchedulesPage /> },
        ...extensions.map(page => ({ path: page.path, element: <ExtensionRoute page={page} /> })),
        { path: '/settings', element: <SettingsPage extensions={settings} /> },
        { path: '*', element: (
          <section className="space-y-3">
            <h1 className="text-xl font-semibold">Page unavailable</h1>
            <p>This page does not exist or its extension is not installed in this deployment.</p>
            <Link to="/" className="text-blue-600 dark:text-blue-400 underline">Return to overview</Link>
          </section>
        ) },
      ],
    },
  ]);
}
