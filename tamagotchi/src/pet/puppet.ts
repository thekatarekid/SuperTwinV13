import { armMask, type Rig } from "../mascot/rig.ts";

// A tiny 2.5D puppet: one WebGL2 fragment shader that warps the mascot sprite
// every frame. Each output pixel looks up where it came from in the sprite
// (backward warping), so there are no meshes to build and no seams:
//   • body   — breathing + squash/stretch about the feet, hop offset
//   • head   — roll around the neck, yaw/pitch shift with a depth falloff so
//              the centre of the face moves more than the edge (reads as 3D)
//   • eyes   — vertical squash toward the lid line (blink / sleepy squint)
//   • mouth  — jaw drop below the lip line plus a painted mouth cavity
//   • arms   — game-style limbs: each arm (found in the cut-out) rotates
//              around its shoulder; its old spot is erased
// Everything runs on the user's GPU; nothing is sent anywhere.

export interface PuppetParams {
  /** Head turn, -1 (to viewer's left) … 1 (right). */
  yaw: number;
  /** Head nod, -1 (up) … 1 (down). */
  pitch: number;
  /** Head tilt in radians (positive = clockwise). */
  roll: number;
  /** 0 = open, 1 = closed. Index 0 is the eye on the image-left. */
  blink: [number, number];
  /** 0 = closed, 1 = wide open. */
  mouth: number;
  /** Breathing phase value, -1 … 1. */
  breath: number;
  /** Squash (<1) / stretch (>1) of the whole body about the feet. */
  stretch: number;
  /** Vertical hop, in sprite heights (positive = up). */
  hop: number;
  /** Horizontal sway, in sprite widths. */
  sway: number;
  /** Arm raise, 0 = resting … 1 = straight up. Index 0 is the image-left arm. */
  arms: [number, number];
}

export const NEUTRAL: PuppetParams = {
  yaw: 0,
  pitch: 0,
  roll: 0,
  blink: [0, 0],
  mouth: 0,
  breath: 0,
  stretch: 1,
  hop: 0,
  sway: 0,
  arms: [0, 0],
};

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5); // y down, like the sprite
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec3 u_head;      // x, y, r
uniform vec4 u_eye0;      // x, y, rx, ry
uniform vec4 u_eye1;
uniform vec4 u_mouthRig;  // x, y, rx, ry
uniform vec2 u_neckFeet;  // neckY, feetY
uniform vec3 u_headPose;  // yaw, pitch, roll
uniform vec2 u_blink;
uniform float u_mouth;
uniform vec4 u_body;      // breath, stretch, hop, sway
uniform vec4 u_arm0;      // shoulder x,y  hand x,y
uniform vec4 u_arm1;
uniform vec2 u_armR;      // x > 0 when limbs are rigged
uniform vec2 u_armLift;   // 0..1 per arm

uniform sampler2D u_mask;  // limb labels: 1 = image-left arm, 2 = image-right arm
uniform float u_texel;

float armLabel(vec2 q) {
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return 0.0;
  return floor(texture(u_mask, q).r * 255.0 + 0.5);
}

// 0 = not this arm, 1 = moved arm pixel (sample armSrc), 2 = where the arm used to be
int armAt(vec2 p, vec4 arm, float lift, float side, float label, out vec2 armSrc) {
  if (u_armR.x <= 0.0 || lift < 0.01) return 0;
  vec2 s = arm.xy;
  float a = -lift * 2.3 * side; // inverse rotation about the shoulder
  vec2 q = p - s;
  vec2 src = s + vec2(q.x * cos(a) - q.y * sin(a), q.x * sin(a) + q.y * cos(a));
  if (armLabel(src) == label) { armSrc = src; return 1; }
  if (armLabel(p) == label) return 2;
  return 0;
}

// Fill a vacated arm spot with whatever lies just outside the limb (cape,
// background), searching away from the body.
vec4 fillBehindArm(vec2 p, vec2 hc) {
  float dir = sign(p.x - hc.x);
  for (int k = 1; k <= 40; k++) {
    vec2 q = p + vec2(dir * float(k) * 2.0 * u_texel, 0.0);
    // Step a few pixels past the limb's edge so its outline isn't smeared in.
    if (armLabel(q) == 0.0) {
      q.x += dir * 3.0 * u_texel;
      return (q.x < 0.0 || q.x > 1.0) ? vec4(0.0) : texture(u_tex, q);
    }
  }
  return vec4(0.0);
}

