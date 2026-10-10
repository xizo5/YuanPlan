import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { credentialActor } from './credentials.js';
import { listProjects, getProject, listMembers } from './projects.js';
import * as resources from './resources.js';
import { fromMarkdown, toMarkdown } from '@yuanplan/editor-schema';
import { AppError } from '../lib/errors.js';
import type { Actor } from './core.js';

export function createMcpServer(actor: Actor) {
  const server = new McpServer({ name: 'yuanplan', version: '0.1.0' });
  const pid = { projectId: z.string().uuid() }; const rid = { ...pid, id: z.string().uuid() };
  const operation = { operationId: z.string().uuid().describe('Generate once for a logical operation; reuse it when retrying.') };
  function tool(name: string, description: string, shape: z.ZodRawShape, fn: (input: any) => Promise<unknown>, write = false) {
    server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: !write, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async input => {
      try { const result = await fn(input); return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }; }
      catch (error) { const e = error instanceof AppError ? { code: error.code, message: error.message, details: error.details } : { code: 'INVALID_REQUEST', message: error instanceof z.ZodError ? error.issues.map(i => i.message).join('; ') : '操作失败，请检查参数或联系管理员' }; return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(e) }] }; }
    });
  }
  tool('list_projects', 'List projects accessible to this credential.', {}, () => listProjects(actor));
  tool('get_project', 'Read project details.', pid, a => getProject(actor, a.projectId));
  tool('list_project_members', 'List project members for assignment.', pid, a => listMembers(actor, a.projectId));
  tool('list_tasks', 'Search and paginate tasks.', { ...pid, query: z.string().max(200).optional(), cursor: z.string().optional(), status: z.enum(['todo','in_progress','in_review','done']).optional() }, a => resources.listTasks(actor, a.projectId, a));
  tool('get_task', 'Read task including its current version.', rid, a => resources.getResource(actor, a.projectId, 'task', a.id));
  tool('create_task', 'Create a task. Assignee is optional; creator is authenticated identity.', { ...pid, ...operation, title: z.string(), descriptionMarkdown: z.string().optional(), assigneeId: z.string().nullable().optional(), priority: z.enum(['low','normal','high','urgent']).optional() }, a => resources.createTask(actor, a.projectId, { title: a.title, description: fromMarkdown(a.descriptionMarkdown ?? ''), assigneeId: a.assigneeId, priority: a.priority }, a.operationId), true);
  tool('update_task', 'Update task with optimistic concurrency; read latest version first.', { ...rid, ...operation, expectedVersion: z.number().int().positive(), changes: z.object({ title: z.string().optional(), status: z.enum(['todo','in_progress','in_review','done']).optional(), priority: z.enum(['low','normal','high','urgent']).optional(), assigneeId: z.string().nullable().optional(), startDate: z.string().nullable().optional(), dueDate: z.string().nullable().optional(), labels: z.array(z.string()).optional() }).strict() }, a => resources.updateTask(actor, a.projectId, a.id, a.changes, a.expectedVersion, a.operationId), true);
  tool('list_subtasks', 'Read first-level subtasks.', { ...rid, cursor: z.string().optional() }, a => resources.listTasks(actor, a.projectId, { parentId: a.id, cursor: a.cursor }));
  tool('create_subtask', 'Create a first-level subtask in the same project.', { ...pid, ...operation, parentId: z.string().uuid(), title: z.string(), assigneeId: z.string().nullable().optional() }, a => resources.createTask(actor, a.projectId, { title: a.title, parentId: a.parentId, assigneeId: a.assigneeId }, a.operationId), true);
  tool('list_comments', 'Read task comments.', { ...rid, cursor: z.string().optional() }, a => resources.comments(actor, a.projectId, a.id, a.cursor));
  tool('add_comment', 'Add an attributed comment.', { ...rid, ...operation, content: z.string().min(1).max(10000) }, a => resources.addComment(actor, a.projectId, a.id, a.content, a.operationId), true);
  tool('search_documents', 'Search current document titles and content.', { ...pid, query: z.string().max(200).optional(), cursor: z.string().optional() }, a => resources.listDocuments(actor, a.projectId, a));
  tool('get_document', 'Read Markdown with version and lossless conversion flag.', rid, async a => { const doc = await resources.getResource(actor, a.projectId, 'document', a.id) as import('@yuanplan/contracts').Document; return { ...doc, ...toMarkdown(doc.content), format: 'markdown' }; });
  tool('create_document', 'Create a project Wiki page from supported Markdown.', { ...pid, ...operation, title: z.string(), markdown: z.string(), parentId: z.string().uuid().nullable().optional() }, a => resources.createDocument(actor, a.projectId, { title: a.title, content: fromMarkdown(a.markdown), parentId: a.parentId }, a.operationId), true);
  tool('update_document', 'Update a losslessly convertible Wiki page; conflicts are rejected.', { ...rid, ...operation, expectedVersion: z.number().int().positive(), title: z.string().optional(), markdown: z.string() }, a => resources.updateDocument(actor, a.projectId, a.id, { ...(a.title ? { title: a.title } : {}), content: fromMarkdown(a.markdown) }, a.expectedVersion, a.operationId), true);
  tool('list_task_history', 'Read attributed task changes.', { ...rid, cursor: z.string().optional() }, a => resources.history(actor, a.projectId, 'task', a.id, a.cursor));
  tool('list_document_versions', 'Read Wiki version metadata and changes.', { ...rid, cursor: z.string().optional() }, a => resources.history(actor, a.projectId, 'document', a.id, a.cursor));
  tool('get_document_version', 'Read one historical Wiki snapshot.', { ...rid, version: z.number().int().positive() }, a => resources.getVersion(actor, a.projectId, 'document', a.id, a.version));
  return server;
}
export async function handleMcp(request: Request) {
  const bearer = request.headers.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!bearer) throw new AppError(401, 'UNAUTHENTICATED', '需要 MCP 凭据');
  const actor = await credentialActor(bearer);
  const server = createMcpServer(actor);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try { return await transport.handleRequest(request); } finally { await server.close(); }
}
