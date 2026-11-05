// Spell UI Light Rays — clipQ hero (https://spell.sh/docs/light-rays)
// Ported for the static landing hero (no React).

import * as THREE from "three";

/* Farther above the canvas so beams start at the viewport top */
const RAY_Y_POSITION_1 = -0.28;
const RAY_Y_POSITION_2 = -0.34;

/** clipQ hero preset — primary red + dark gray on black */
const RAYS = {
  intensity: 13,
  rays: 32,
  reach: 16,
  position: 50,
  backgroundColor: "#000000",
  animate: true,
  speed: 10,
  color1: "#e1182f",
  color2: "#2a2a2a",
} as const;

const VERTEX_SHADER = `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER = `
uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform float u_time;
uniform vec4 u_colors[2];
uniform float u_intensity;
uniform float u_rays;
uniform float u_reach;
uniform vec2 u_rayPos1;
uniform vec2 u_rayPos2;

float rayStrength(vec2 raySource, vec2 rayRefDirection, vec2 coord, float seedA, float seedB, float speed) {
    vec2 sourceToCoord = coord - raySource;
    float cosAngle = dot(normalize(sourceToCoord), rayRefDirection);
    float diagonal = length(u_resolution);

    return clamp(
        (.45 + 0.15 * sin(cosAngle * seedA + u_time * speed)) +
        (0.3 + 0.2 * cos(-cosAngle * seedB + u_time * speed)),
        u_reach, 1.0) *
        clamp((diagonal - length(sourceToCoord)) / diagonal, u_reach, 1.0);
}

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;
    uv.y = 1.0 - uv.y;
    vec2 coord = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
    float speed = u_rays * 10.0;

    vec2 rayPos1 = u_rayPos1;
    vec2 rayRefDir1 = normalize(vec2(1.0, -0.116));
    float raySeedA1 = 36.2214 * speed;
    float raySeedB1 = 21.11349 * speed;
    float raySpeed1 = 1.5 * speed;

    vec2 rayPos2 = u_rayPos2;
    vec2 rayRefDir2 = normalize(vec2(1.0, 0.241));
    float raySeedA2 = 22.39910 * speed;
    float raySeedB2 = 18.0234 * speed;
    float raySpeed2 = 1.1 * speed;

    float strength1 = rayStrength(rayPos1, rayRefDir1, coord, raySeedA1, raySeedB1, raySpeed1);
    float strength2 = rayStrength(rayPos2, rayRefDir2, coord, raySeedA2, raySeedB2, raySpeed2);

    float brightness = 1.0 * u_reach - (coord.y / u_resolution.y);
    float attenuation = clamp(brightness + (0.5 + u_intensity), 0.0, 1.0);

    float alpha1 = strength1 * attenuation * u_colors[0].a;
    float alpha2 = strength2 * attenuation * u_colors[1].a;

    vec3 premultColor1 = u_colors[0].rgb * alpha1;
    vec3 premultColor2 = u_colors[1].rgb * alpha2;

    vec3 blendedColor = premultColor1 + premultColor2;
    float blendedAlpha = alpha1 + alpha2 * (1.0 - alpha1);

    vec3 finalRGB = blendedColor / max(blendedAlpha, 0.0001);

    gl_FragColor = vec4(finalRGB * blendedAlpha, blendedAlpha);
}
`;

function mapRange(
  value: number,
  fromLow: number,
  fromHigh: number,
  toLow: number,
  toHigh: number,
): number {
  const percentage = (value - fromLow) / (fromHigh - fromLow);
  return toLow + percentage * (toHigh - toLow);
}

function colorToRGB(hex: string): [number, number, number] {
  const c = hex.slice(1);
  if (c.length === 3) {
    const [r, g, b] = [c[0]!, c[1]!, c[2]!];
    return [
      parseInt(r + r, 16) / 255,
      parseInt(g + g, 16) / 255,
      parseInt(b + b, 16) / 255,
    ];
  }
  return [
    parseInt(c.slice(0, 2), 16) / 255,
    parseInt(c.slice(2, 4), 16) / 255,
    parseInt(c.slice(4, 6), 16) / 255,
  ];
}

function rayUniformPositions(container: HTMLElement): {
  rayPos1: [number, number];
  rayPos2: [number, number];
} {
  const w = container.clientWidth;
  const h = container.clientHeight;
  return {
    rayPos1: [(RAYS.position / 100) * w, RAY_Y_POSITION_1 * h],
    rayPos2: [(RAYS.position / 100 + 0.02) * w, RAY_Y_POSITION_2 * h],
  };
}

function mountLightRays(container: HTMLElement) {
  container.style.backgroundColor = RAYS.backgroundColor;

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reducedMotion) {
    return;
  }

  const color1 = colorToRGB(RAYS.color1);
  const color2 = colorToRGB(RAYS.color2);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    75,
    Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1),
    0.1,
    1000,
  );
  camera.position.z = 5;

  const renderer = new THREE.WebGLRenderer({
    preserveDrawingBuffer: true,
    premultipliedAlpha: true,
    alpha: true,
    antialias: true,
    precision: "highp",
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(1);
  renderer.domElement.className = "hero-rays-canvas";
  container.append(renderer.domElement);

  const geometry = new THREE.PlaneGeometry(1024, 1024);
  const positions = rayUniformPositions(container);
  const material = new THREE.ShaderMaterial({
    fragmentShader: FRAGMENT_SHADER,
    vertexShader: VERTEX_SHADER,
    uniforms: {
      u_colors: {
        value: [
          new THREE.Vector4(color1[0], color1[1], color1[2], 1),
          new THREE.Vector4(color2[0], color2[1], color2[2], 1),
        ],
      },
      u_intensity: { value: mapRange(RAYS.intensity, 0, 100, 0, 0.5) },
      u_rays: { value: mapRange(RAYS.rays, 0, 100, 0, 0.3) },
      u_reach: { value: mapRange(RAYS.reach, 0, 100, 0, 0.5) },
      u_time: { value: Math.random() * 10000 },
      u_mouse: { value: [0, 0] },
      u_resolution: {
        value: [container.clientWidth, container.clientHeight],
      },
      u_rayPos1: { value: positions.rayPos1 },
      u_rayPos2: { value: positions.rayPos2 },
    },
    wireframe: false,
    dithering: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  const u = material.uniforms;
  let frame = 0;
  let running = true;
  let lastTime = performance.now();

  const resize = () => {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    const next = rayUniformPositions(container);
    u.u_resolution!.value = [width, height];
    u.u_rayPos1!.value = next.rayPos1;
    u.u_rayPos2!.value = next.rayPos2;
  };

  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  const tick = (time: number) => {
    if (!running) return;

    const delta = time - lastTime;
    lastTime = time;

    if (RAYS.animate) {
      u.u_time!.value += (delta * RAYS.speed) / 1000 / 10;
    }

    renderer.render(scene, camera);
    frame = requestAnimationFrame(tick);
  };

  frame = requestAnimationFrame(tick);

  const io = new IntersectionObserver(
    ([entry]) => {
      if (entry?.isIntersecting) {
        if (!running) {
          running = true;
          lastTime = performance.now();
          frame = requestAnimationFrame(tick);
        }
      } else {
        running = false;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
      }
    },
    { rootMargin: "80px" },
  );
  io.observe(container);
}

const root = document.getElementById("hero-rays");
if (root) mountLightRays(root);
