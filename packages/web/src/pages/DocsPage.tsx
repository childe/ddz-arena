import { useEffect, useState } from 'react';
import { marked } from 'marked';
import { api, errorText } from '../api.ts';

export function DocsPage() {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .docs()
      .then(async (md) => {
        const out = await marked.parse(md, { gfm: true });
        if (alive) setHtml(out);
      })
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, []);
  if (error) return <div className="page"><div className="error-box">接口文档加载失败：{error}</div></div>;
  if (html === null) return <div className="page muted">加载中…</div>;
  // Server-provided docs/api.md, rendered as-is.
  return <article className="page markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
