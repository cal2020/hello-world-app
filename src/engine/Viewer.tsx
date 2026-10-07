import { useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import type * as THREE from 'three';
import { appStore, useApp } from '../app/store';
import { reportFailure } from '../app/actions';
import { CellEngine } from './CellEngine';

/**
 * Runs inside the React Three Fiber canvas: creates the engine, forwards
 * size changes, drives the frame loop (taking over rendering at priority 1)
 * and pauses rendering while the tab is hidden or the text atlas is shown.
 */
function EngineDriver() {
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  const setDpr = useThree((s) => s.setDpr);
  const setFrameloop = useThree((s) => s.setFrameloop);
  const engineRef = useRef<CellEngine | null>(null);
  const textAtlas = useApp((s) => s.textAtlas);

  useEffect(() => {
    const engine = new CellEngine(gl as THREE.WebGLRenderer, { setDpr });
    engineRef.current = engine;
    engine.resize(size.width, size.height, dpr);
    engine.build().catch((error: unknown) => {
      console.error(error);
      reportFailure('runtime', error instanceof Error ? error.message : String(error));
    });
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
    // The engine lives as long as the canvas; size/dpr updates are forwarded below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl]);

  useEffect(() => {
    engineRef.current?.resize(size.width, size.height, dpr);
  }, [size.width, size.height, dpr]);

  useEffect(() => {
    const update = () => setFrameloop(document.hidden || appStore.getState().textAtlas ? 'never' : 'always');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, [setFrameloop, textAtlas]);

  useFrame((_state, delta) => {
    try {
      engineRef.current?.frame(delta);
    } catch (error) {
      console.error(error);
      reportFailure('runtime', error instanceof Error ? error.message : String(error));
    }
  }, 1);

  return null;
}

export default function Viewer() {
  return (
    <Canvas
      gl={{
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false,
        failIfMajorPerformanceCaveat: false,
      }}
      dpr={1}
      flat
      linear={false}
      style={{ position: 'absolute', inset: 0 }}
      aria-hidden="true"
      tabIndex={-1}
      onCreated={({ gl }) => {
        gl.domElement.setAttribute('data-testid', 'cell-canvas');
      }}
    >
      <EngineDriver />
    </Canvas>
  );
}
