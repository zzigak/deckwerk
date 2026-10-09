// The 3D viewer behind a dropped mesh: a DeckWerk web element page showing one
// or more models side by side. Models arrive inlined as data: URIs in
// window.MODELS = [{ url, kind: "glb"|"obj", color? }] (see src/main/meshPage.ts);
// with a colour every mesh is painted in one matte clay. One drag rotates every
// view together; idle, they turn slowly. Built by vite.meshviewer.config.ts.
//
// Shading: `#shading=<mode>` on the page address picks how every model is
// drawn (the deck stores it on the web element's src), and a row of buttons
// shown on hover switches it live. Modes: auto (own materials, clay for
// models without), material, clay, normals, depth, uv, wireframe.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const models = window.MODELS;
// Without WebGL (a GPU-less capture, an old projector laptop) show a still instead of nothing.
function fallback() {
  if (!window.FALLBACK) return;
  const img = document.createElement('img');
  img.src = window.FALLBACK;
  img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block';
  document.body.replaceChildren(img);
}
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
} catch (error) {
  fallback();
  throw error;
}
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.setScissorTest(true);
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
camera.position.set(2.0, 1.3, 2.4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.autoRotate = true;
controls.autoRotateSpeed = 1.2;
controls.minDistance = 1.2;
controls.maxDistance = 8;
// The first touch stops the idle turn; it does not come back until the slide is shown again.
controls.addEventListener('start', () => { controls.autoRotate = false; });

function lights(scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b4aa, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.8);
  rim.position.set(-4, 2, -3);
  scene.add(rim);
}

// Each model is centred and scaled to the same bounding sphere, so different sources
// line up and a long leg never turns out of the frame.
function normalise(object) {
  const box = new THREE.Box3().setFromObject(object);
  const centre = box.getCenter(new THREE.Vector3());
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const scale = 0.95 / sphere.radius;
  object.position.sub(centre).multiplyScalar(scale);
  object.scale.setScalar(scale);
  const holder = new THREE.Group();
  holder.add(object);
  return holder;
}

const clay = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, side: THREE.DoubleSide });

export const SHADING_MODES = ['auto', 'clay', 'normals', 'depth', 'uv', 'wireframe'];
const MODE_LABELS = { auto: 'Material', clay: 'Clay', normals: 'Normals', depth: 'Depth', uv: 'UV', wireframe: 'Wire' };

