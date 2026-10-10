import { Alert, Center, Loader, Stack, Text, Title } from '@mantine/core';
export function Failure({ error }: { error?: string }) { return error ? <Alert color="red" role="alert">{error}</Alert> : null; }
export function Loading() { return <Center p="xl" role="status" aria-label="正在加载"><Loader size="sm" aria-hidden="true"/></Center>; }
export function Empty({ title, detail }: { title: string; detail?: string }) { return <Stack className="empty-state" align="center" gap="xs"><Title order={3}>{title}</Title>{detail&&<Text c="dimmed" size="sm">{detail}</Text>}</Stack>; }
export const time = (value: string) => new Date(value).toLocaleString('zh-CN');
