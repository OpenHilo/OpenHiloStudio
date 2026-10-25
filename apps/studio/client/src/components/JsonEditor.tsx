// platform/client/src/components/JsonEditor.tsx
import { lazy, Suspense } from 'react';

// Load the full editor only when a schema dialog is opened.
const LocalJsonEditor = lazy(() => import('./LocalJsonEditor'));

export interface JsonEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  height?: string;
  onReady?: () => void;
}

export function JsonEditor(props: JsonEditorProps) {
  return <Suspense fallback={<div role="status">Loading schema editor…</div>}>
    <LocalJsonEditor {...props} />
  </Suspense>;
}
