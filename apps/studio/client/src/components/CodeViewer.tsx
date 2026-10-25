// platform/client/src/components/CodeViewer.tsx
import { useEffect, useState } from 'react';
import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';

interface Props {
  code: string;
  lang?: 'typescript' | 'json';
  className?: string;
}

// ── Synchronous JSON syntax highlighter ──────────────────────────────────────

function highlightJson(raw: string): string {
  const escaped = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return escaped.replace(
    /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      if (match.startsWith('"')) {
        if (/"\s*:$/.test(match)) return `<span style="color:#116149">${match}</span>`;
        return `<span style="color:#175b9c">${match}</span>`;
      }
      if (match === 'true' || match === 'false') return `<span style="color:#9e382e">${match}</span>`;
      if (match === 'null') return `<span style="color:#60717b">${match}</span>`;
      return `<span style="color:#7040a0">${match}</span>`; // number
    }
  );
}

// ── Async TypeScript highlighting via Shiki ───────────────────────────────────
// Explicit imports keep unused third-party grammars/themes out of distributed assets.
// Cache the promise across viewers; a failed load can be retried by the next viewer.
let highlighter: ReturnType<typeof createHighlighterCore> | undefined;
function getHighlighter() {
  return highlighter ??= createHighlighterCore({
    themes: [import('shiki/dist/themes/github-dark-default.mjs'), import('shiki/dist/themes/github-light.mjs')],
    langs: [import('shiki/dist/langs/typescript.mjs')],
    engine: createOnigurumaEngine(import('shiki/wasm')),
  }).catch(error => { highlighter = undefined; throw error; });
}

async function highlightTs(
  code: string,
  shikiTheme: 'github-dark-default' | 'github-light',
): Promise<string> {
  const hl = await getHighlighter();
  const html = hl.codeToHtml(code, { lang: 'typescript', theme: shikiTheme });
  // codeToHtml returns <pre ...><code>...</code></pre> — extract the inner tokens only.
  const match = html.match(/<code>([\s\S]*?)<\/code>/);
  return match
    ? match[1]
    : code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CodeViewer({ code, lang = 'json', className = '' }: Props) {
  const shikiTheme = 'github-light';

  const [highlightedTs, setHighlightedTs] = useState<string | null>(null);
  const [wrapLines, setWrapLines] = useState(true);

  useEffect(() => {
    setHighlightedTs(null);
    if (lang !== 'typescript') return;
    let cancelled = false;
    highlightTs(code, shikiTheme)
      .then((html) => {
        if (!cancelled) setHighlightedTs(html);
      })
      .catch((err) => {
        console.error('[CodeViewer] Shiki error:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang, shikiTheme]);

  if (lang === 'json') {
    return (
      <pre
        className={`bg-[#f6f8fa] text-[#203039] rounded p-3 min-w-0 max-w-full overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] text-xs font-mono leading-relaxed ${className}`}
        dangerouslySetInnerHTML={{ __html: highlightJson(code) }}
      />
    );
  }

  // TypeScript — show plain text until Shiki resolves (usually one render cycle)
  const bgText = 'bg-[#ffffff] text-[#24292e]';

  return (
    <div className="min-w-0 max-w-full">
      <div className="flex justify-end mb-1">
        <label className="inline-flex min-h-9 items-center gap-2 text-xs text-muted cursor-pointer">
          <input type="checkbox" className="accent-teal-700" checked={wrapLines} onChange={event => setWrapLines(event.target.checked)} />Wrap lines
        </label>
      </div>
      <pre
        className={`${bgText} rounded p-3 min-w-0 max-w-full overflow-auto text-xs font-mono leading-relaxed ${wrapLines ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'} ${className}`}
        dangerouslySetInnerHTML={highlightedTs ? { __html: highlightedTs } : undefined}
      >
        {highlightedTs ? undefined : code}
      </pre>
    </div>
  );
}
