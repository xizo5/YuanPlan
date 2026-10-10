import { Extension, getSchema, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Code from '@tiptap/extension-code';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { MarkdownManager } from '@tiptap/markdown';

export const emptyDoc: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };
export function editorExtensions({ codeBlock = true }: { codeBlock?: boolean } = {}) {
  return [StarterKit.configure({ code: false, codeBlock: codeBlock ? {} : false, link: { openOnClick: false }, underline: false }), Code.extend({ excludes: '' }), Image.configure({ allowBase64: false }), TableKit, TaskList, TaskItem.configure({ nested: true })];
}
const schema = getSchema(editorExtensions());
const manager = new MarkdownManager({ extensions: editorExtensions() });
// Parse Markdown's HTML line-break shorthand as native nodes on both server
// and browser; generic HTML parsing depends on a browser DOM and is lossy here.
manager.instance.use({ extensions: [
  {
    name: 'markdownBreakBlock', level: 'block',
    start: source => source.search(/^<br\s*\/?>[ \t]*(?:\r?\n|$)/im),
    tokenizer(source) {
      const match = /^(?:<br\s*\/?>[ \t]*(?:\r?\n|$))+/i.exec(source);
      if (match) return { type: 'markdownBreakBlock', raw: match[0] };
    },
  },
  {
    name: 'markdownBreakInline', level: 'inline',
    start: source => source.search(/<br\s*\/?>/i),
    tokenizer(source) {
      const match = /^<br\s*\/?>/i.exec(source);
      if (match) return { type: 'br', raw: match[0] };
    },
  },
] });
manager.registerExtension(Extension.create({
  name: 'markdownBreakBlock',
  parseMarkdown: token => ({ type: 'paragraph', content: [...(token.raw ?? '').matchAll(/<br\s*\/?>/gi)].map(() => ({ type: 'hardBreak' })) }),
}));
const allowedNodes = new Set(['doc','paragraph','heading','text','bulletList','orderedList','listItem','taskList','taskItem','blockquote','codeBlock','horizontalRule','hardBreak','image','table','tableRow','tableHeader','tableCell']);
const allowedMarks = new Set(['bold','italic','strike','code','link']);
export function validateDoc(input: unknown): JSONContent {
  if (!input || typeof input !== 'object' || JSON.stringify(input).length > 1_000_000) throw new Error('文档格式无效或超过 1MB');
  let count = 0;
  function visit(n: JSONContent, depth = 0) {
    if (++count > 20000 || depth > 30 || !n.type || !allowedNodes.has(n.type)) throw new Error('不支持的文档结构');
    if (n.type === 'image' && (typeof n.attrs?.src !== 'string' || !/^\/api\/files\/[0-9a-f-]+$/.test(n.attrs.src))) throw new Error('图片必须使用项目内上传的附件');
    for (const m of n.marks ?? []) {
      if (!allowedMarks.has(m.type)) throw new Error('不支持的文本格式');
      if (m.type === 'link' && !/^(https?:\/\/|mailto:|\/(?!\/))/.test(String(m.attrs?.href ?? ''))) throw new Error('链接协议无效');
    }
    for (const child of n.content ?? []) visit(child, depth + 1);
  }
  visit(input as JSONContent);
  if ((input as JSONContent).type !== 'doc') throw new Error('根节点必须为 doc');
  const node = schema.nodeFromJSON(input);
  node.check();
  return node.toJSON();
}
export function docText(doc: JSONContent): string {
  return schema.nodeFromJSON(doc).textBetween(0, schema.nodeFromJSON(doc).content.size, '\n');
}
export function imageIds(doc: JSONContent): string[] {
  const ids: string[] = [];
  function walk(n: JSONContent) { if (n.type === 'image') ids.push(String(n.attrs?.src).split('/').at(-1)!); n.content?.forEach(walk); }
  walk(doc); return [...new Set(ids)];
}
export function fromMarkdown(text: string): JSONContent {
  if (!text.trim()) return validateDoc(emptyDoc);
  if (text.length > 1_000_000) throw new Error('文档过大');
  manager.instance.walkTokens(manager.instance.lexer(text), token => {
    if (token.type === 'html') {
      throw new Error('暂不支持此原始 HTML 标签；换行可使用 <br>，HTML 示例请放在代码块中');
    }
  });
  return validateDoc(manager.parse(text));
}
export function toMarkdown(doc: JSONContent): { markdown: string; lossless: boolean } {
  const normalized = validateDoc(doc);
  const markdown = manager.serialize(normalized);
  let lossless = false;
  try { lossless = JSON.stringify(fromMarkdown(markdown)) === JSON.stringify(normalized); } catch { /* fail closed */ }
  return { markdown, lossless };
}
