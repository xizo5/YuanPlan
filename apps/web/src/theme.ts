import { createTheme } from '@mantine/core';
export const theme = createTheme({
  primaryColor: 'forest', defaultRadius: 'sm', fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
  colors: { forest: ['#eff8f4','#dcece4','#b7d8c7','#8ec2a8','#6caf8e','#559f7d','#3e8969','#2d7257','#23634b','#15543c'] },
  fontSizes: { xs: '12px', sm: '13px', md: '14px', lg: '16px', xl: '18px' },
  headings: { fontWeight: '600', sizes: { h1: { fontSize: '20px', lineHeight: '1.4' }, h2: { fontSize: '18px', lineHeight: '1.4' }, h3: { fontSize: '16px', lineHeight: '1.4' }, h4: { fontSize: '14px', lineHeight: '1.4' } } },
  components: { Stack: { defaultProps: { gap: 'sm' } }, Group: { defaultProps: { gap: 'sm' } }, Card: { defaultProps: { padding: 'sm' } }, Tabs: { defaultProps: { keepMounted: false } }, Button: { defaultProps: { size: 'sm', fw: 550 } }, TextInput: { defaultProps: { size: 'sm' } }, Select: { defaultProps: { size: 'sm' } }, Modal: { defaultProps: { centered: true, overlayProps: { backgroundOpacity: 0.22 } } } },
});
