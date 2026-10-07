import * as THREE from 'three';
import { Simplex3 } from '../core/noise';
import { Rng } from '../core/random';
import { blobGeometry, createCloseupScene, disposeScene } from './common';
import { addInstanceGlow, anchorOn, bandMaterial, bilayerStripGeometry, byQuality, instanced, instancedMaterial, membraneMaterial, moleculeMaterial, type Placement } from './kit';
import { ballGeometry, bandArcGeometry, bezier, cutawayMaterial, glowPoints, mergeParts, paramSurface, sstep } from './membranesParts';
import type { CloseupFactory } from './types';

/**
 * The nuclear envelope with one nuclear pore complex (1 unit = 1 nm), cut in
 * half through the pore: only the back half (z ≤ 0) is drawn and the cut face
 * looks at the camera. Cytoplasm above (+y), nucleoplasm below.
 *
 * Outer and inner membranes (5 nm bilayers, 40 nm apart) fuse around the pore
 * into the curved pore membrane (half a torus; its mid-surface comes within
 * 50 nm of the pore axis). The NPC (120 nm across) has eight-fold rings,
 * cytoplasmic filaments, a nuclear basket and an FG-repeat meshwork in its
 * ~40 nm central channel. Loop (14 s, ≈×20 slowed for the steps at the pore):
 * an importin–cargo complex docks at a filament and moves into the nucleus,
 * then an mRNA–protein package docks at the basket and moves out.
 */
const MEMBRANE = 5;
const GAP = 40; // perinuclear space
const Y_MEMBRANE = GAP / 2 + MEMBRANE / 2; // centre plane of the outer membrane (inner: −22.5)
const TORUS_R = 72.5; // pore membrane: tube-centre circle (mid-surface 50 nm from the axis at the waist)
const TORUS_A = Y_MEMBRANE;
const HALF_W = 160;
const DEPTH = 160;
const LAMINA_GAP = 80; // the lamina leaves the pore region free
const LAMINA_FRONT = 66; // stepped cutaway: the lamina is cut further forward than the membranes so its mesh shows

const NPC_COLOR = '#a894ff';
const NPC_CAP = '#7d6ad6';
const NPC_FIBRE = '#c3b4ff';
const MEMBRANE_COLOR = '#5a5298';
const LAMINA_COLOR = '#c9b8ff';
const LAMINA_RADIUS = 3.8; // ~8–10 nm thick filaments
const IMPORTIN_COLOR = '#7fd6ff';
const CARGO_COLOR = '#2ec4b6';
const MRNP_COLOR = '#ffb347';

/** Back-half angles of the eight-fold NPC (0° and 180° lie in the cut plane). */
const SECTOR_ANGLES = [180, 225, 270, 315, 360].map((d) => THREE.MathUtils.degToRad(d));

const LOOP = 14;
const IMPORT = { appear: 0, dock: 1.4, slide: 2.2, entrance: 3.3, channel: 3.9, exit: 5.5, release: 6.3, fade: 6.9, end: 7.6 };
const EXPORT = { appear: 7.2, dock: 8.4, rise: 9.5, channel: 10.2, emerge: 10.9, leave: 12.2, fade: 13, end: 13.6 };

const FILAMENT_BEADS = 16;
const BASKET_BEADS = 21;
const FIBRE_RADIUS = 1.9;

