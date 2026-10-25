/// <reference path="./monaco-workers.d.ts" />
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import type { JsonEditorProps } from './JsonEditor';

// No AMD/CDN loader or remote schema lookup. Keep editor actions and language workers local.
self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === 'json') return new JsonWorker();
    if (['css', 'scss', 'less'].includes(label)) return new CssWorker();
    if (['html', 'handlebars', 'razor'].includes(label)) return new HtmlWorker();
    if (['typescript', 'javascript'].includes(label)) return new TypeScriptWorker();
    return new EditorWorker();
  },
};
monaco.json.jsonDefaults.setDiagnosticsOptions({ validate: true, allowComments: false, enableSchemaRequest: false, schemas: [] });
loader.config({ monaco });

export default function LocalJsonEditor({ value, onChange, onReady, readOnly = false, height = '200px' }: JsonEditorProps) {
  return <Editor height={height} defaultLanguage="json" value={value} theme="vs-dark"
    options={{ readOnly, minimap: { enabled: false }, scrollBeyondLastLine: false,
      fontSize: 12, lineNumbers: 'off', folding: false, wordWrap: 'on', ariaLabel: 'Schema JSON editor' }}
    onMount={() => onReady?.()} onChange={text => onChange?.(text ?? '')} />;
}
