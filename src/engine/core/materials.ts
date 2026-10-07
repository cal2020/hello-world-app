import * as THREE from 'three';

/**
 * Cutaway: a spherical cap facing the viewer is removed from a shell (plasma
 * membrane, nuclear envelope) so the interior stays visible from any orbit
 * angle. The cut edge glows softly. Picking uses the same test (see
 * `insideCut`) so hidden surfaces never intercept clicks.
 */
export interface CutUniforms {
  uCutCenter: { value: THREE.Vector3 };
  uCutDir: { value: THREE.Vector3 };
  /** Cosine of the cap's half-angle; values above 1 disable the cut. */
  uCutCos: { value: number };
  uRimColor: { value: THREE.Color };
}

export function createCut(center: THREE.Vector3, rimColor: THREE.ColorRepresentation): CutUniforms {
  return {
    uCutCenter: { value: center.clone() },
    uCutDir: { value: new THREE.Vector3(0, 0, 1) },
    uCutCos: { value: 1.01 },
    uRimColor: { value: new THREE.Color(rimColor) },
  };
}

const tmp = new THREE.Vector3();
export function insideCut(cut: CutUniforms, point: THREE.Vector3): boolean {
  if (cut.uCutCos.value > 1) return false;
  tmp.copy(point).sub(cut.uCutCenter.value).normalize();
  return tmp.dot(cut.uCutDir.value) > cut.uCutCos.value;
}

const CUT_VERTEX_DECL = /* glsl */ `
varying vec3 vCutWorld;
`;
const CUT_VERTEX_MAIN = /* glsl */ `
#ifdef USE_INSTANCING
  vCutWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
#else
  vCutWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif
`;
const CUT_FRAGMENT_DECL = /* glsl */ `
varying vec3 vCutWorld;
uniform vec3 uCutCenter;
uniform vec3 uCutDir;
uniform float uCutCos;
uniform vec3 uRimColor;
`;

/** Patch a built-in material (standard/physical/basic) with the cutaway. */
export function applyCutaway(material: THREE.Material, cut: CutUniforms, rimWidth = 0.03, key = 'cut'): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    Object.assign(shader.uniforms, cut);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CUT_VERTEX_DECL}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${CUT_VERTEX_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CUT_FRAGMENT_DECL}`)
      .replace(
        'void main() {',
        /* glsl */ `void main() {
  float cutC = dot(normalize(vCutWorld - uCutCenter), uCutDir);
  if (cutC > uCutCos) discard;
  float cutRim = uCutCos > 1.0 ? 0.0 : smoothstep(uCutCos - ${rimWidth.toFixed(4)}, uCutCos, cutC);`,
      )
      .replace(
        '#include <dithering_fragment>',
        /* glsl */ `#include <dithering_fragment>
  gl_FragColor.rgb += uRimColor * cutRim * 1.6;
  gl_FragColor.a = max(gl_FragColor.a, cutRim * 0.95);`,
      );
  };
  const previousKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${previousKey ? previousKey() : ''}|${key}`;
}

/**
 * Fresnel rim lighting for translucent shells: brighter at grazing angles,
 * which reads as a glowing membrane edge.
 */
export function applyFresnel(material: THREE.Material, color: THREE.ColorRepresentation, power = 2.2, strength = 0.9, key = 'fresnel'): void {
  const fresnelColor = new THREE.Color(color);
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    shader.uniforms.uFresnelColor = { value: fresnelColor };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform vec3 uFresnelColor;`)
      .replace(
        '#include <dithering_fragment>',
        /* glsl */ `
  {
    vec3 fresnelView = normalize(vViewPosition);
    float fresnelTerm = pow(1.0 - abs(dot(normalize(normal), -fresnelView)), ${power.toFixed(2)});
    gl_FragColor.rgb += uFresnelColor * fresnelTerm * ${strength.toFixed(2)};
    gl_FragColor.a = clamp(gl_FragColor.a + fresnelTerm * 0.35 * gl_FragColor.a, 0.0, 1.0);
  }
#include <dithering_fragment>`,
      );
  };
  const previousKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${previousKey ? previousKey() : ''}|${key}`;
}

/** Controls a material's visibility and highlight from the focus system. */
export interface FocusHandle {
  /** opacity: 0–1 relative to the structure's normal look; emphasis: 0 normal, 1 selected, extra for hover. */
  apply(opacity: number, emphasis: number): void;
}

export interface StandardFocusOptions {
  /** Opacity of the material in its normal (unfocused) state. */
  baseOpacity?: number;
  emissive?: THREE.ColorRepresentation;
  emissiveBase?: number;
  emissiveBoost?: number;
  /** Keep blending on even when fully opaque (translucent shells). */
  alwaysTransparent?: boolean;
  /** Write depth only above this opacity. */
  depthWriteAbove?: number;
}

export function standardFocus(
  material: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial | THREE.MeshLambertMaterial | THREE.MeshPhongMaterial,
  options: StandardFocusOptions = {},
): FocusHandle {
  const base = options.baseOpacity ?? 1;
  const emissiveBase = options.emissiveBase ?? 0.06;
  const emissiveBoost = options.emissiveBoost ?? 0.45;
  if (options.emissive !== undefined) material.emissive.set(options.emissive);
  const depthAbove = options.depthWriteAbove ?? 0.6;
  let lastTransparent = material.transparent;
  return {
    apply(opacity, emphasis) {
      const value = base * opacity;
      material.opacity = value;
      const transparent = !!options.alwaysTransparent || value < 0.995;
      if (transparent !== lastTransparent) {
        material.transparent = transparent;
        material.needsUpdate = true;
        lastTransparent = transparent;
      }
      material.depthWrite = value > depthAbove;
      material.visible = value > 0.003;
      if ('emissiveIntensity' in material) material.emissiveIntensity = emissiveBase + emphasis * emissiveBoost;
    },
  };
}

/** For ShaderMaterials that expose uOpacity/uEmphasis uniforms. */
export function shaderFocus(material: THREE.ShaderMaterial, baseOpacity = 1, depthWriteAbove = 0.6): FocusHandle {
  return {
    apply(opacity, emphasis) {
      const value = baseOpacity * opacity;
      material.uniforms.uOpacity.value = value;
      material.uniforms.uEmphasis.value = emphasis;
      material.depthWrite = value > depthWriteAbove;
      material.visible = value > 0.003;
    },
  };
}

/** For Points materials. */
export function pointsFocus(material: THREE.PointsMaterial | THREE.ShaderMaterial, baseOpacity = 1): FocusHandle {
  return {
    apply(opacity, emphasis) {
      const value = baseOpacity * opacity;
      if (material instanceof THREE.ShaderMaterial) {
        material.uniforms.uOpacity.value = value;
        if (material.uniforms.uEmphasis) material.uniforms.uEmphasis.value = emphasis;
      } else {
        material.opacity = value;
      }
      material.visible = value > 0.003;
    },
  };
}
