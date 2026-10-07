import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { appStore, reducedMotion, type AppState } from '../app/store';
import { notifyCameraArrived, reportFailure, selectStructure, setHovered, underlyingRoute } from '../app/actions';
import { overlays, setEngineController, type EngineController, type ViewInsets } from '../app/engineBridge';
import { QUALITY_PRESETS, initialAutoLevel, type QualityLevel } from '../app/quality';
import { computeScale, relativeMagnification, roundMagnification, splitLength } from '../app/scale';
import { debugParams } from '../app/debug';
import { structure as structureRecord } from '../content/registry';
import { STRUCTURE_IDS, type StructureId } from '../content/types';
import { CameraRig, type Pose } from './camera/CameraRig';
import { createCut, insideCut } from './core/materials';
import { insideEllipsoid, rayEllipsoid } from './core/geometry';
import { CellLayout } from './cell/layout';
import type { BuildContext, StructureInstance } from './cell/types';
import { buildCytoplasm, buildPlasmaMembrane } from './cell/structures/boundary';
import { buildChromosomes, buildNucleolus, buildNucleus, buildTelomeres } from './cell/structures/genetic';
import { buildGolgi, buildRibosomes, buildRoughEr, buildSmoothEr, buildVesicles } from './cell/structures/protein';
import { buildEndosomes, buildLysosomes, buildMitochondria, buildPeroxisomes } from './cell/structures/energy';
import { buildActin, buildCentrosome, buildIntermediateFilaments, buildMicrotubules } from './cell/structures/support';
import { mtParams } from './cell/mtDynamics';
import { backgroundTexture } from './closeups/common';
import { CLOSEUP_LOADERS } from './closeups';
import type { CloseupScene } from './closeups/types';
import { LabelLayer, type LabelSpec } from './labels/LabelLayer';
import { Picker } from './picking/Picker';
import { PerfMonitor } from './perf/PerfMonitor';
import { downloadBlob, renderExport } from './export/exportImage';

const GHOST = 0.07;
const PICK_THRESHOLD = 0.3;
const OVERVIEW_DIRECTION = new THREE.Vector3(0.42, 0.3, 0.86).normalize();

/** Structures kept partly visible as context when another is focused. */
const CONTEXT: Partial<Record<StructureId, Partial<Record<StructureId, number>>>> = {
  'plasma-membrane': { actin: 0.45, cytoplasm: 0.25 },
  cytoplasm: Object.fromEntries(STRUCTURE_IDS.filter((id) => id !== 'cytoplasm').map((id) => [id, 0.22])),
  nucleus: { chromosomes: 0.95, nucleolus: 0.95, telomeres: 0.8, 'rough-er': 0.22 },
  chromosomes: { nucleus: 0.28, telomeres: 0.85, nucleolus: 0.35 },
  telomeres: { chromosomes: 0.4, nucleus: 0.22 },
  nucleolus: { nucleus: 0.26, chromosomes: 0.22 },
  ribosomes: { 'rough-er': 0.45, nucleus: 0.2 },
  'rough-er': { ribosomes: 0.95, nucleus: 0.4, 'smooth-er': 0.45, golgi: 0.35 },
  'smooth-er': { 'rough-er': 0.4 },
  golgi: { centrosome: 0.6, 'vesicles-motors': 0.55, 'rough-er': 0.28, microtubules: 0.22 },
  'vesicles-motors': { microtubules: 0.85, golgi: 0.4, centrosome: 0.4 },
  mitochondria: { microtubules: 0.2 },
  lysosomes: { endosomes: 0.45 },
  endosomes: { lysosomes: 0.75, 'plasma-membrane': 0.5 },
  peroxisomes: { mitochondria: 0.3, 'smooth-er': 0.25 },
  microtubules: { centrosome: 0.9, 'vesicles-motors': 0.6 },
  actin: { 'plasma-membrane': 0.25 },
  'intermediate-filaments': { nucleus: 0.3 },
  centrosome: { microtubules: 0.6, golgi: 0.45, nucleus: 0.25 },
};

/** Default faint visibility for shells that give spatial context. */
const GHOST_OVERRIDE: Partial<Record<StructureId, number>> = { 'plasma-membrane': 0.25, cytoplasm: 0.25 };

/** Membrane / nuclear cut half-angle (as cosines) per state. */
function membraneCutCos(selected: StructureId | null): number {
  if (selected === 'plasma-membrane') return 0.9;
  if (selected === null) return 0.66;
  return 0.58;
}
function nucleusCutCos(selected: StructureId | null): number {
  if (selected === 'nucleus') return 0.62;
  if (selected === 'chromosomes' || selected === 'telomeres' || selected === 'nucleolus') return 0.5;
  if (selected === 'rough-er' || selected === 'ribosomes') return 0.72;
  return 0.8;
}

interface FocusState {
  opacity: number;
  target: number;
  emphasis: number;
  emphasisTarget: number;
}

type EnginePhase = 'building' | 'ready' | 'entering' | 'exploring' | 'disposed';

