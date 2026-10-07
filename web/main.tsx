import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import * as RTooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { App } from './App';
import { ThemeProvider, useTheme } from './lib/theme';
import { WorkbenchProvider } from './lib/workbench';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, staleTime: 1000 } },
});

function Toasts() {
  const { theme } = useTheme();
  return <Toaster theme={theme} position="bottom-left" richColors closeButton toastOptions={{ className: 'font-sans' }} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <MotionConfig reducedMotion="user">
          <RTooltip.Provider>
            <WorkbenchProvider>
              <App />
              <Toasts />
            </WorkbenchProvider>
          </RTooltip.Provider>
        </MotionConfig>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
