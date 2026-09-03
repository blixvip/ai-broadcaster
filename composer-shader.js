'use strict';

(function mountComposerShader() {
  const canvas = document.getElementById('composerShader');
  const composer = document.getElementById('composer');
  if (!canvas || !composer) return;

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'low-power',
    premultipliedAlpha: true
  });
  if (!gl) {
    canvas.remove();
    composer.classList.add('shader-fallback');
    return;
  }

  const vertexSource = `#version 300 es
    in vec2 a_position;
    out vec2 v_uv;
    void main() {
      v_uv = a_position * .5 + .5;
      gl_Position = vec4(a_position, 0., 1.);
    }
  `;
  const fragmentSource = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    uniform float u_time;
    uniform float u_intensity;
    uniform float u_aspect;
    out vec4 outColor;

    void main() {
      vec2 uv = v_uv;
      float edgeDistance = min(min(uv.x, 1. - uv.x), min(uv.y, 1. - uv.y));
      float edge = 1. - smoothstep(0., .13, edgeDistance);
      float path = uv.x * 2.7 + uv.y * 1.4;
      float sweep = .5 + .5 * sin(path * 6.28318 - u_time * .55);
      float grain = .5 + .5 * sin((uv.x - uv.y) * 28. + u_time * .18);

      vec2 leftCorner = (uv - vec2(.05, .92)) * vec2(u_aspect, 1.);
      vec2 rightCorner = (uv - vec2(.95, .08)) * vec2(u_aspect, 1.);
      float corners = exp(-dot(leftCorner, leftCorner) * 7.)
        + exp(-dot(rightCorner, rightCorner) * 7.);

      vec3 cyan = vec3(.37, .89, .93);
      vec3 ice = vec3(.66, .78, 1.);
      vec3 color = mix(cyan, ice, sweep);
      float alpha = edge * (.018 + u_intensity * .10) * (.5 + sweep * .35 + grain * .15);
      alpha += corners * (.008 + u_intensity * .025);
      outColor = vec4(color * alpha, alpha);
    }
  `;

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(message || 'Shader compilation failed');
    }
    return shader;
  }

  let program;
  try {
    program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'Shader link failed');
    }
  } catch {
    canvas.remove();
    composer.classList.add('shader-fallback');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return;
  }

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 1, -1, -1, 1,
    -1, 1, 1, -1, 1, 1
  ]), gl.STATIC_DRAW);
  gl.useProgram(program);
  const position = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const timeUniform = gl.getUniformLocation(program, 'u_time');
  const intensityUniform = gl.getUniformLocation(program, 'u_intensity');
  const aspectUniform = gl.getUniformLocation(program, 'u_aspect');
  let frame = 0;
  let hovered = false;
  let currentIntensity = 0.12;
  let lastTime = 0;
  let sizeDirty = true;

  function targetIntensity() {
    if (composer.classList.contains('is-broadcasting')) return 1;
    if (composer.classList.contains('is-dragover')) return 0.9;
    if (composer.contains(document.activeElement)) return 0.66;
    if (hovered) return 0.36;
    return 0.12;
  }

  function resize() {
    if (!sizeDirty) return;
    sizeDirty = false;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
  }

  function draw(now = 0) {
    frame = 0;
    if (document.hidden) return;
    resize();
    const target = targetIntensity();
    currentIntensity += (target - currentIntensity) * (reducedMotion.matches ? 1 : 0.1);
    if (Math.abs(currentIntensity - target) <= 0.008) currentIntensity = target;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(timeUniform, reducedMotion.matches ? 0 : now / 1000);
    gl.uniform1f(intensityUniform, currentIntensity);
    gl.uniform1f(aspectUniform, canvas.width / Math.max(1, canvas.height));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    lastTime = now;

    const continuous = composer.classList.contains('is-broadcasting')
      || composer.classList.contains('is-dragover');
    const transitioning = currentIntensity !== target;
    if ((continuous || transitioning) && !reducedMotion.matches) frame = requestAnimationFrame(draw);
  }

  function wake() {
    if (document.hidden || frame) return;
    frame = requestAnimationFrame(draw);
  }

  composer.addEventListener('pointerenter', () => { hovered = true; wake(); });
  composer.addEventListener('pointerleave', () => { hovered = false; wake(); });
  composer.addEventListener('focusin', wake);
  composer.addEventListener('focusout', wake);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && frame) cancelAnimationFrame(frame);
    frame = 0;
    if (!document.hidden) wake();
  });

  const classObserver = new MutationObserver(wake);
  classObserver.observe(composer, { attributes: true, attributeFilter: ['class'] });
  const resizeObserver = new ResizeObserver(() => {
    sizeDirty = true;
    wake();
  });
  resizeObserver.observe(composer);
  reducedMotion.addEventListener?.('change', wake);
  window.addEventListener('pagehide', () => {
    if (frame) cancelAnimationFrame(frame);
    classObserver.disconnect();
    resizeObserver.disconnect();
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }, { once: true });

  draw(lastTime);
})();