const create: CloseupFactory = (ctx) => {
  const scene = createCloseupScene('#0d0b24');
  const rng = new Rng('closeup:nucleus');
  const noise = new Simplex3('closeup:nucleus:motion');
  const quality = ctx.quality;
  const root = new THREE.Group();
  scene.add(root);
  const cut = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0); // keep z ≤ 0

  // ── Envelope: two membranes and the pore membrane (back half) ───────────
  const notchedSheet = (y: number, facingUp: boolean) => {
    const shape = new THREE.Shape();
    shape.moveTo(-HALF_W, 0);
    shape.lineTo(-TORUS_R, 0);
    shape.absarc(0, 0, TORUS_R, Math.PI, 0, true);
    shape.lineTo(HALF_W, 0);
    shape.lineTo(HALF_W, DEPTH);
    shape.lineTo(-HALF_W, DEPTH);
    shape.lineTo(-HALF_W, 0);
    const g = new THREE.ShapeGeometry(shape, 24);
    g.rotateX(-Math.PI / 2); // shape y → −z (the back half), facing +y
    if (!facingUp) g.rotateZ(Math.PI); // symmetric in x, now facing −y
    g.translate(0, y, 0);
    return g;
  };
  const torusSegments = byQuality(quality, { low: 40, medium: 56, high: 72 });
  const poreSurface = (minor: number, facing: 1 | -1) =>
    paramSurface(torusSegments, Math.round(torusSegments / 2), (u, v, p, n) => {
      const theta = Math.PI + u * Math.PI;
      const phi = Math.PI / 2 + v * Math.PI;
      const r = TORUS_R + minor * Math.cos(phi);
      p.set(r * Math.cos(theta), minor * Math.sin(phi), r * Math.sin(theta));
      n.set(Math.cos(phi) * Math.cos(theta), Math.sin(phi), Math.cos(phi) * Math.sin(theta)).multiplyScalar(facing);
    });
  const top = Y_MEMBRANE + MEMBRANE / 2;
  const bottom = Y_MEMBRANE - MEMBRANE / 2;
  const envelopeGeometry = mergeParts([
    notchedSheet(top, true), // outer membrane, cytoplasmic face
    notchedSheet(bottom, false), // outer membrane, perinuclear face
    notchedSheet(-bottom, true), // inner membrane, perinuclear face
    notchedSheet(-top, false), // inner membrane, nucleoplasmic face
    poreSurface(TORUS_A + MEMBRANE / 2, 1),
    poreSurface(TORUS_A - MEMBRANE / 2, -1),
  ]);
  const envelopeMaterial = membraneMaterial(MEMBRANE_COLOR, { rim: 0.25 });
  envelopeMaterial.emissiveIntensity = 0.08;
  const envelope = new THREE.Mesh(envelopeGeometry, envelopeMaterial);
  root.add(envelope);

  // Banded cut faces: flat membranes, the C-shaped cuts through the pore membrane, and the slab's outer sides.
  const bands: THREE.BufferGeometry[] = [];
  const stripWidth = HALF_W - TORUS_R;
  for (const side of [-1, 1]) {
    for (const y of [Y_MEMBRANE, -Y_MEMBRANE]) {
      const g = bilayerStripGeometry(stripWidth, MEMBRANE);
      g.translate(side * (TORUS_R + stripWidth / 2), y, 0);
      bands.push(g);
      const end = bilayerStripGeometry(DEPTH, MEMBRANE);
      end.rotateY((side * Math.PI) / 2);
      end.translate(side * HALF_W, y, -DEPTH / 2);
      bands.push(end);
    }
  }
  for (const y of [Y_MEMBRANE, -Y_MEMBRANE]) {
    const back = bilayerStripGeometry(2 * HALF_W, MEMBRANE);
    back.rotateY(Math.PI);
    back.translate(0, y, -DEPTH);
    bands.push(back);
  }
  const leftArc = bandArcGeometry(TORUS_A - MEMBRANE / 2, TORUS_A + MEMBRANE / 2, Math.PI / 2, -Math.PI / 2, 40);
  leftArc.translate(-TORUS_R, 0, 0);
  const rightArc = bandArcGeometry(TORUS_A - MEMBRANE / 2, TORUS_A + MEMBRANE / 2, Math.PI / 2, (3 * Math.PI) / 2, 40);
  rightArc.translate(TORUS_R, 0, 0);
  bands.push(leftArc, rightArc);
  const cutFaces = new THREE.Mesh(mergeParts(bands), bandMaterial());
  root.add(cutFaces);

  // ── Lamina: a square-ish mesh of lamin filaments under the inner membrane ─
  const laminaY = -top - 1 - LAMINA_RADIUS;
  const laminaRng = rng.fork('lamina');
  const laminaTubes: THREE.BufferGeometry[] = [];
  const radial = byQuality(quality, { low: 6, medium: 8, high: 10 });
  const addLaminaLine = (from: THREE.Vector3, to: THREE.Vector3, dy: number, seed: number) => {
    const samples = 24;
    let run: THREE.Vector3[] = [];
    const flush = () => {
      if (run.length >= 3) {
        const curve = new THREE.CatmullRomCurve3(run);
        laminaTubes.push(new THREE.TubeGeometry(curve, run.length * 3, LAMINA_RADIUS, radial, false));
      }
      run = [];
    };
    for (let i = 0; i <= samples; i++) {
      const p = from.clone().lerp(to, i / samples);
      p.y = laminaY + dy + noise.noise(seed, i * 0.35, 3) * 1.6;
      const side = new THREE.Vector3(to.z - from.z, 0, from.x - to.x).normalize();
      p.addScaledVector(side, noise.noise(seed, i * 0.3, 7) * 4);
      if (Math.hypot(p.x, p.z) < LAMINA_GAP) flush();
      else run.push(p);
    }
    flush();
  };
  for (let z = -5; z > -DEPTH; z -= 36) {
    const jitter = z > -10 ? 0 : 4; // the first filament runs right behind the cut
    addLaminaLine(new THREE.Vector3(-HALF_W, 0, z + laminaRng.range(-jitter, jitter)), new THREE.Vector3(HALF_W, 0, z + laminaRng.range(-jitter, jitter)), 1.2, z * 0.13);
  }
  addLaminaLine(new THREE.Vector3(-HALF_W, 0, 29), new THREE.Vector3(HALF_W, 0, 31), 1.2, 7.7);
  addLaminaLine(new THREE.Vector3(-HALF_W, 0, 63), new THREE.Vector3(HALF_W, 0, 61), 1.2, 9.9);
  for (let x = -HALF_W + 8; x < HALF_W; x += 36) {
    addLaminaLine(new THREE.Vector3(x + laminaRng.range(-4, 4), 0, -DEPTH), new THREE.Vector3(x + laminaRng.range(-4, 4), 0, LAMINA_FRONT + 4), -1.2, 50 + x * 0.11);
  }
  const laminaCut = new THREE.Plane(new THREE.Vector3(0, 0, -1), LAMINA_FRONT);
  const lamina = new THREE.Mesh(mergeParts(laminaTubes), cutawayMaterial(LAMINA_COLOR, '#9d8ddc', laminaCut, { emissiveIntensity: 0.1, roughness: 0.75 }));
  root.add(lamina);

  // ── Nuclear pore complex: three eight-fold rings (back half + the two cut subunits) ─
  const npcMaterial = cutawayMaterial('#ffffff', NPC_CAP, cut, { emissive: '#000000', roughness: 0.5 });
  addInstanceGlow(npcMaterial, 0.2, 'npcGlow');
  const ringColors = { cytoplasmic: new THREE.Color(NPC_COLOR).offsetHSL(0, 0, 0.05), inner: new THREE.Color(NPC_COLOR), nuclear: new THREE.Color(NPC_COLOR).offsetHSL(0.01, 0, -0.05) };
  const detail = quality === 'high' ? 3 : 2;
  const subunitShapes = [0, 1, 2].map((i) => blobGeometry(1, `npc-subunit:${i}`, 0.18, detail));
  const subunitPlacements: Placement[][] = [[], [], []];
  const _yAxis = new THREE.Vector3(0, 1, 0);
  const addLobe = (theta: number, radius: number, y: number, tangent: number, size: THREE.Vector3, k: number, color: THREE.Color) => {
    const position = new THREE.Vector3(Math.cos(theta) * radius - Math.sin(theta) * tangent, y, Math.sin(theta) * radius + Math.cos(theta) * tangent);
    const quaternion = new THREE.Quaternion().setFromAxisAngle(_yAxis, -theta);
    subunitPlacements[k % 3].push({ position, quaternion, scale: size, color });
  };
  SECTOR_ANGLES.forEach((theta, s) => {
    for (const sign of [1, -1]) {
      // Cytoplasmic (sign +1) and nuclear (−1) rings sit on the rims of the pore membrane.
      const color = sign > 0 ? ringColors.cytoplasmic : ringColors.nuclear;
      addLobe(theta, 48, sign * 34, -2, new THREE.Vector3(10, 8, 12), s * 2 + (sign > 0 ? 0 : 1), color);
      addLobe(theta, 56, sign * 40, 8, new THREE.Vector3(7, 6, 8), s * 2 + (sign > 0 ? 1 : 2), color);
    }
    // Inner (spoke) ring lining the pore membrane: two stacked halves and an outer foot.
    addLobe(theta, 34, 9, 0, new THREE.Vector3(13, 9.5, 10.5), s + 1, ringColors.inner);
    addLobe(theta, 34, -9, 0, new THREE.Vector3(13, 9.5, 10.5), s + 2, ringColors.inner);
    addLobe(theta, 44, 0, 0, new THREE.Vector3(6, 13, 9), s, ringColors.inner);
  });
  subunitShapes.forEach((shape, k) => root.add(instanced(shape, npcMaterial, subunitPlacements[k])));

  // Distal ring of the basket (~30 nm wide), cut in half like the rest.
  const distalY = -100;
  const distalRing = new THREE.Mesh(new THREE.TorusGeometry(15, 2.8, 10, 56), cutawayMaterial(NPC_FIBRE, NPC_CAP, cut, { emissiveIntensity: 0.2 }));
  distalRing.rotation.x = Math.PI / 2;
  distalRing.position.y = distalY;
  root.add(distalRing);

  // Cytoplasmic filaments and basket filaments as bead chains (CPU-animated, flexible).
  const fibreGeometry = ballGeometry(quality === 'high' ? 1 : 0);
  const fibreMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(fibreMaterial, 0.2, 'npcFibre');
  const fibreCount = SECTOR_ANGLES.length * (FILAMENT_BEADS + BASKET_BEADS);
  const fibres = instanced(
    fibreGeometry,
    fibreMaterial,
    Array.from({ length: fibreCount }, () => ({ position: new THREE.Vector3(), scale: FIBRE_RADIUS, color: NPC_FIBRE })),
  );
  root.add(fibres);
  const filamentPhase = SECTOR_ANGLES.map(() => rng.range(0, 10));
  const _bead = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3().setScalar(FIBRE_RADIUS);
  /** Cytoplasmic filament `f`, bead `i` (0 = base) at time t. */
  const filamentBead = (f: number, i: number, t: number, amp: number, target: THREE.Vector3) => {
    const theta = SECTOR_ANGLES[f];
    const s = i / (FILAMENT_BEADS - 1);
    const sway = s * s * amp;
    const radial = 54 + 9 * s + noise.noise(filamentPhase[f], t * 0.35, 1) * 7 * sway;
    const tangential = 6 * Math.sin(2.2 * s + f) + noise.noise(filamentPhase[f], t * 0.35, 5) * 8 * sway;
    const y = 43 + 47 * s - 4 * s * s;
    return target.set(Math.cos(theta) * radial - Math.sin(theta) * tangential, y, Math.sin(theta) * radial + Math.cos(theta) * tangential);
  };
  const basketBead = (f: number, i: number, t: number, amp: number, target: THREE.Vector3) => {
    const theta = SECTOR_ANGLES[f];
    const s = i / (BASKET_BEADS - 1);
    const bow = Math.sin(Math.PI * s);
    const radial = THREE.MathUtils.lerp(47, 15, s) + 9 * bow + noise.noise(filamentPhase[f], t * 0.3, 9) * 1.5 * bow * amp;
    const tangential = noise.noise(filamentPhase[f], t * 0.3, 13) * 1.5 * bow * amp;
    const y = THREE.MathUtils.lerp(-40, distalY, s);
    return target.set(Math.cos(theta) * radial - Math.sin(theta) * tangential, y, Math.sin(theta) * radial + Math.cos(theta) * tangential);
  };

  // ── FG-repeat meshwork: faint wiggling strands filling the central channel ─
  const strandCount = byQuality(quality, { low: 22, medium: 28, high: 34 });
  const STRAND_POINTS = 11;
  const fgRng = rng.fork('fg');
  const strands = Array.from({ length: strandCount }, () => {
    const theta = Math.PI + fgRng.range(0.05, 0.95) * Math.PI;
    const a = new THREE.Vector3(Math.cos(theta) * 22, fgRng.range(-17, 17), Math.sin(theta) * 22);
    const b = new THREE.Vector3(fgRng.range(-9, 9), a.y * 0.6 + fgRng.range(-6, 6), fgRng.range(-14, 3));
    const c = a.clone().lerp(b, 0.5).add(new THREE.Vector3(fgRng.range(-7, 7), fgRng.range(-6, 6), fgRng.range(-7, 7)));
    return { points: Array.from({ length: STRAND_POINTS }, (_, j) => bezier(a, c, b, j / (STRAND_POINTS - 1), new THREE.Vector3())), seed: fgRng.range(0, 100) };
  });
  const fgPositions = new Float32Array(strandCount * (STRAND_POINTS - 1) * 2 * 3);
  const fgGeometry = new THREE.BufferGeometry();
  const fgAttribute = new THREE.BufferAttribute(fgPositions, 3);
  fgAttribute.setUsage(THREE.DynamicDrawUsage);
  fgGeometry.setAttribute('position', fgAttribute);
  const fg = new THREE.LineSegments(
    fgGeometry,
    new THREE.LineBasicMaterial({ color: '#c9b8ff', transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  fg.frustumCulled = false;
  root.add(fg);
  const _fg = new THREE.Vector3();
  const _prev = new THREE.Vector3();

  // ── Transport cargo ─────────────────────────────────────────────────────
  // Import receptor (importin): a curved solenoid of HEAT repeats around its cargo.
  const importinParts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 12; k++) {
    const a = -2.3 + (k * 4.6) / 11;
    const repeat = blobGeometry(1, `importin:${k}`, 0.15, 1);
    repeat.scale(1.35, 0.75, 1.05);
    repeat.rotateZ(a);
    repeat.translate(Math.cos(a) * 3.6, Math.sin(a) * 3.6, (k - 5.5) * 0.3);
    importinParts.push(repeat);
  }
  const importinMaterial = moleculeMaterial(IMPORTIN_COLOR, { emissiveIntensity: 0.32, transparent: true });
  const importin = new THREE.Mesh(mergeParts(importinParts), importinMaterial);
  const cargoMaterial = moleculeMaterial(CARGO_COLOR, { emissiveIntensity: 0.32, transparent: true });
  const cargo = new THREE.Mesh(blobGeometry(3, 'import-cargo', 0.2, 2), cargoMaterial);
  const importComplex = new THREE.Group();
  importComplex.add(importin, cargo);
  root.add(importComplex);

  // mRNA–protein package (mRNP), elongated ~25 × 10 nm.
  const mrnpBody = blobGeometry(1, 'mrnp', 0.26, 2);
  mrnpBody.scale(5, 12.5, 5);
  const mrnpBumps = [new THREE.Vector3(3.6, 6, 2), new THREE.Vector3(-3.4, -2, 2.6), new THREE.Vector3(2, -8, -3)].map((p, i) => {
    const b = blobGeometry(2.2, `mrnp-protein:${i}`, 0.2, 1);
    b.translate(p.x, p.y, p.z);
    return b;
  });
  const mrnpMaterial = moleculeMaterial(MRNP_COLOR, { emissiveIntensity: 0.3, transparent: true });
  const mrnp = new THREE.Mesh(mergeParts([mrnpBody, ...mrnpBumps]), mrnpMaterial);
  root.add(mrnp);

  // Faint highlight halos so the small moving cargo is easy to follow at this scale.
  const importHalo = glowPoints({ count: 1, color: '#7fe8ff', size: 30, pointScale: ctx.pointScale, opacity: 0.2 });
  const exportHalo = glowPoints({ count: 1, color: '#ffc46b', size: 42, pointScale: ctx.pointScale, opacity: 0.18 });
  root.add(importHalo.points, exportHalo.points);

  const importStart = new THREE.Vector3(-108, 112, 22);
  const channelTop = new THREE.Vector3(0, 36, 0);
  const channelBottom = new THREE.Vector3(0, -36, 0);
  const basketExit = new THREE.Vector3(-16, -64, 16);
  const releaseImportin = new THREE.Vector3(6, -80, 28);
  const releaseCargo = new THREE.Vector3(-36, -94, 18);
  const exportStart = new THREE.Vector3(96, -132, 22);
  const exportDock = new THREE.Vector3(0, distalY - 6, 0);
  const exportLinger = new THREE.Vector3(10, 60, 6);
  const exportEnd = new THREE.Vector3(88, 118, 22);
  const _c = new THREE.Vector3();
  const _tip = new THREE.Vector3();
  const _base = new THREE.Vector3();
  const state = { importing: false, exporting: false, cargoPos: new THREE.Vector3(0, 999, 0), cargoRadius: 0 };
  const DOCK_FILAMENT = 0; // the cytoplasmic filament at 180° (in the cut plane, left)
  const DOCK_OFFSET = new THREE.Vector3(0, 0, 5);
  const IMPORT_ARC = new THREE.Vector3(0, 14, 0);
  const EXPORT_ARC = new THREE.Vector3(10, -12, 0);

  // ── Labels ──────────────────────────────────────────────────────────────
  const labels = [
    { part: 'outer-membrane', anchor: anchorOn(root, new THREE.Vector3(-128, top - 0.5, 0.5)) },
    { part: 'inner-membrane', anchor: anchorOn(root, new THREE.Vector3(-128, -Y_MEMBRANE, 0.5)) },
    { part: 'perinuclear-space', anchor: anchorOn(root, new THREE.Vector3(118, 2, -12)) },
    { part: 'pore-complex', anchor: anchorOn(root, new THREE.Vector3(52, -38, 0.5)) },
    { part: 'lamina', anchor: anchorOn(root, new THREE.Vector3(-118, laminaY + 2, 46)) },
    { part: 'import', anchor: anchorOn(importComplex, new THREE.Vector3(0, 5, 4)), visible: () => state.importing },
    { part: 'export', anchor: anchorOn(mrnp, new THREE.Vector3(0, 12, 5)), visible: () => state.exporting },
    { textKey: 'closeupCaptions.cytosol', anchor: anchorOn(root, new THREE.Vector3(-112, 88, -40)) },
    { textKey: 'closeupCaptions.nucleoplasm', anchor: anchorOn(root, new THREE.Vector3(100, -92, -30)) },
  ];

  return {
    scene,
    views: [
      {
        target: new THREE.Vector3(0, -8, -4),
        radius: 130,
        direction: new THREE.Vector3(0.14, 0.33, 1).normalize(),
        posterTime: 3.5, // Opens on import cargo passing through the pore.
        labels,
      },
    ],
    setView() {},
    update(_dt, t, calm) {
      const amp = calm ? 0.35 : 1;
      const local = ((t % LOOP) + LOOP) % LOOP;

      // Flexible fibres.
      let index = 0;
      for (let f = 0; f < SECTOR_ANGLES.length; f++) {
        for (let i = 0; i < FILAMENT_BEADS; i++) fibres.setMatrixAt(index++, _m.compose(filamentBead(f, i, t, amp, _bead), _q, _s));
        for (let i = 0; i < BASKET_BEADS; i++) fibres.setMatrixAt(index++, _m.compose(basketBead(f, i, t, amp, _bead), _q, _s));
      }
      fibres.instanceMatrix.needsUpdate = true;

      // Import: dock at a cytoplasmic filament, slide to the channel, pass, release.
      const I = IMPORT;
      let importAlpha = 0;
      importin.position.set(0, 0, 0);
      cargo.position.set(0, 0, 0);
      filamentBead(DOCK_FILAMENT, FILAMENT_BEADS - 2, t, amp, _tip).add(DOCK_OFFSET);
      filamentBead(DOCK_FILAMENT, 1, t, amp, _base).add(DOCK_OFFSET);
      if (local < I.dock) {
        const u = local / I.dock;
        _c.copy(importStart).lerp(_tip, 0.5).add(IMPORT_ARC);
        bezier(importStart, _c, _tip, sstep(0, 1, u), importComplex.position);
        importAlpha = sstep(0, 0.3, u);
      } else if (local < I.slide) {
        importComplex.position.copy(_tip);
        importAlpha = 1;
      } else if (local < I.entrance) {
        const u = sstep(0, 1, (local - I.slide) / (I.entrance - I.slide));
        const i = (FILAMENT_BEADS - 2) * (1 - u) + 1 * u;
        const i0 = Math.floor(i);
        filamentBead(DOCK_FILAMENT, i0, t, amp, _c);
        filamentBead(DOCK_FILAMENT, Math.min(FILAMENT_BEADS - 1, i0 + 1), t, amp, _bead);
        importComplex.position.copy(_c).lerp(_bead, i - i0).add(DOCK_OFFSET);
        importAlpha = 1;
      } else if (local < I.channel) {
        const u = sstep(0, 1, (local - I.entrance) / (I.channel - I.entrance));
        importComplex.position.copy(_base).lerp(channelTop, u);
        importAlpha = 1;
      } else if (local < I.exit) {
        const u = (local - I.channel) / (I.exit - I.channel);
        importComplex.position.copy(channelTop).lerp(channelBottom, sstep(0, 1, u));
        // Hopping between FG repeats: sideways jitter that fades in and out with the passage.
        const hop = Math.sin(Math.PI * u) * amp;
        importComplex.position.x += noise.noise(3.3, t * 0.9, 0) * 5 * hop;
        importComplex.position.z += noise.noise(4.4, t * 0.9, 0) * 3 * hop;
        importAlpha = 1;
      } else if (local < I.release) {
        const u = sstep(0, 1, (local - I.exit) / (I.release - I.exit));
        importComplex.position.copy(channelBottom).lerp(basketExit, u);
        importAlpha = 1;
      } else if (local < I.end) {
        const u = sstep(0, 1, (local - I.release) / (I.end - I.release));
        importComplex.position.copy(basketExit);
        importin.position.copy(releaseImportin).sub(basketExit).multiplyScalar(u);
        cargo.position.copy(releaseCargo).sub(basketExit).multiplyScalar(u);
        importAlpha = 1 - sstep(I.fade, I.end, local);
      }
      importComplex.rotation.set(noise.noise(t * 0.5, 1, 0) * 0.5 * amp, t * 0.4, noise.noise(t * 0.5, 2, 0) * 0.5 * amp);
      importComplex.visible = importAlpha > 0.001;
      importinMaterial.opacity = importAlpha;
      cargoMaterial.opacity = importAlpha;
      state.importing = local > I.appear + 0.3 && local < I.release;

      // Export: dock at the basket, move up through the channel, linger at the cytoplasmic face, leave.
      const E = EXPORT;
      let exportAlpha = 0;
      let tilt = 0.9;
      if (local >= E.appear && local < E.dock) {
        const u = (local - E.appear) / (E.dock - E.appear);
        _c.copy(exportStart).lerp(exportDock, 0.5).add(EXPORT_ARC);
        bezier(exportStart, _c, exportDock, sstep(0, 1, u), mrnp.position);
        exportAlpha = sstep(0, 0.3, u);
        tilt = 0.9;
      } else if (local >= E.dock && local < E.rise) {
        mrnp.position.copy(exportDock);
        mrnp.position.y += Math.sin((local - E.dock) * 5) * 0.8 * amp;
        exportAlpha = 1;
        tilt = 0.9 * (1 - sstep(E.dock, E.rise, local));
      } else if (local >= E.rise && local < E.channel) {
        mrnp.position.copy(exportDock).lerp(channelBottom, sstep(E.rise, E.channel, local));
        exportAlpha = 1;
        tilt = 0;
      } else if (local >= E.channel && local < E.emerge) {
        mrnp.position.copy(channelBottom).lerp(channelTop, sstep(E.channel, E.emerge, local));
        mrnp.position.x += noise.noise(5.5, t * 0.9, 0) * 3 * amp * Math.sin(Math.PI * ((local - E.channel) / (E.emerge - E.channel)));
        exportAlpha = 1;
        tilt = 0;
      } else if (local >= E.emerge && local < E.leave) {
        mrnp.position.copy(channelTop).lerp(exportLinger, sstep(E.emerge, E.leave - 0.4, local));
        exportAlpha = 1;
        tilt = -0.5 * sstep(E.emerge, E.leave, local);
      } else if (local >= E.leave && local < E.end) {
        mrnp.position.copy(exportLinger).lerp(exportEnd, sstep(E.leave, E.end, local));
        exportAlpha = 1 - sstep(E.fade, E.end, local);
        tilt = -0.5 - 0.3 * sstep(E.leave, E.end, local);
      }
      mrnp.rotation.set(0, t * 0.3, tilt);
      mrnp.visible = exportAlpha > 0.001;
      mrnpMaterial.opacity = exportAlpha;
      state.exporting = local > E.appear + 0.3 && local < E.leave;

      importHalo.positions[0] = importComplex.position.x;
      importHalo.positions[1] = importComplex.position.y;
      importHalo.positions[2] = importComplex.position.z;
      importHalo.alphas[0] = importAlpha * (local < I.release ? 1 : 1 - sstep(I.release, I.fade, local));
      importHalo.commit();
      exportHalo.positions[0] = mrnp.position.x;
      exportHalo.positions[1] = mrnp.position.y;
      exportHalo.positions[2] = mrnp.position.z;
      exportHalo.alphas[0] = exportAlpha;
      exportHalo.commit();

      // FG strands wiggle and part around whatever is passing through the channel.
      const inChannelImport = importComplex.visible && Math.abs(importComplex.position.y) < 45 && local < I.release;
      const inChannelExport = mrnp.visible && Math.abs(mrnp.position.y) < 50;
      if (inChannelImport) {
        state.cargoPos.copy(importComplex.position);
        state.cargoRadius = 9;
      } else if (inChannelExport) {
        state.cargoPos.copy(mrnp.position);
        state.cargoRadius = 10;
      } else {
        state.cargoPos.set(0, 999, 0);
        state.cargoRadius = 0;
      }
      let k = 0;
      const wiggle = calm ? 1.2 : 3;
      for (let s = 0; s < strands.length; s++) {
        const strand = strands[s];
        for (let j = 0; j < STRAND_POINTS; j++) {
          const p = strand.points[j];
          const w = (j / (STRAND_POINTS - 1)) * wiggle;
          _fg.set(
            p.x + noise.noise(strand.seed, j * 0.16, t * 0.6) * w,
            p.y + noise.noise(strand.seed + 20, j * 0.16, t * 0.6) * w,
            p.z + noise.noise(strand.seed + 40, j * 0.16, t * 0.6) * w,
          );
          if (state.cargoRadius > 0) {
            // Elongated push zone along the channel axis.
            const dx = _fg.x - state.cargoPos.x;
            const dz = _fg.z - state.cargoPos.z;
            const dy = (_fg.y - state.cargoPos.y) * 0.6;
            const d = Math.hypot(dx, dy, dz);
            if (d < state.cargoRadius && d > 1e-3) {
              const push = (state.cargoRadius - d) / d;
              _fg.x += dx * push;
              _fg.z += dz * push;
            }
          }
          if (j > 0) {
            fgPositions[k++] = _prev.x;
            fgPositions[k++] = _prev.y;
            fgPositions[k++] = _prev.z;
            fgPositions[k++] = _fg.x;
            fgPositions[k++] = _fg.y;
            fgPositions[k++] = _fg.z;
          }
          _prev.copy(_fg);
        }
      }
      fgAttribute.needsUpdate = true;
    },
    dispose() {
      importHalo.dispose();
      exportHalo.dispose();
      disposeScene(scene);
    },
  };
};

export default create;