vec2 squashEye(vec2 p, vec4 e, float b) {
  vec2 d = (p - e.xy) / (e.zw * 1.35);
  float m = 1.0 - smoothstep(0.55, 1.0, length(d));
  // Lids meet a little below centre, like a real blink.
  float lid = e.y + e.w * 0.25;
  float k = max(1.0 - 0.94 * b * m, 0.06);
  p.y = lid + (p.y - lid) / k;
  return p;
}

void main() {
  vec2 p = v_uv;
  float feet = u_neckFeet.y;
  float neck = u_neckFeet.x;

  // Body: hop + sway, then stretch/breath about the feet.
  p.y += u_body.z;
  p.x -= u_body.w;
  float sy = u_body.y * (1.0 + 0.012 * u_body.x);
  float sx = 1.0 / sqrt(max(u_body.y, 0.2)) * (1.0 + 0.004 * u_body.x);
  p = vec2(0.5 + (p.x - 0.5) / sx, feet + (p.y - feet) / sy);

  vec2 hc = u_head.xy;

  // Arms first: a moved arm is drawn as-is (no head warps on it).
  vec2 armSrc = vec2(0.0);
  int arm = armAt(p, u_arm0, u_armLift.x, 1.0, 1.0, armSrc);
  if (arm != 1) {
    vec2 src1;
    int arm1 = armAt(p, u_arm1, u_armLift.y, -1.0, 2.0, src1);
    if (arm1 == 1) { arm = 1; armSrc = src1; }
    else if (arm == 0) arm = arm1;
  }
  if (arm == 1) { outColor = texture(u_tex, armSrc); return; }
  if (arm == 2) { outColor = fillBehindArm(p, hc); return; }

  // Head: mask around the head circle, fading out below the neck.
  float r = u_head.z;
  float dist = length(p - hc);
  float hm = (1.0 - smoothstep(r * 0.95, r * 1.3, dist)) * (1.0 - smoothstep(neck - r * 0.05, neck + r * 0.25, p.y));
  // Roll around the neck pivot.
  vec2 pivot = vec2(hc.x, neck);
  float a = -u_headPose.z * hm;
  vec2 q = p - pivot;
  p = pivot + vec2(q.x * cos(a) - q.y * sin(a), q.x * sin(a) + q.y * cos(a));
  // Yaw / pitch: centre of the face travels further than its rim.
  float depth = clamp(1.0 - (dist * dist) / (r * r), 0.0, 1.0);
  float travel = hm * (0.35 + 0.65 * depth);
  p.x -= u_headPose.x * r * 0.16 * travel;
  p.y -= u_headPose.y * r * 0.10 * travel;

  // Eyes.
  p = squashEye(p, u_eye0, u_blink.x);
  p = squashEye(p, u_eye1, u_blink.y);

  // Mouth: pull the chin down below the lip line.
  vec4 mr = u_mouthRig;
  float drop = u_mouth * max(mr.w * 6.0, r * 0.14);
  vec2 md = (p - vec2(mr.x, mr.y + drop * 0.5)) / vec2(mr.z * 1.9, drop + mr.w * 2.0 + 0.0001);
  float jaw = (1.0 - smoothstep(0.6, 1.0, length(md))) * step(mr.y, p.y);
  vec2 sp = vec2(p.x, p.y - drop * jaw);

  vec4 col = texture(u_tex, sp);
  if (sp.x < 0.0 || sp.x > 1.0 || sp.y < 0.0 || sp.y > 1.0) col = vec4(0.0);

  // Painted mouth cavity + tongue, shaped to the opening.
  if (u_mouth > 0.02) {
    vec2 c = (p - vec2(mr.x, mr.y + drop * 0.45)) / vec2(mr.z * 0.85, drop * 0.55 + 0.002);
    float inside = 1.0 - smoothstep(0.85, 1.0, length(c));
    vec3 mouthCol = vec3(0.23, 0.06, 0.08);
    float tongue = (1.0 - smoothstep(0.35, 0.6, length(c - vec2(0.0, 0.55)))) * inside;
    vec3 m = mix(mouthCol, vec3(0.93, 0.42, 0.47), tongue);
    col.rgb = mix(col.rgb, m * col.a, inside);
  }

  outColor = col; // texture is premultiplied on upload
}`;

export class Puppet {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private tex: WebGLTexture;
  private maskTex: WebGLTexture;
  private hasArms = false;
  private loc: Record<string, WebGLUniformLocation | null> = {};

  constructor(
    private canvas: HTMLCanvasElement,
    image: TexImageSource,
    rig: Rig,
  ) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;
    this.prog = link(gl, VERT, FRAG);
    gl.useProgram(this.prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(this.prog, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Premultiply so linear filtering doesn't bleed the (white) cut-out colour into edges.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);

    for (const n of ["u_tex", "u_head", "u_eye0", "u_eye1", "u_mouthRig", "u_neckFeet", "u_headPose", "u_blink", "u_mouth", "u_body", "u_arm0", "u_arm1", "u_armR", "u_armLift", "u_mask", "u_texel"]) {
      this.loc[n] = gl.getUniformLocation(this.prog, n);
    }
    gl.uniform1i(this.loc.u_tex, 0);

    // Limb labels, computed once from the sprite's alpha.
    this.maskTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) {
      gl.texParameteri(gl.TEXTURE_2D, k, v);
    }
    const size = (image as { width: number }).width;
    const mask = rig.arms ? armMask(alphaOf(image, size), size, rig) : null;
    this.hasArms = !!mask;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mask ? size : 1, mask ? size : 1, 0, gl.RED, gl.UNSIGNED_BYTE, mask ?? new Uint8Array(1));
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.loc.u_mask, 1);
    gl.uniform1f(this.loc.u_texel, 1 / size);
    this.setRig(rig);
  }

  setRig(rig: Rig) {
    const { gl, loc } = this;
    gl.useProgram(this.prog);
    gl.uniform3f(loc.u_head, rig.head.x, rig.head.y, rig.head.r);
    gl.uniform4f(loc.u_eye0, rig.eyes[0].x, rig.eyes[0].y, rig.eyes[0].rx, rig.eyes[0].ry);
    gl.uniform4f(loc.u_eye1, rig.eyes[1].x, rig.eyes[1].y, rig.eyes[1].rx, rig.eyes[1].ry);
    gl.uniform4f(loc.u_mouthRig, rig.mouth.x, rig.mouth.y, rig.mouth.rx, rig.mouth.ry);
    gl.uniform2f(loc.u_neckFeet, rig.neckY, rig.feetY);
    const arms = rig.arms;
    gl.uniform4f(loc.u_arm0, arms?.[0].sx ?? 0, arms?.[0].sy ?? 0, arms?.[0].hx ?? 0, arms?.[0].hy ?? 0);
    gl.uniform4f(loc.u_arm1, arms?.[1].sx ?? 0, arms?.[1].sy ?? 0, arms?.[1].hx ?? 0, arms?.[1].hy ?? 0);
    gl.uniform2f(loc.u_armR, this.hasArms && arms ? arms[0].r : 0, this.hasArms && arms ? arms[1].r : 0);
  }

  render(p: PuppetParams) {
    const { gl, loc, canvas } = this;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniform3f(loc.u_headPose, p.yaw, p.pitch, p.roll);
    gl.uniform2f(loc.u_blink, p.blink[0], p.blink[1]);
    gl.uniform1f(loc.u_mouth, p.mouth);
    gl.uniform4f(loc.u_body, p.breath, p.stretch, p.hop, p.sway);
    gl.uniform2f(loc.u_armLift, p.arms[0], p.arms[1]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose() {
    this.gl.deleteTexture(this.tex);
    this.gl.deleteTexture(this.maskTex);
    this.gl.deleteProgram(this.prog);
  }
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(prog)}`);
  return prog;
}

function alphaOf(image: TexImageSource, size: number): Uint8Array {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(image as CanvasImageSource, 0, 0, size, size);
  const px = ctx.getImageData(0, 0, size, size).data;
  const a = new Uint8Array(size * size);
  for (let i = 0; i < a.length; i++) a[i] = px[i * 4 + 3];
  return a;
}
