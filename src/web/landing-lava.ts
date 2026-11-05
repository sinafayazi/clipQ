// Spell UI Animated Gradient — Lava preset, clipQ primary (https://spell.sh/docs/animated-gradient)
// Ported for the static landing footer (no next-themes).

import fragmentSource from "./landing-lava-shader.glsl?raw";

/** Lava preset — primary red + grey shade on fire, pure black backdrop */
const LAVA = {
  color1: "#e1182f",
  color2: "#2a2a2a",
  color3: "#000000",
  rotation: 114,
  proportion: 100,
  scale: 0.52,
  speed: 9,
  distortion: 7,
  swirl: 18,
  swirlIterations: 20,
  softness: 100,
  offset: 717,
  shape: 2, // Edge
  shapeSize: 12,
} as const;

const FALLBACK_GRADIENT =
  "linear-gradient(160deg, #e1182f 0%, #2a2a2a 45%, #000000 100%)";

function hexToRgba(hex: string): [number, number, number, number] {
  const c = hex.slice(1);
  return [
    parseInt(c.slice(0, 2), 16) / 255,
    parseInt(c.slice(2, 4), 16) / 255,
    parseInt(c.slice(4, 6), 16) / 255,
    1,
  ];
}

function mountLava(container: HTMLElement) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    container.style.background = FALLBACK_GRADIENT;
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.className = "footer-lava-canvas";
  container.append(canvas);

  const gl = canvas.getContext("webgl2", {
    premultipliedAlpha: true,
    alpha: true,
    antialias: true,
  });
  if (!gl) {
    container.style.background = FALLBACK_GRADIENT;
    return;
  }

  const vs = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(
    vs,
    `#version 300 es
    in vec4 a_position;
    void main() { gl_Position = a_position; }`,
  );
  gl.compileShader(vs);

  const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fs, fragmentSource);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    console.warn("lava shader:", gl.getShaderInfoLog(fs));
    canvas.remove();
    container.style.background = FALLBACK_GRADIENT;
    return;
  }

  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.useProgram(program);

  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const positionLocation = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  const u = {
    time: gl.getUniformLocation(program, "u_time"),
    resolution: gl.getUniformLocation(program, "u_resolution"),
    pixelRatio: gl.getUniformLocation(program, "u_pixelRatio"),
    scale: gl.getUniformLocation(program, "u_scale"),
    rotation: gl.getUniformLocation(program, "u_rotation"),
    color1: gl.getUniformLocation(program, "u_color1"),
    color2: gl.getUniformLocation(program, "u_color2"),
    color3: gl.getUniformLocation(program, "u_color3"),
    proportion: gl.getUniformLocation(program, "u_proportion"),
    softness: gl.getUniformLocation(program, "u_softness"),
    shape: gl.getUniformLocation(program, "u_shape"),
    shapeScale: gl.getUniformLocation(program, "u_shapeScale"),
    distortion: gl.getUniformLocation(program, "u_distortion"),
    swirl: gl.getUniformLocation(program, "u_swirl"),
    swirlIterations: gl.getUniformLocation(program, "u_swirlIterations"),
  };

  const c1 = hexToRgba(LAVA.color1);
  const c2 = hexToRgba(LAVA.color2);
  const c3 = hexToRgba(LAVA.color3);
  const start = performance.now();
  let frame = 0;
  let running = true;

  const resize = () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    gl.viewport(0, 0, canvas.width, canvas.height);
  };

  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  const tick = (time: number) => {
    if (!running) return;
    const elapsed = (time - start) / 1000;
    const speed = (LAVA.speed / 100) * 5;
    gl.uniform1f(u.time, elapsed * speed + LAVA.offset * 0.01);
    gl.uniform2f(u.resolution, canvas.width, canvas.height);
    gl.uniform1f(u.pixelRatio, window.devicePixelRatio || 1);
    gl.uniform1f(u.scale, LAVA.scale);
    gl.uniform1f(u.rotation, (LAVA.rotation * Math.PI) / 180);
    gl.uniform4f(u.color1, c1[0], c1[1], c1[2], c1[3]);
    gl.uniform4f(u.color2, c2[0], c2[1], c2[2], c2[3]);
    gl.uniform4f(u.color3, c3[0], c3[1], c3[2], c3[3]);
    gl.uniform1f(u.proportion, LAVA.proportion / 100);
    gl.uniform1f(u.softness, LAVA.softness / 100);
    gl.uniform1f(u.shape, LAVA.shape);
    gl.uniform1f(u.shapeScale, LAVA.shapeSize / 100);
    gl.uniform1f(u.distortion, LAVA.distortion / 50);
    gl.uniform1f(u.swirl, LAVA.swirl / 100);
    gl.uniform1f(u.swirlIterations, LAVA.swirlIterations);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    frame = requestAnimationFrame(tick);
  };

  frame = requestAnimationFrame(tick);

  const io = new IntersectionObserver(
    ([entry]) => {
      if (entry?.isIntersecting) {
        if (!running) {
          running = true;
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

const root = document.getElementById("footer-lava");
if (root) mountLava(root);
