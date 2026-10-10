import { describe, expect, it } from 'vitest';
import { fromMarkdown, toMarkdown, validateDoc } from '@yuanplan/editor-schema';

describe('article Markdown compatibility', () => {
  it('preserves headings, inline formatting, nested lists, tables and task lists', () => {
    const source = '# 标题\n\n## 小节\n\n### 三级\n\n#### 四级\n\n##### 五级\n\n###### 六级\n\n**粗体**、*斜体*、~~删除~~、`code` 和 [链接](https://example.com)。\n\n> 引用\n\n---\n\n1. 第一项\n   - 嵌套项\n\n- [ ] 待办\n  - [x] 已完成子项\n\n| 名称 | 说明 |\n| --- | --- |\n| 文档 | Markdown |';
    const doc = fromMarkdown(source);
    const types: string[] = [];
    const walk = (node: any) => { types.push(node.type); node.content?.forEach(walk); };
    walk(doc);
    for (const type of ['heading', 'blockquote', 'horizontalRule', 'orderedList', 'bulletList', 'taskList', 'table']) expect(types).toContain(type);
    expect(validateDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    const result = toMarkdown(doc);
    expect(result.lossless).toBe(true);
    expect(fromMarkdown(result.markdown)).toEqual(doc);
  });
  it('preserves HTML and JSX code, indentation, blank lines and language on round trip', () => {
    const code = '<section>\n  <Button label="保存" />\n\n</section>';
    const doc = fromMarkdown('```tsx\n' + code + '\n```');
    expect(doc.content?.[0]).toMatchObject({type:'codeBlock',attrs:{language:'tsx'},content:[{type:'text',text:code}]});
    expect(fromMarkdown(toMarkdown(doc).markdown)).toEqual(doc);
    expect(fromMarkdown('`<div>`').content?.[0].content?.[0]).toMatchObject({text:'<div>',marks:[{type:'code'}]});
  });
  it('supports HTML line-break shorthand without dropping adjacent text or changing code', () => {
    for (const tag of ['<br>', '<br/>', '<br />', '<BR />']) {
      expect(fromMarkdown(`前${tag}后`).content?.[0].content).toEqual([{type:'text',text:'前'},{type:'hardBreak'},{type:'text',text:'后'}]);
    }
    const doc = fromMarkdown('>开头引用\n<br/>\n接下来的 **正文**\n\n结尾');
    const encoded = JSON.stringify(doc);
    for (const text of ['开头引用', '接下来的', '正文', '结尾']) expect(encoded).toContain(text);
    expect(encoded).toContain('hardBreak');
    expect(fromMarkdown('`<br/>`').content?.[0].content?.[0]).toMatchObject({text:'<br/>',marks:[{type:'code'}]});
    expect(fromMarkdown('```html\n<br/>\n```').content?.[0].content?.[0].text).toBe('<br/>');
    expect(() => fromMarkdown('<br onclick="alert(1)">')).toThrow('HTML');
  });
  it('preserves bold inline code used in Markdown guides', () => {
    const doc = fromMarkdown('**`build` (构建模式)** 和 [**`plan`**](https://example.com)');
    expect(doc.content?.[0].content?.[0]).toMatchObject({text:'build',marks:[{type:'bold'},{type:'code'}]});
    const result=toMarkdown(doc);
    expect(result.lossless).toBe(true);
    expect(fromMarkdown(result.markdown)).toEqual(doc);
  });
  it('accepts indented code but still rejects raw HTML outside code', () => {
    expect(fromMarkdown('    <div>example</div>').content?.[0].type).toBe('codeBlock');
    for (const source of ['<script>alert(1)</script>', '**text** <img src=x>', '> <div>html</div>']) expect(() => fromMarkdown(source)).toThrow('原始 HTML');
  });
});