// Depth: near light, far dark, from just in front of the normalised model
// (radius 0.95 around the origin) to just past its middle, seen from the camera.
const depthUniforms = { near: { value: 1 }, far: { value: 3 } };
const depthMaterial = new THREE.ShaderMaterial({
  uniforms: depthUniforms,
  side: THREE.DoubleSide,
  vertexShader: `varying float vDepth;
    void main() {
      vec4 view = modelViewMatrix * vec4(position, 1.0);
      vDepth = -view.z;
      gl_Position = projectionMatrix * view;
    }`,
  fragmentShader: `uniform float near; uniform float far; varying float vDepth;
    void main() {
      float d = clamp((vDepth - near) / (far - near), 0.0, 1.0);
      gl_FragColor = vec4(vec3(1.0 - d), 1.0);
    }`,
});
// UV: a checker that also tints by u (red) and v (green), so seams and stretch both show.
const uvMaterial = new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  vertexShader: `varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `varying vec2 vUv;
    void main() {
      vec2 cell = floor(fract(vUv) * 12.0);
      float check = mod(cell.x + cell.y, 2.0);
      vec3 tint = vec3(fract(vUv.x), fract(vUv.y), 0.55);
      gl_FragColor = vec4(mix(tint * 0.55, tint, check), 1.0);
    }`,
});
const noUvMaterial = new THREE.MeshBasicMaterial({ color: 0xd94a8c, side: THREE.DoubleSide });
const normalMaterial = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
const wireMaterial = new THREE.MeshBasicMaterial({ color: 0x2b2f3a, wireframe: true });

function initialMode() {
  const asked = new URLSearchParams(location.hash.slice(1)).get('shading');
  return SHADING_MODES.includes(asked) ? asked : 'auto';
}
let mode = initialMode();
/** Every mesh with the material it arrived with and its model's clay, to switch back to. */
const meshes = [];

function applyShading() {
  for (const { mesh, original, clayPaint } of meshes) {
    if (mode === 'auto') mesh.material = original;
    else if (mode === 'clay') mesh.material = clayPaint;
    else if (mode === 'normals') mesh.material = normalMaterial;
    else if (mode === 'depth') mesh.material = depthMaterial;
    else if (mode === 'uv') mesh.material = mesh.geometry.attributes.uv ? uvMaterial : noUvMaterial;
    else if (mode === 'wireframe') mesh.material = wireMaterial;
  }
  for (const button of toolbar.children) button.dataset.on = String(button.dataset.mode === mode);
  document.body.dataset.shading = mode;
}

// Hover controls: a quiet row of pills that does not cover the model until wanted.
const toolbar = document.createElement('div');
toolbar.style.cssText = 'position:fixed;left:10px;bottom:10px;display:flex;gap:4px;opacity:0;'
  + 'transition:opacity .15s;font:600 12px/1 system-ui,sans-serif;z-index:1';
for (const name of SHADING_MODES) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = MODE_LABELS[name];
  button.dataset.mode = name;
  button.style.cssText = 'border:0;border-radius:999px;padding:6px 10px;cursor:pointer;'
    + 'background:rgba(25,25,24,.72);color:#fff';
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    mode = name;
    applyShading();
  });
  toolbar.appendChild(button);
}
const style = document.createElement('style');
style.textContent = 'body:hover > div[data-shading-bar]{opacity:1}'
  + ' div[data-shading-bar] button[data-on="true"]{background:#ec6b14!important}';
document.head.appendChild(style);
toolbar.dataset.shadingBar = '';
document.body.appendChild(toolbar);
window.addEventListener('hashchange', () => {
  mode = initialMode();
  applyShading();
});
const views = models.map(() => {
  const scene = new THREE.Scene();
  lights(scene);
  return { scene };
});

await Promise.all(models.map(async (model, i) => {
  let object;
  if (model.kind === 'obj') {
    const text = await (await fetch(model.url)).text();
    object = new OBJLoader().parse(text);
    if (!model.color) model.color = '#b8bfd9';
  } else {
    const buffer = await (await fetch(model.url)).arrayBuffer();
    // Meshes come meshopt-compressed: its decoder is inline, so nothing is fetched while presenting.
    object = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buffer, '')).scene;
  }
  const paint = model.color ? clay(model.color) : null;
  const clayPaint = paint ?? clay('#c9c4ba');
  object.traverse((node) => {
    if (!node.isMesh) return;
    if (!node.geometry.attributes.normal) node.geometry.computeVertexNormals();
    if (paint) node.material = paint;
    else for (const m of [].concat(node.material)) m.side = THREE.DoubleSide;
    meshes.push({ mesh: node, original: node.material, clayPaint });
  });
  views[i].scene.add(normalise(object));
}));

applyShading();

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  renderer.domElement.style.width = w + 'px';
  renderer.domElement.style.height = h + 'px';
  camera.aspect = (w / views.length) / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function frame() {
  controls.update();
  const distance = camera.position.distanceTo(controls.target);
  // Only the near half of the model is ever visible, so that half gets the whole grey ramp.
  depthUniforms.near.value = Math.max(0.01, distance - 1);
  depthUniforms.far.value = distance + 0.2;
  const w = window.innerWidth, h = window.innerHeight, cell = w / views.length;
  renderer.setClearColor(0x000000, 0);
  views.forEach((view, i) => {
    renderer.setViewport(i * cell, 0, cell, h);
    renderer.setScissor(i * cell, 0, cell, h);
    renderer.render(view.scene, camera);
  });
  requestAnimationFrame(frame);
}
frame();
document.body.dataset.ready = "1";

if (window.deckwerk) {
  window.deckwerk.onActive(() => {
    controls.autoRotate = true;
    camera.position.set(2.0, 1.3, 2.4);
    controls.target.set(0, 0, 0);
  });
}
