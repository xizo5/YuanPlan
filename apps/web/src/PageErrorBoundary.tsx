import { Component, type ReactNode } from 'react';
import { Alert, Button, Stack, Text } from '@mantine/core';

// Keep workspace navigation mounted when a route or lazy-loaded module fails.
// The route key in App resets this boundary on navigation to another page.
export class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <Stack>
      <Alert color="red" title="页面加载失败" role="alert">
        <Text size="sm">页面资源可能已更新或暂时无法加载。可以重新加载当前页面，也可以从左侧导航进入其他页面。</Text>
      </Alert>
      <Button onClick={() => window.location.reload()} style={{ alignSelf: 'flex-start' }}>重新加载页面</Button>
    </Stack>;
  }
}
