import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { config } from '../config.js';
import { rows, one, db } from '../db/index.js';
import { assert } from '../lib/errors.js';
import { access, liveUser, mutate, audit, read, checkVersion, type Actor, type Context } from './core.js';
export const storageIO={mkdir,writeFile};
export const FILE_MAINTENANCE_LOCK=591339;
import type { Kind } from './resources.js';

type FileRow = { id: string; projectId: string; name: string; mimeType: string; size: number; storageKey: string };
export type PreparedCommentFile = { name: string; bytes: Buffer; checksum: string; mimeType: string };
export async function prepareCommentFiles(input: File[]): Promise<PreparedCommentFile[]> {
  assert(input.length <= 5, 400, 'TOO_MANY_FILES', '每条评论最多添加 5 个文件');
  assert(input.reduce((size, file) => size + file.size, 0) <= config.MAX_UPLOAD_BYTES, 413, 'FILE_TOO_LARGE', `评论附件总大小不能超过 ${config.MAX_UPLOAD_BYTES / 1048576}MB`);
  return Promise.all(input.map(async file => {
    assert(file.size > 0, 400, 'INVALID_FILE', '不能上传空文件');
    const bytes = Buffer.from(await file.arrayBuffer());
    let mimeType = 'application/octet-stream';
    if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mimeType = 'image/png';
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mimeType = 'image/jpeg';
    else if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') mimeType = 'image/webp';
    return { name: file.name.slice(0, 255), bytes, checksum: createHash('sha256').update(bytes).digest('hex'), mimeType };
  }));
}
export async function storeCommentFiles(ctx: Context, projectId: string, commentId: string, prepared: PreparedCommentFile[]) {
  if (!prepared.length) return [];
  const root = resolve(config.UPLOAD_DIR);
  await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${FILE_MAINTENANCE_LOCK})`);
  await storageIO.mkdir(root, { recursive: true });
  const result: { id: string; name: string; mimeType: string; size: number }[] = [];
  for (const file of prepared) {
    const id = randomUUID();
    await storageIO.writeFile(resolve(root, id), file.bytes, { flag: 'wx' });
    await ctx.tx.execute(sql`INSERT INTO files(id,project_id,uploader_id,name,mime_type,size,storage_key,checksum) VALUES(${id},${projectId},${ctx.actor.userId},${file.name},${file.mimeType},${file.bytes.length},${id},${file.checksum})`);
    await ctx.tx.execute(sql`INSERT INTO comment_attachments(id,project_id,comment_id,file_id) VALUES(${randomUUID()},${projectId},${commentId},${id})`);
    result.push({ id, name: file.name, mimeType: file.mimeType, size: file.bytes.length });
  }
  return result;
}
export async function upload(actor: Actor, projectId: string, kind: Kind, resourceId: string, file: File, expectedVersion: number, op: string) {
  await liveUser(db, actor); await access(db, actor, projectId, 'write');
  assert(file.size > 0 && file.size <= config.MAX_UPLOAD_BYTES, 413, 'FILE_TOO_LARGE', `附件大小应为 1 字节至 ${config.MAX_UPLOAD_BYTES / 1048576}MB`);
  const bytes = Buffer.from(await file.arrayBuffer());
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const id = randomUUID(); const key = id; const root = resolve(config.UPLOAD_DIR); const path = resolve(root, key);
  let mime = 'application/octet-stream';
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = 'image/png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
  else if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') mime = 'image/webp';
  const result = await mutate(actor, projectId, 'write', op, { action: 'upload', kind, resourceId, checksum, size: bytes.length, name: file.name, expectedVersion }, async ctx => {
      const tbl = kind === 'task' ? sql`tasks` : sql`documents`;
      const before = await one<{ version: number; archivedAt?: Date | null }>(ctx.tx, sql`SELECT * FROM ${tbl} WHERE id=${resourceId} AND project_id=${projectId} AND deleted_at IS NULL`); checkVersion(before, expectedVersion); assert(!before!.archivedAt, 409, 'RESOURCE_ARCHIVED', '内容已归档');
      await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${FILE_MAINTENANCE_LOCK})`);
      await storageIO.mkdir(root,{recursive:true});
      await storageIO.writeFile(path,bytes,{flag:'wx'});
      const previous = await rows(ctx.tx, sql`SELECT file_id FROM resource_attachments WHERE resource_id=${resourceId} AND resource_type=${kind} AND removed_at IS NULL`);
      const f = (await one<FileRow>(ctx.tx, sql`INSERT INTO files(id,project_id,uploader_id,name,mime_type,size,storage_key,checksum) VALUES(${id},${projectId},${actor.userId},${file.name.slice(0,255)},${mime},${bytes.length},${key},${checksum}) RETURNING *`))!;
      await ctx.tx.execute(sql`INSERT INTO resource_attachments(id,project_id,file_id,resource_type,resource_id) VALUES(${randomUUID()},${projectId},${id},${kind},${resourceId})`);
      const after = (await one(ctx.tx, sql`UPDATE ${tbl} SET version=version+1,updated_at=now() WHERE id=${resourceId} RETURNING *`))!;
      await audit(ctx, kind, resourceId, 'attach_file', { ...before, attachments: previous }, { ...after, attachments: [...previous, { fileId: id }] }, true);
      return { file: { ...f, url: `/api/files/${id}` }, resource: after };
    });
  // A failed commit acknowledgement does not prove rollback. Never unlink here:
  // an old unregistered file is reclaimed later, under the maintenance lock.
  return result;
}
export async function attachments(actor: Actor, projectId: string, kind: Kind, resourceId: string) {
  return read(actor, projectId, tx => rows<FileRow>(tx, sql`SELECT f.id,f.project_id,f.name,f.mime_type,f.size,f.created_at FROM resource_attachments a JOIN files f ON f.id=a.file_id WHERE a.project_id=${projectId} AND a.resource_type=${kind} AND a.resource_id=${resourceId} AND a.removed_at IS NULL ORDER BY a.created_at DESC`));
}
export async function download(actor: Actor, id: string) {
  await liveUser(db, actor); const file = await one<FileRow>(db, sql`SELECT * FROM files WHERE id=${id}`); assert(file, 404, 'NOT_FOUND', '附件不存在'); const role = await access(db, actor, file.projectId);
  const comment = await one<{ deletedAt: Date | null }>(db, sql`SELECT c.deleted_at FROM comment_attachments a JOIN comments c ON c.id=a.comment_id AND c.project_id=a.project_id WHERE a.file_id=${id} AND a.project_id=${file.projectId}`);
  assert(!comment?.deletedAt || role === 'admin', 404, 'NOT_FOUND', '附件不存在');
  assert(/^[0-9a-f-]{36}$/.test(file.storageKey), 500, 'INVALID_STORAGE_KEY', '文件存储异常');
  let bytes: Buffer; try { bytes = await readFile(resolve(config.UPLOAD_DIR, file.storageKey)); } catch { throw new Error('附件文件不可用，请联系管理员'); }
  return { file, bytes };
}
