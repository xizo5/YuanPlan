import React from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import '@mantine/core/styles.css';
import '@mantine/tiptap/styles.css';
import { theme } from './theme';
import { App } from './App';
import './styles.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><MantineProvider theme={theme} forceColorScheme="light"><App/></MantineProvider></React.StrictMode>);
