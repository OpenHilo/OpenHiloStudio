import { parseStudioBrand, type StudioBrand } from './lib/studio-brand';
export type { StudioBrand } from './lib/studio-brand';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { createStudioRouter, type StudioPageExtension } from './router';
export type { StudioPageExtension } from './router';
import { ThemeProvider } from './context/ThemeContext';
import { StudioFeaturesProvider } from './context/StudioFeatures';
import './index.css';
import type { StudioSettingsExtension } from './pages/SettingsPage';
export type { StudioSettingsExtension } from './pages/SettingsPage';

export function mountStudio(element: HTMLElement, extensions: readonly StudioPageExtension[] = [], settings: readonly StudioSettingsExtension[] = [], brand?: StudioBrand) {
  const selectedBrand = parseStudioBrand(brand);
  const previousTitle = document.title;
  if (selectedBrand) document.title = selectedBrand.title ?? selectedBrand.name;
  const router = createStudioRouter(extensions, settings, selectedBrand);
  const root = ReactDOM.createRoot(element);
  root.render(
    <React.StrictMode>
      <ThemeProvider>
        <StudioFeaturesProvider><RouterProvider router={router} /></StudioFeaturesProvider>
      </ThemeProvider>
    </React.StrictMode>
  );

  return { unmount() { root.unmount(); router.dispose(); if (selectedBrand) document.title = previousTitle; } };
}
