import { Component, Suspense, lazy, useEffect, type ReactNode } from 'react';
import { appStore, useApp } from '../app/store';
import { reportFailure } from '../app/actions';
import { debugParams } from '../app/debug';
import { webgl2Available } from '../app/webgl';

const Viewer = lazy(() => import('../engine/Viewer'));

class RendererBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const chunk = /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(message);
    reportFailure(chunk ? 'engine-load' : 'runtime', message);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Decides whether the 3D view can start, then lazy-loads it (three.js is not in the main bundle). */
export function ViewerHost() {
  const phase = useApp((s) => s.phase);
  const generation = useApp((s) => s.rendererGeneration);

  useEffect(() => {
    if (appStore.getState().phase !== 'booting' && appStore.getState().phase !== 'loading') return;
    if (debugParams.renderer === 'fail') {
      reportFailure('simulated');
      return;
    }
    if (!webgl2Available()) {
      reportFailure('webgl-unavailable');
      return;
    }
    appStore.setState({ phase: 'loading', progress: { done: 0, total: 1, step: 'engine' } });
  }, [generation]);

  if (phase === 'failed' || phase === 'booting') return null;
  return (
    <RendererBoundary key={generation}>
      <Suspense fallback={null}>
        <Viewer />
      </Suspense>
    </RendererBoundary>
  );
}
