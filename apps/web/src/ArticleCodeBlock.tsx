import { useState } from 'react';
import { useEditorState, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { createLowlight } from 'lowlight';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';

const lowlight = createLowlight({ javascript, typescript, python, java, go, rust, bash, json, yaml, sql, css, xml, markdown });
lowlight.registerAlias({ javascript: ['jsx'], typescript: ['tsx'], xml: ['html'] });
const languages = ['plaintext', ...lowlight.listLanguages()];
function CodeBlockView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const [message, setMessage] = useState('');
  const editable = useEditorState({ editor, selector: ({ editor }) => editor.isEditable });
  const language = node.attrs.language || 'plaintext';
  return <NodeViewWrapper className="article-code-block">
    <div className="article-code-toolbar" contentEditable={false}>
      {editable ? <select aria-label="代码语言" value={language} onChange={e => { if (editor.isEditable) updateAttributes({ language: e.target.value === 'plaintext' ? null : e.target.value }); }}>
        {!languages.includes(language) && <option value={language}>{language}</option>}
        {languages.map(value => <option key={value} value={value}>{value === 'plaintext' ? '纯文本' : value}</option>)}
      </select> : <span>{language === 'plaintext' ? '纯文本' : language}</span>}
      <span className="code-copy-status" role="status">{message}</span>
      <button type="button" aria-label="复制代码" onClick={async () => {
        try { await navigator.clipboard.writeText(node.textContent); setMessage('已复制'); }
        catch { setMessage('复制失败，请选择代码手动复制'); }
      }}>复制</button>
    </div>
    <pre><NodeViewContent<'code'> as="code" className={node.attrs.language ? `language-${node.attrs.language}` : undefined}/></pre>
  </NodeViewWrapper>;
}
export const ArticleCodeBlock = CodeBlockLowlight.extend({
  addNodeView() { return ReactNodeViewRenderer(CodeBlockView); },
}).configure({ lowlight, defaultLanguage: 'plaintext' });
