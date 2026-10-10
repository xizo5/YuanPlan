import { createContext } from 'react';
import type { Document } from '@yuanplan/contracts';
export const UserContext = createContext('');
export type DocumentDraft = { schema: 1; version: number; data: Pick<Document,'title'|'content'|'parentId'>; attempt?: { operationId: string; body: any; encoded: string } | null };
const prefix = (user: string) => `yuanplan:draft:v1:${user}:`;
export const draftKey = (user: string, project: string, id: string) => `${prefix(user)}${project}:${id}`;
export function readDraft(key: string): DocumentDraft | null { try { const d=JSON.parse(localStorage.getItem(key)??'null'); return d?.schema===1&&Number.isInteger(d.version)&&typeof d.data?.title==='string'&&d.data?.content?.type==='doc'?d:null; } catch { return null; } }
export function clearDrafts(user: string) { try { for(let i=localStorage.length-1;i>=0;i--){const key=localStorage.key(i);if(key?.startsWith(prefix(user)))localStorage.removeItem(key);} } catch { /* Storage may be disabled; signing out must still complete. */ } }