const BUILD_ORDER: Array<[StructureId, (ctx: BuildContext, extra: { mt: ReturnType<typeof mtParams> }) => StructureInstance]> = [
  ['plasma-membrane', (c) => buildPlasmaMembrane(c)],
  ['cytoplasm', (c) => buildCytoplasm(c)],
  ['nucleus', (c) => buildNucleus(c)],
  ['chromosomes', (c) => buildChromosomes(c)],
  ['telomeres', (c) => buildTelomeres(c)],
  ['nucleolus', (c) => buildNucleolus(c)],
  ['rough-er', (c) => buildRoughEr(c)],
  ['smooth-er', (c) => buildSmoothEr(c)],
  ['ribosomes', (c) => buildRibosomes(c)],
  ['golgi', (c) => buildGolgi(c)],
  ['mitochondria', (c) => buildMitochondria(c)],
  ['lysosomes', (c) => buildLysosomes(c)],
  ['endosomes', (c) => buildEndosomes(c)],
  ['peroxisomes', (c) => buildPeroxisomes(c)],
  ['microtubules', (c, e) => buildMicrotubules(c, e.mt)],
  ['vesicles-motors', (c, e) => buildVesicles(c, e.mt)],
  ['actin', (c) => buildActin(c)],
  ['intermediate-filaments', (c) => buildIntermediateFilaments(c)],
  ['centrosome', (c) => buildCentrosome(c)],
];

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export interface EngineHooks {
  /** Ask the host (React Three Fiber) to change the device pixel ratio. */
  setDpr: (dpr: number) => void;
}

export class CellEngine implements EngineController {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(38, 1, 0.05, 600);
  private readonly gl: THREE.WebGLRenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly hooks: EngineHooks;
  private rig: CameraRig;
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private layout: CellLayout | null = null;
  private structures = new Map<StructureId, StructureInstance>();
  private focus = new Map<StructureId, FocusState>();
  private cuts = {
    membrane: createCut(new THREE.Vector3(), '#d6e4ff'),
    nucleus: createCut(new THREE.Vector3(), '#efe7ff'),
  };
  private cutTargets = { membrane: 1.01, nucleus: 1.01 };
  private time = { value: 0 };
  private pointScale = { value: 600 };
  private phase: EnginePhase = 'building';
  private enterElapsed = 0;
  private enterDuration = 2.4;
  private selected: StructureId | null = null;
  private lastNonce = -1;
  private overviewPose: Pose | null = null;
  private closeup: { id: StructureId; scene: CloseupScene; viewIndex: number } | null = null;
  private closeupToken = 0;
  private labels: LabelLayer | null = null;
  private labelMode = '';
  private picker: Picker;
  private perf: PerfMonitor;
  private quality: QualityLevel = 'medium';
  private width = 1;
  private height = 1;
  private unsubscribe: () => void = () => {};
  private pendingArrival: (() => void) | null = null;
  private emphasisPulse = 0;
  private lastScaleKey = '';
  private lastScale = { barPx: 0, text: '', context: '', note: '' };
  private contextLossTimer = 0;
  private autoRotate = true;
  private disposed = false;
  private readonly envMap: THREE.Texture;
  private skipNextFrame = false;
  private readonly onVisibility = () => {
    if (document.visibilityState === 'visible') this.skipNextFrame = true;
  };
  private readonly hemi = new THREE.HemisphereLight('#a8bfff', '#1a0f24', 1.05);

