import { useEffect, useRef, useMemo, useState } from 'react';
import { useEditor } from '@tiptap/react';
import { Slice } from '@tiptap/pm/model';
import { RichTextEditor } from '@mantine/tiptap';
import { editorExtensions, fromMarkdown } from '@yuanplan/editor-schema';
import { Loading, Failure } from './ui';
import { Button, FileButton, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { errorText } from './api';
import { ArticleCodeBlock } from './ArticleCodeBlock';

const looksLikeMarkdown = (text: string) => /(^|\n)\s{0,3}(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|`{3,}|~{3,}|(?:[-*_]\s*){3,}$)|\*\*[^\n]+\*\*|\[[^\]\n]+\]\([^\n]+\)|\n\s*\|?\s*:?-{3,}:?\s*\|/m.test(text);
export default function Editor({ value, onChange, readOnly = false, uploadImage, onCompositionChange, showPreviewToggle = true }: { showPreviewToggle?: boolean; value: any; onChange: (value: any) => void; readOnly?: boolean; uploadImage?:(file:File)=>Promise<string>; onCompositionChange?:(value:boolean)=>void }) {
  const [error,setError]=useState('');const [uploading,setUploading]=useState(false);
  const [preview,setPreview]=useState(false);const [importOpen,setImportOpen]=useState(false);const [markdown,setMarkdown]=useState('');const [importError,setImportError]=useState('');
  const callback = useRef(onChange); callback.current = onChange;
  const editable = !readOnly && !preview;
  const extensions = useMemo(() => [...editorExtensions({codeBlock:false}), ArticleCodeBlock], []);
  const editor = useEditor({ immediatelyRender: false, shouldRerenderOnTransaction: true, extensions, content: value, editable,
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': '正文编辑器', 'aria-multiline': 'true', 'aria-readonly': String(!editable) },
      handlePaste(view, event) {
        if (!view.editable || view.state.selection.$from.parent.type.spec.code) return false;
        const text = event.clipboardData?.getData('text/plain') ?? '';
        if (event.clipboardData?.getData('text/html') || !looksLikeMarkdown(text)) return false;
        try {
          const doc = fromMarkdown(text);
          const content = view.state.schema.nodeFromJSON(doc);
          view.dispatch(view.state.tr.replaceSelection(new Slice(content.content, 0, 0)).scrollIntoView());
          setError('');
        } catch (e) { setError(`Markdown 粘贴失败：${errorText(e)}`); }
        return true;
      },
    }, onUpdate: ({ editor }) => callback.current(editor.getJSON()) });
  useEffect(() => { if (editor && !editor.isDestroyed) { editor.setEditable(editable, false); editor.view.dispatch(editor.state.tr.setMeta('articleEditable', editable)); editor.setOptions({ editorProps: { ...editor.options.editorProps, attributes: { role: 'textbox', 'aria-label': '正文编辑器', 'aria-multiline': 'true', 'aria-readonly': String(!editable) } } }); } }, [editor, editable]);
  useEffect(() => { if (editor && !editor.isDestroyed && JSON.stringify(editor.getJSON()) !== JSON.stringify(value)) editor.commands.setContent(value, { emitUpdate: false }); }, [editor, value]);
  if (!editor || editor.isDestroyed) return <Loading/>;
  return <Stack gap="xs" className={`article-editor${!editable?' article-reading':''}`} onCompositionStart={()=>onCompositionChange?.(true)} onCompositionEnd={()=>onCompositionChange?.(false)}>
    <Failure error={error}/>
    {!readOnly && <Group justify="space-between" gap="xs"><Text size="xs" c="dimmed">支持 Markdown 粘贴 · 代码块 · 表格 · 任务清单</Text>{showPreviewToggle&&<Button size="compact-xs" variant="subtle" aria-pressed={preview} onClick={()=>setPreview(v=>!v)}>{preview?'返回编辑':'阅读预览'}</Button>}</Group>}
    <RichTextEditor editor={editor}>
      {editable && <RichTextEditor.Toolbar sticky>
        <RichTextEditor.ControlsGroup><RichTextEditor.Bold/><RichTextEditor.Italic/><RichTextEditor.Strikethrough/><RichTextEditor.Code/><RichTextEditor.ClearFormatting/></RichTextEditor.ControlsGroup>
        <RichTextEditor.ControlsGroup><RichTextEditor.H1/><RichTextEditor.H2/><RichTextEditor.H3/><RichTextEditor.H4/><RichTextEditor.H5/><RichTextEditor.H6/></RichTextEditor.ControlsGroup>
        <RichTextEditor.ControlsGroup><RichTextEditor.BulletList/><RichTextEditor.OrderedList/><RichTextEditor.TaskList/><RichTextEditor.Blockquote/><RichTextEditor.Hr/><RichTextEditor.CodeBlock/></RichTextEditor.ControlsGroup>
        <RichTextEditor.ControlsGroup><RichTextEditor.Link/><RichTextEditor.Unlink/><RichTextEditor.Undo/><RichTextEditor.Redo/></RichTextEditor.ControlsGroup>
      </RichTextEditor.Toolbar>}
      <RichTextEditor.Content/>
    </RichTextEditor>
    {editable&&<Group gap="xs">
      <Button variant="subtle" size="xs" onClick={()=>{setImportError('');setMarkdown('');setImportOpen(true);}}>导入 Markdown</Button>
      <Button variant="subtle" size="xs" onClick={()=>editor.chain().focus().insertTable({rows:3,cols:3,withHeaderRow:true}).run()}>插入表格</Button>
      {editor.isActive('table')&&<><Button variant="subtle" size="xs" onClick={()=>editor.chain().focus().addRowAfter().run()}>添加行</Button><Button variant="subtle" size="xs" onClick={()=>editor.chain().focus().addColumnAfter().run()}>添加列</Button><Button variant="subtle" size="xs" onClick={()=>editor.chain().focus().deleteTable().run()}>删除表格</Button></>}
      {uploadImage&&<FileButton accept="image/png,image/jpeg,image/webp" onChange={async file=>{if(!file)return;setUploading(true);setError('');try{const src=await uploadImage(file);if(!editor.isDestroyed)editor.chain().focus().setImage({src}).run();}catch(e){setError(errorText(e));}finally{setUploading(false);}}}>{props=><Button {...props} size="xs" variant="subtle" loading={uploading}>上传图片</Button>}</FileButton>}
    </Group>}
    <Modal opened={importOpen} onClose={()=>setImportOpen(false)} title="导入 Markdown" size="lg">
      <Stack><Text size="sm" c="dimmed">将内容插入光标位置，不会替换整篇文章。图片请使用下方“上传图片”。</Text>
        <FileButton accept=".md,.markdown,text/markdown,text/plain" onChange={async file=>{if(!file)return;setImportError('');try{if(file.size>1_000_000)throw new Error('文件不能超过 1MB');setMarkdown(await file.text());}catch(e){setImportError(errorText(e));}}}>{props=><Button {...props} variant="light" size="xs">选择 .md 文件</Button>}</FileButton>
        <Textarea label="Markdown 内容" value={markdown} onChange={e=>setMarkdown(e.currentTarget.value)} minRows={12} maxRows={20} autosize styles={{input:{fontFamily:'monospace'}}}/>
        <Failure error={importError}/><Button disabled={!editable||!markdown.trim()} onClick={()=>{try{const doc=fromMarkdown(markdown);editor.chain().focus().insertContent(doc.content??[]).run();setImportOpen(false);setMarkdown('');setError('');}catch(e){setImportError(errorText(e));}}}>插入内容</Button>
      </Stack>
    </Modal>
  </Stack>;
}