  constructor(gl: THREE.WebGLRenderer, hooks: EngineHooks) {
    this.gl = gl;
    this.canvas = gl.domElement;
    this.hooks = hooks;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.05;
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.localClippingEnabled = true;
    gl.setClearColor('#04050a', 1);

    this.scene.background = backgroundTexture('#0a1024');
    this.scene.fog = new THREE.FogExp2('#05070f', 0.006);
    const pmrem = new THREE.PMREMGenerator(gl);
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 0.28;
    pmrem.dispose();
    this.scene.add(this.hemi);
    const key = new THREE.DirectionalLight('#ffffff', 1.5);
    key.position.set(6, 9, 8);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#7d8cff', 1.1);
    rim.position.set(-8, -3, -6);
    this.scene.add(rim);
    // A soft warm fill inside the cell; decay keeps it from blowing out nearby membranes.
    const inner = new THREE.PointLight('#ffe2c4', 8, 14, 1.6);
    inner.position.set(1.2, 1.6, 2.4);
    this.scene.add(inner);

    this.rig = new CameraRig(this.camera, this.canvas);
    this.rig.onUserInput = () => {
      this.autoRotate = false;
      // Taking the controls mid-flight counts as arrival (the tour's reading timer starts).
      if (this.pendingArrival) {
        const arrive = this.pendingArrival;
        this.pendingArrival = null;
        arrive();
      }
    };
    this.camera.position.copy(OVERVIEW_DIRECTION.clone().multiplyScalar(36));
    this.rig.controls.setLookAt(this.camera.position.x, this.camera.position.y, this.camera.position.z, 0, 0, 0, false);

    this.picker = new Picker({
      dom: this.canvas,
      camera: () => this.camera,
      pick: (ray) => this.pick(ray),
      onSelect: (id, pointerType) => this.onScenePick(id as StructureId | null, pointerType),
      onHover: (id, x, y) => this.onSceneHover(id as StructureId | null, x, y),
      enabled: () => this.phase === 'exploring' && !this.closeup,
    });
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    this.perf = new PerfMonitor(debugParams.perf, coarse);
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  // ── Build ────────────────────────────────────────────────────────────────

  async build(): Promise<void> {
    const total = BUILD_ORDER.length + 2;
    let done = 0;
    const progress = (step: string, id?: StructureId) =>
      appStore.setState({ progress: { done, total, step, structure: id } });
    progress('structure', 'plasma-membrane');
    await nextFrame();
    this.layout = new CellLayout();
    done++;
    const ctx: BuildContext = {
      layout: this.layout,
      cuts: this.cuts,
      time: this.time,
      pointScale: this.pointScale,
      maxQuality: 'high',
    };
    this.cuts.membrane.uCutCenter.value.copy(this.layout.cellCenter);
    this.cuts.nucleus.uCutCenter.value.copy(this.layout.nucleusCenter);
    const mt = mtParams(this.layout.microtubules.length);
    for (const [id, build] of BUILD_ORDER) {
      if (this.disposed) return;
      progress('structure', id);
      await nextFrame();
      const instance = build(ctx, { mt });
      this.structures.set(id, instance);
      this.scene.add(instance.root);
      this.focus.set(id, { opacity: instance.overviewOpacity, target: instance.overviewOpacity, emphasis: 0, emphasisTarget: 0 });
      done++;
    }
    progress('materials');
    await nextFrame();
    this.applyQuality(this.initialQuality(), true);
    this.applyFocusImmediately();
    try {
      await this.gl.compileAsync(this.scene, this.camera);
    } catch {
      this.gl.compile(this.scene, this.camera);
    }
    done = total;
    progress('done');
    if (this.disposed) return;
    this.labels = overlays.labelLayer && overlays.leaderLayer
      ? new LabelLayer(overlays.labelLayer, overlays.leaderLayer, (id) => selectStructure(id as StructureId, { source: 'label' }), (id) => setHovered(id as StructureId | null))
      : null;
    this.phase = 'ready';
    this.unsubscribe = appStore.subscribe((state, prev) => this.onStore(state, prev));
    appStore.setState({ phase: 'ready' });
    setEngineController(this);
  }

  private initialQuality(): QualityLevel {
    const state = appStore.getState();
    if (debugParams.quality) return debugParams.quality;
    if (state.settings.quality !== 'auto') return state.settings.quality;
    const nav = navigator as Navigator & { deviceMemory?: number };
    return initialAutoLevel({
      coarsePointer: window.matchMedia('(pointer: coarse)').matches,
      deviceMemoryGb: nav.deviceMemory,
      hardwareConcurrency: navigator.hardwareConcurrency,
      softwareRenderer: isSoftwareRenderer(this.gl),
    });
  }

  // ── EngineController ─────────────────────────────────────────────────────

  enter(): void {
    if (this.phase !== 'ready') return;
    const state = appStore.getState();
    const reduce = reducedMotion(state);
    this.phase = 'entering';
    this.enterElapsed = 0;
    this.enterDuration = reduce ? 0 : 2.4;
    this.autoRotate = false;
    appStore.setState({ phase: 'entering' });
    this.cutTargets.membrane = membraneCutCos(null);
    this.cutTargets.nucleus = nucleusCutCos(null);
    const route = underlyingRoute(state);
    if (!route.structure) {
      this.setOverviewLimits();
      this.rig.transitionTo(this.defaultOverviewPose(), reduce ? 0 : 2.4);
    }
    if (reduce) this.finishEntering();
  }

  private finishEntering(): void {
    this.phase = 'exploring';
    this.cuts.membrane.uCutCos.value = this.cutTargets.membrane;
    this.cuts.nucleus.uCutCos.value = this.cutTargets.nucleus;
    appStore.setState({ phase: 'exploring', viewState: 'overview' });
    this.applyRoute(true);
    if (debugParams.simulate === 'context-loss') {
      this.contextLossTimer = window.setTimeout(() => this.gl.getContext().getExtension('WEBGL_lose_context')?.loseContext(), 3000);
    }
  }

  zoom(direction: 1 | -1): void {
    this.autoRotate = false;
    this.rig.zoom(direction);
  }

  resetView(): void {
    if (this.closeup) {
      this.frameCloseup(true);
      return;
    }
    if (this.selected) this.frameStructure(this.selected, false);
    else {
      this.overviewPose = null;
      this.rig.transitionTo(this.defaultOverviewPose(), this.motionDuration(1.2));
    }
  }

  setInsets(insets: ViewInsets): void {
    this.rig.setInsets(insets);
  }

  async exportImage(mode: 'clean' | 'annotated'): Promise<{ filename: string }> {
    if (this.phase !== 'exploring' && this.phase !== 'ready') throw new Error('the 3D view is not ready');
    const state = appStore.getState();
    const t = state.translator;
    const route = underlyingRoute(state);
    const scale = Math.min(2, 4096 / Math.max(1, this.width), 4096 / Math.max(1, this.height));
    const prevDpr = this.gl.getPixelRatio();
    const labels = this.labels && state.settings.labels ? this.labels.snapshot() : [];
    const title = route.structure ? t.t(`structures.${route.structure}.name`) : t.t('overview.title');
    const viewTitle =
      route.structure && this.closeup
        ? `${title} · ${t.t(`structures.${route.structure}.views.${structureRecord(route.structure).closeup.views[this.closeup.viewIndex].id}.title`)}`
        : title;
    const slug = route.structure ? structureRecord(route.structure).slug : 'whole-cell';
    const filename = `human-cell-atlas-${slug}${this.closeup ? '-closeup' : ''}-${mode}.png`;
    try {
      const blob = await renderExport({
        renderFrame: () => {
          // Temporary export settings: higher pixel ratio for this one frame.
          this.setRenderSize(this.width, this.height, scale);
          this.render();
          return this.canvas;
        },
        mode,
        cssWidth: this.width,
        cssHeight: this.height,
        pixelRatio: scale,
        labels,
        scale: this.lastScale,
        title: viewTitle,
        caption: t.t('export.caption', { title, app: t.t('app.title') }),
        scaleNote: t.t('export.scaleNote'),
        filename,
      });
      downloadBlob(blob, filename);
    } finally {
      // Restore the interactive settings even if encoding failed.
      this.setRenderSize(this.width, this.height, prevDpr);
      this.render();
    }
    return { filename };
  }

  // ── Store reactions ──────────────────────────────────────────────────────

  private onStore(state: AppState, prev: AppState): void {
    if (this.phase === 'disposed') return;
    const route = underlyingRoute(state);
    const prevRoute = underlyingRoute(prev);
    if (
      route.structure !== prevRoute.structure ||
      route.view !== prevRoute.view ||
      state.focusNonce !== prev.focusNonce ||
      (route.view === 'closeup' && state.closeupViewIndex !== prev.closeupViewIndex)
    ) {
      this.applyRoute(false);
    }
    if (state.hovered !== prev.hovered) this.updateEmphasisTargets();
    if (state.settings.quality !== prev.settings.quality) {
      const level = state.settings.quality === 'auto' ? this.quality : state.settings.quality;
      this.applyQuality(level, state.settings.quality === 'auto');
    }
    if (state.translator !== prev.translator || state.settings.labels !== prev.settings.labels) {
      this.labelMode = '';
      this.lastScaleKey = '';
    }
  }

  private applyRoute(initial: boolean): void {
    if (this.phase !== 'exploring') return;
    const state = appStore.getState();
    const route = underlyingRoute(state);
    const id = route.page === 'cell' || route.page === 'about' ? route.structure : null;
    const nonceChanged = state.focusNonce !== this.lastNonce;
    this.lastNonce = state.focusNonce;
    if (id && route.view === 'closeup') {
      void this.openCloseup(id, state.closeupViewIndex);
      return;
    }
    if (this.closeup) this.closeCloseup();
    if (id !== this.selected || nonceChanged || initial) this.focusOn(id);
  }

  private focusOn(id: StructureId | null): void {
    const previous = this.selected;
    if (previous === null && id !== null && !this.rig.transitioning) this.overviewPose = this.rig.pose();
    this.selected = id;
    for (const [sid, instance] of this.structures) instance.setFocused(sid === id);
    this.updateOpacityTargets();
    this.emphasisPulse = id ? 1 : 0;
    this.updateEmphasisTargets();
    this.cutTargets.membrane = membraneCutCos(id);
    this.cutTargets.nucleus = nucleusCutCos(id);
    this.labelMode = '';
    if (id) this.frameStructure(id, true);
    else {
      this.setOverviewLimits();
      const pose = this.overviewPose ?? this.defaultOverviewPose();
      this.startTransition(pose, null);
    }
  }

  private frameStructure(id: StructureId, notify: boolean): void {
    const instance = this.structures.get(id);
    if (!instance) return;
    const framing = instance.framing();
    const pose = this.rig.poseFor({ target: framing.target, radius: framing.radius, direction: framing.direction });
    const fit = this.rig.fitDistance(framing.radius);
    this.rig.setDistanceLimits(Math.min(this.rig.controls.minDistance, framing.radius * 0.3), Math.max(this.rig.controls.maxDistance, fit * 4));
    this.startTransition(pose, notify ? id : null, () => this.rig.setDistanceLimits(framing.radius * 0.3, Math.max(fit * 4, 16)));
  }

  private startTransition(pose: Pose, arrivedId: StructureId | null, after?: () => void): void {
    const duration = this.motionDuration(this.rig.durationFor(pose));
    appStore.setState({ viewState: 'transition' });
    const arrive = () => {
      this.pendingArrival = null;
      after?.();
      const closeup = !!this.closeup;
      appStore.setState({ viewState: closeup ? 'closeup' : this.selected ? 'focused' : 'overview' });
      notifyCameraArrived(arrivedId);
    };
    this.pendingArrival = arrive;
    this.rig.transitionTo(pose, duration, () => {
      if (this.pendingArrival === arrive) arrive();
    });
  }

  private motionDuration(seconds: number): number {
    return reducedMotion(appStore.getState()) ? 0 : seconds;
  }

  private defaultOverviewPose(): Pose {
    const target = new THREE.Vector3(0, -0.15, 0);
    const distance = this.rig.fitDistance(7.5, 1.08);
    return { target, position: target.clone().addScaledVector(OVERVIEW_DIRECTION, distance) };
  }

  private setOverviewLimits(): void {
    this.rig.setDistanceLimits(2.5, Math.max(48, this.rig.fitDistance(7.5) * 2.2));
  }

  // ── Close-ups ────────────────────────────────────────────────────────────

  private async openCloseup(id: StructureId, viewIndex: number): Promise<void> {
    const views = structureRecord(id).closeup.views;
    const index = Math.min(viewIndex, views.length - 1);
    if (this.closeup && this.closeup.id === id) {
      if (this.closeup.viewIndex !== index) {
        this.closeup.viewIndex = index;
        this.closeup.scene.setView(index);
        this.labelMode = '';
        this.frameCloseup(true);
      }
      return;
    }
    const token = ++this.closeupToken;
    if (this.closeup) this.disposeCloseup();
    this.selected = id;
    for (const [sid, instance] of this.structures) instance.setFocused(sid === id);
    this.updateOpacityTargets();
    this.applyFocusImmediately();
    this.snapshotInset(id);
    appStore.setState({ closeupStatus: 'loading', viewState: 'transition' });
    try {
      const factory = (await CLOSEUP_LOADERS[id]()).default;
      if (token !== this.closeupToken || this.phase === 'disposed') return;
      const scene = factory({ quality: this.quality, pointScale: this.pointScale });
      this.closeup = { id, scene, viewIndex: index };
      scene.setView(index);
      if (this.renderPass) this.renderPass.scene = scene.scene;
      this.labelMode = '';
      this.frameCloseup(true, true);
      appStore.setState({ closeupStatus: 'ready' });
    } catch (error) {
      if (token !== this.closeupToken) return;
      console.error(error);
      appStore.setState({ closeupStatus: 'error', viewState: 'focused' });
    }
  }

  private frameCloseup(animated: boolean, entering = false): void {
    if (!this.closeup) return;
    const view = this.closeup.scene.views[this.closeup.viewIndex];
    const distance = this.rig.fitDistance(view.radius, 1.05);
    const dir = view.direction.clone().normalize();
    const pose: Pose = { target: view.target.clone(), position: view.target.clone().addScaledVector(dir, distance) };
    this.rig.setDistanceLimits(view.radius * 0.25, distance * 3.5);
    this.camera.near = Math.max(0.01, view.radius * 0.005);
    this.camera.far = view.radius * 60;
    this.camera.updateProjectionMatrix();
    if (entering) {
      // Start a little farther out so the close-up "arrives" (instant with reduced motion).
      this.rig.transitionTo({ target: pose.target, position: view.target.clone().addScaledVector(dir, distance * 1.9) }, 0);
    }
    const duration = animated ? this.motionDuration(1.3) : 0;
    appStore.setState({ viewState: 'transition' });
    const id = this.closeup.id;
    const arrive = () => {
      this.pendingArrival = null;
      appStore.setState({ viewState: 'closeup' });
      notifyCameraArrived(id);
    };
    this.pendingArrival = arrive;
    this.rig.transitionTo(pose, duration, () => {
      if (this.pendingArrival === arrive) arrive();
    });
  }

  private disposeCloseup(): void {
    if (!this.closeup) return;
    this.closeup.scene.dispose();
    this.closeup = null;
    if (this.renderPass) this.renderPass.scene = this.scene;
  }

  private closeCloseup(): void {
    this.closeupToken++;
    this.disposeCloseup();
    this.camera.near = 0.05;
    this.camera.far = 600;
    this.camera.updateProjectionMatrix();
    appStore.setState({ closeupStatus: 'idle' });
    this.labelMode = '';
  }

  /** Draw the whole cell with the structure highlighted into the close-up's location inset. */
  private snapshotInset(id: StructureId): void {
    const canvas = overlays.insetCanvas;
    const instance = this.structures.get(id);
    if (!canvas || !instance) return;
    const size = 300;
    const target = new THREE.WebGLRenderTarget(size, size, { samples: 4 });
    target.texture.colorSpace = THREE.SRGBColorSpace;
    const cam = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
    const framing = instance.framing();
    const dir = (framing.direction ?? OVERVIEW_DIRECTION).clone().add(OVERVIEW_DIRECTION).normalize();
    cam.position.copy(dir.multiplyScalar(26));
    cam.lookAt(0, 0, 0);
    try {
      const prevMembrane = this.cuts.membrane.uCutDir.value.clone();
      this.cuts.membrane.uCutDir.value.copy(cam.position).normalize();
      this.gl.setRenderTarget(target);
      this.gl.render(this.scene, cam);
      const pixels = new Uint8Array(size * size * 4);
      this.gl.readRenderTargetPixels(target, 0, 0, size, size, pixels);
      this.gl.setRenderTarget(null);
      this.cuts.membrane.uCutDir.value.copy(prevMembrane);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const image = ctx.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        image.data.set(pixels.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
      }
      ctx.putImageData(image, 0, 0);
      const p = framing.target.clone().project(cam);
      const x = (p.x * 0.5 + 0.5) * size;
      const y = (-p.y * 0.5 + 0.5) * size;
      ctx.strokeStyle = '#ffd27a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, 18, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd27a';
      ctx.fill();
    } catch {
      /* The inset is decorative; ignore failures. */
    } finally {
      this.gl.setRenderTarget(null);
      target.dispose();
    }
  }

  // ── Focus, picking, hover ────────────────────────────────────────────────

  private updateOpacityTargets(): void {
    const id = this.selected;
    const context = id ? CONTEXT[id] ?? {} : {};
    for (const [sid, instance] of this.structures) {
      const st = this.focus.get(sid)!;
      if (!id) st.target = instance.overviewOpacity;
      else if (sid === id) st.target = 1;
      else st.target = context[sid] ?? GHOST_OVERRIDE[sid] ?? GHOST;
    }
  }

  private updateEmphasisTargets(): void {
    const hovered = appStore.getState().hovered;
    for (const [sid, st] of this.focus) {
      let e = 0;
      if (sid === this.selected) e = 0.35 + this.emphasisPulse * 0.9;
      if (sid === hovered && sid !== this.selected) e = Math.max(e, 0.7);
      st.emphasisTarget = e;
    }
  }

  private applyFocusImmediately(): void {
    for (const [sid, st] of this.focus) {
      st.opacity = st.target;
      st.emphasis = st.emphasisTarget;
      for (const handle of this.structures.get(sid)!.focus) handle.apply(st.opacity, st.emphasis);
    }
  }

  private pick(ray: THREE.Ray): StructureId | null {
    let best: { id: StructureId; t: number } | null = null;
    let focusedHit: number | null = null;
    for (const [sid, instance] of this.structures) {
      const st = this.focus.get(sid)!;
      if (st.opacity < PICK_THRESHOLD) continue;
      const t = instance.raycast(ray);
      if (t === null) continue;
      if (sid === this.selected) focusedHit = t;
      if (!best || t < best.t) best = { id: sid, t };
    }
    // The focused structure wins over translucent context in front of it.
    if (this.selected && focusedHit !== null) return this.selected;
    return best?.id ?? null;
  }

  private onScenePick(id: StructureId | null, pointerType: string): void {
    if (!id) return;
    if (pointerType !== 'mouse') this.emphasisPulse = 1.4;
    selectStructure(id, { source: 'scene' });
  }

  private onSceneHover(id: StructureId | null, x: number, y: number): void {
    setHovered(id);
    const tip = overlays.hoverTip;
    if (!tip) return;
    if (id) {
      const rect = this.canvas.getBoundingClientRect();
      tip.textContent = appStore.getState().translator.t(`structures.${id}.name`);
      tip.style.transform = `translate3d(${x - rect.left + 14}px, ${y - rect.top + 16}px, 0)`;
      tip.classList.add('is-visible');
      this.canvas.style.cursor = 'pointer';
    } else {
      tip.classList.remove('is-visible');
      this.canvas.style.cursor = '';
    }
  }

  // ── Quality ──────────────────────────────────────────────────────────────

  private applyQuality(level: QualityLevel, auto: boolean): void {
    this.quality = level;
    const drawn: Partial<Record<StructureId, number>> = {};
    for (const [sid, instance] of this.structures) {
      const count = instance.setQuality(level);
      if (count !== null) drawn[sid] = count;
    }
    const preset = QUALITY_PRESETS[level];
    // Image-based lighting costs several texture reads per pixel; low quality uses the lights alone.
    const useEnv = level !== 'low';
    if ((this.scene.environment !== null) !== useEnv) {
      this.scene.environment = useEnv ? this.envMap : null;
      this.hemi.intensity = useEnv ? 1.05 : 1.35;
    }
    this.configureComposer(preset.bloom, preset.msaa);
    const dpr = Math.min(window.devicePixelRatio || 1, preset.maxPixelRatio);
    this.hooks.setDpr(dpr);
    this.perf.setAuto(auto && !debugParams.quality, level);
    appStore.setState({ effectiveQuality: level, drawn });
  }

  private configureComposer(bloom: boolean, msaa: number): void {
    if (!bloom) {
      this.composer?.dispose();
      this.composer = null;
      this.renderPass = null;
      return;
    }
    if (this.composer) return;
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: msaa });
    const composer = new EffectComposer(this.gl, target);
    const renderPass = new RenderPass(this.closeup ? this.closeup.scene.scene : this.scene, this.camera);
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.42, 0.55, 0.78);
    composer.addPass(renderPass);
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());
    this.composer = composer;
    this.renderPass = renderPass;
    this.setRenderSize(this.width, this.height, this.gl.getPixelRatio());
  }

  // ── Frame loop ───────────────────────────────────────────────────────────

  resize(width: number, height: number, dpr: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.rig.setSize(this.width, this.height);
    this.setRenderSize(this.width, this.height, dpr);
    this.labelMode = '';
    this.lastScaleKey = '';
  }

  private setRenderSize(width: number, height: number, dpr: number): void {
    if (this.gl.getPixelRatio() !== dpr) this.gl.setPixelRatio(dpr);
    this.gl.setSize(width, height, false);
    if (this.composer) {
      this.composer.setPixelRatio(dpr);
      this.composer.setSize(width, height);
    }
    this.pointScale.value = (height * dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
  }

  private render(): void {
    const scene = this.closeup ? this.closeup.scene.scene : this.scene;
    if (this.composer && this.renderPass) {
      this.renderPass.scene = scene;
      this.composer.render();
    } else {
      this.gl.setRenderTarget(null);
      this.gl.render(scene, this.camera);
    }
  }

  frame(frameDt: number): void {
    if (this.phase === 'building' || this.phase === 'disposed') return;
    // The first frame after the tab becomes visible again carries the whole
    // hidden period: treat it as no time passing (and do not measure it).
    const resumed = this.skipNextFrame;
    this.skipNextFrame = false;
    const rawDt = resumed ? 0 : frameDt;
    // Real time drives motion so slow devices still finish transitions on
    // time; the cap only smooths over single hitches.
    const dt = Math.min(rawDt, 0.25);
    const state = appStore.getState();
    const reduce = reducedMotion(state);
    const bioDt = state.bioFrozen ? 0 : dt;
    this.time.value += bioDt;

    if (this.phase === 'ready' && this.autoRotate && !reduce) {
      this.rig.controls.azimuthAngle += dt * 0.08;
    }
    if (this.phase === 'entering') {
      this.enterElapsed += dt;
      const t = Math.min(1, this.enterElapsed / Math.max(1e-3, this.enterDuration));
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.cuts.membrane.uCutCos.value = THREE.MathUtils.lerp(1.01, this.cutTargets.membrane, e);
      this.cuts.nucleus.uCutCos.value = THREE.MathUtils.lerp(1.01, this.cutTargets.nucleus, e);
      if (t >= 1) this.finishEntering();
    }

    this.rig.update(dt);
    this.updateClipPlanes();
    if (this.phase === 'exploring') this.updateCuts(dt, reduce);
    this.updateFocus(dt, reduce);

    const uctx = { camera: this.camera, selected: this.selected, calm: reduce };
    if (!this.closeup) {
      for (const instance of this.structures.values()) instance.update(bioDt, this.time.value, uctx);
    } else {
      this.closeup.scene.update(bioDt, this.time.value, reduce);
    }

    this.updateLabels(state);
    this.updateScale(state);
    this.render();

    if (this.phase === 'exploring') {
      const next = resumed ? null : this.perf.sample(rawDt * 1000, this.gl, this.quality);
      if (next && next !== this.quality && state.settings.quality === 'auto') this.applyQuality(next, true);
    }
  }

  private updateClipPlanes(): void {
    // Near/far planes follow the zoom so tiny structures never clip.
    const distance = this.rig.distance();
    const near = THREE.MathUtils.clamp(distance * 0.01, 0.002, this.closeup ? 5 : 0.5);
    if (Math.abs(near - this.camera.near) / this.camera.near > 0.15) {
      this.camera.near = near;
      this.camera.far = Math.max(distance * 40, this.closeup ? 4000 : 120);
      this.camera.updateProjectionMatrix();
    }
  }

  private updateCuts(dt: number, reduce: boolean): void {
    if (!this.layout) return;
    const k = reduce ? 1 : 1 - Math.exp(-dt * 5);
    const camPos = this.camera.position;
    const target = this.rig.target();
    const cutDir = (center: THREE.Vector3, radii: THREE.Vector3) => {
      if (insideEllipsoid(camPos, center, radii)) return camPos.clone().sub(center).normalize();
      const dir = target.clone().sub(camPos);
      const len = dir.length();
      if (len < 1e-4) return camPos.clone().sub(center).normalize();
      const ray = new THREE.Ray(camPos.clone(), dir.divideScalar(len));
      const hit = rayEllipsoid(ray, center, radii);
      if (!hit || hit[0] < 0 || hit[0] > len + radii.x) return camPos.clone().sub(center).normalize();
      return ray.at(hit[0], new THREE.Vector3()).sub(center).normalize();
    };
    const m = this.cuts.membrane;
    m.uCutDir.value.lerp(cutDir(this.layout.cellCenter, this.layout.cellRadii), k).normalize();
    m.uCutCos.value += (this.cutTargets.membrane - m.uCutCos.value) * k;
    const n = this.cuts.nucleus;
    n.uCutDir.value.lerp(cutDir(this.layout.nucleusCenter, this.layout.nucleusRadii), k).normalize();
    n.uCutCos.value += (this.cutTargets.nucleus - n.uCutCos.value) * k;
  }

  private updateFocus(dt: number, reduce: boolean): void {
    const k = reduce ? 1 : 1 - Math.exp(-dt * 4.5);
    const ke = reduce ? 1 : 1 - Math.exp(-dt * 8);
    if (this.emphasisPulse > 0) {
      this.emphasisPulse = Math.max(0, this.emphasisPulse - dt * 0.8);
      this.updateEmphasisTargets();
    }
    for (const [sid, st] of this.focus) {
      const before = st.opacity + st.emphasis * 10;
      st.opacity += (st.target - st.opacity) * k;
      st.emphasis += (st.emphasisTarget - st.emphasis) * ke;
      if (Math.abs(st.opacity - st.target) < 0.002) st.opacity = st.target;
      if (Math.abs(st.opacity + st.emphasis * 10 - before) > 1e-5 || this.phase !== 'exploring') {
        for (const handle of this.structures.get(sid)!.focus) handle.apply(st.opacity, st.emphasis);
      }
    }
  }

  // ── Labels and scale ─────────────────────────────────────────────────────

  private labelSpecs(state: AppState): { mode: string; specs: LabelSpec[] } {
    const t = state.translator;
    if (this.closeup) {
      const id = this.closeup.id;
      const view = this.closeup.scene.views[this.closeup.viewIndex];
      const mode = `closeup:${id}:${this.closeup.viewIndex}`;
      return {
        mode,
        specs: view.labels.map((label, i) => ({
          key: `${mode}:${i}`,
          text: label.textKey ? t.t(label.textKey) : t.t(`structures.${id}.parts.${label.part}.name`),
          kind: 'part',
          anchors: () => (label.visible && !label.visible() ? [] : [label.anchor()]),
          priority: 100 - i,
        })),
      };
    }
    if (this.selected) {
      const id = this.selected;
      const instance = this.structures.get(id)!;
      const parts = instance.partAnchors();
      const mode = `focus:${id}:${parts.map((p) => p.textKey ?? p.part).join(',')}`;
      return {
        mode,
        specs: parts.map((part, i) => ({
          key: `${mode}:${part.part}`,
          text: part.textKey ? t.t(part.textKey) : t.t(`structures.${id}.parts.${part.part}.name`),
          kind: 'part',
          anchors: () => {
            const current = instance.partAnchors().find((p) => p.part === part.part);
            return current ? [current.position] : [];
          },
          priority: 100 - i,
        })),
      };
    }
    return {
      mode: 'overview',
      specs: STRUCTURE_IDS.map((id, i) => ({
        key: `overview:${id}`,
        text: t.t(`structures.${id}.name`),
        color: structureRecord(id).color,
        kind: 'structure',
        structureId: id,
        anchors: () => this.structures.get(id)?.labelAnchors() ?? [],
        priority: 50 - i,
      })),
    };
  }

  private isOccluded = (point: THREE.Vector3): boolean => {
    if (!this.layout || this.closeup) return false;
    const camPos = this.camera.position;
    const dir = point.clone().sub(camPos);
    const dist = dir.length();
    const ray = new THREE.Ray(camPos.clone(), dir.divideScalar(dist));
    const membrane = this.focus.get('plasma-membrane');
    if (membrane && membrane.opacity >= 0.5) {
      const hit = rayEllipsoid(ray, this.layout.cellCenter, this.layout.cellRadii);
      if (hit && hit[0] > 0 && hit[0] < dist - 0.05 && !insideCut(this.cuts.membrane, ray.at(hit[0], new THREE.Vector3()))) return true;
    }
    const nucleus = this.focus.get('nucleus');
    if (nucleus && nucleus.opacity >= 0.5) {
      const hit = rayEllipsoid(ray, this.layout.nucleusCenter, this.layout.nucleusRadii);
      if (hit) {
        for (const t of hit) {
          if (t > 0 && t < dist - 0.08 && !insideCut(this.cuts.nucleus, ray.at(t, new THREE.Vector3()))) return true;
        }
      }
    }
    return false;
  };

  private updateLabels(state: AppState): void {
    if (!this.labels) return;
    const show = state.settings.labels && this.phase === 'exploring' && !state.textAtlas;
    const { mode, specs } = this.labelSpecs(state);
    if (mode !== this.labelMode) {
      this.labelMode = mode;
      this.labels.setLabels(specs);
    }
    const insets = this.visibleInsets();
    this.labels.update(this.camera, this.width, this.height, insets, show && !this.rig.transitioning, this.isOccluded, state.hovered);
  }

  private visibleInsets(): ViewInsets {
    return this.rig.currentInsets();
  }

  private updateScale(state: AppState): void {
    const el = overlays;
    if (!el.scaleBar || !el.scaleLength) return;
    const t = state.translator;
    const closeupView = this.closeup ? structureRecord(this.closeup.id).closeup.views[this.closeup.viewIndex] : null;
    const unitNm = closeupView ? closeupView.unitNm : 1000;
    const reading = computeScale({ fovDeg: this.camera.fov, distance: this.rig.distance(), viewportHeightPx: this.height, unitNm, maxBarPx: 120 });
    const length = splitLength(reading.lengthNm);
    let context: string;
    if (closeupView) {
      const overviewNmPerPx = 1000 / (this.height / (2 * this.rig.fitDistance(7.5, 1.08) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)));
      const magnification = roundMagnification(relativeMagnification(reading.nmPerPx, overviewNmPerPx));
      context = t.t('scale.closeup', { factor: t.formatNumber(magnification) });
    } else {
      context = t.t('scale.wholeCell');
    }
    let note = '';
    if (!closeupView && this.selected) {
      const model = structureRecord(this.selected).model;
      if (model.enlargement && model.enlargement > 1.05) {
        note = t.t('scale.enlargedNote', { name: t.t(`structures.${this.selected}.name`), factor: t.formatNumber(model.enlargement) });
      }
    }
    const text = t.formatQuantity({ value: length.value, unit: length.unit });
    const key = `${reading.barPx.toFixed(1)}|${text}|${context}|${note}`;
    if (key === this.lastScaleKey) return;
    this.lastScaleKey = key;
    this.lastScale = { barPx: reading.barPx, text, context, note };
    el.scaleBar.style.width = `${reading.barPx.toFixed(1)}px`;
    el.scaleLength.textContent = text;
    if (el.scaleContext) el.scaleContext.textContent = context;
    if (el.scaleNote) el.scaleNote.textContent = note;
    el.scaleRoot?.setAttribute('aria-label', `${t.t('scale.bar', { length: text })}. ${context}. ${t.t('scale.focusNote')}${note ? ` ${note}` : ''}`);
    el.scaleRoot?.setAttribute('data-length-nm', String(reading.lengthNm));
  }

  // ── Resilience and cleanup ───────────────────────────────────────────────

  private onContextLost = (event: Event) => {
    event.preventDefault();
    reportFailure('context-lost');
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.phase = 'disposed';
    window.clearTimeout(this.contextLossTimer);
    setEngineController(null);
    this.unsubscribe();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.picker.dispose();
    this.labels?.dispose();
    this.perf.dispose();
    this.rig.dispose();
    this.disposeCloseup();
    for (const instance of this.structures.values()) instance.dispose();
    this.structures.clear();
    this.composer?.dispose();
    this.envMap.dispose();
    if (overlays.hoverTip) overlays.hoverTip.classList.remove('is-visible');
  }
}

/** True when WebGL is rasterized on the CPU, where every pixel is expensive. */
function isSoftwareRenderer(gl: THREE.WebGLRenderer): boolean {
  try {
    const context = gl.getContext();
    const info = context.getExtension('WEBGL_debug_renderer_info');
    const name = String(context.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : context.RENDERER));
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  } catch {
    return false;
  }
}
