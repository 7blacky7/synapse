/**
 * P22-T93: Lichtrenderer fuer das Agentennetzwerk. Alles ist ein Sprite (Glut, Ring, Zelle, Funke …),
 * additiv geblendet und in EINEM instanzierten WebGL2-Draw-Call gezeichnet. Pulsieren rechnet der Shader,
 * damit ruhende Knoten keine CPU kosten. Ohne WebGL2 zeichnet ein Canvas-2D-Ersatz dieselben Sprites vereinfacht.
 */
export interface Kamera { x: number; y: number; zoom: number }
export interface Licht {
 readonly art: 'webgl2' | 'canvas2d';
 readonly info: string;
 begin(w: number, h: number, dpr: number, kamera: Kamera, zeit: number): void;
 /** groesse = Durchmesser in Weltpunkten; tiefe < 1 = Parallaxe-Hintergrund; puls = Amplitude, frequenz in rad/s. */
 sprite(x: number, y: number, groesse: number, r: number, g: number, b: number, a: number, form: number, tiefe?: number, puls?: number, phase?: number, frequenz?: number): void;
 end(): { sprites: number; verworfen: number };
 dispose(): void;
}
const HINTERGRUND = [0.02, 0.027, 0.043] as const, FLOATS = 12, MAX_SPRITES = 80000;

const VS = `#version 300 es
layout(location=0) in vec2 q;
layout(location=1) in vec4 ps;
layout(location=2) in vec4 col;
layout(location=3) in vec4 sh;
uniform vec2 uView;uniform vec3 uCam;uniform float uTime;
out vec2 vUv;out vec4 vCol;flat out int vForm;
void main(){
 float d=ps.w,z=mix(1.0,uCam.z,d);
 float p=1.0+sh.y*sin(uTime*sh.w+sh.z);
 vec2 c=(ps.xy-uCam.xy*d)*z;
 float s=max(ps.z*z*p,1.6);
 vec2 pos=c+q*s*0.5;
 gl_Position=vec4(pos.x/(uView.x*0.5),-pos.y/(uView.y*0.5),0.0,1.0);
 vUv=q;vCol=vec4(col.rgb,col.a*(0.78+0.22*p));vForm=int(sh.x+0.5);
}`;
const FS = `#version 300 es
precision mediump float;
in vec2 vUv;in vec4 vCol;flat in int vForm;out vec4 o;
void main(){
 vec2 u=vUv;float d=length(u);if(d>1.0)discard;float k=0.0;
 if(vForm==0){k=exp(-d*d*5.5);}
 else if(vForm==1){k=exp(-pow((d-0.7)*10.0,2.0))+exp(-d*d*18.0)*0.12;}
 else if(vForm==2){float m=abs(u.x)+abs(u.y);k=smoothstep(0.6,0.48,m)*0.9+exp(-m*m*7.0)*0.6;}
 else if(vForm==3){float m=max(abs(u.x),abs(u.y));k=(smoothstep(0.5,0.42,m)-smoothstep(0.32,0.24,m)*0.55)+exp(-d*d*7.0)*0.55;}
 else if(vForm==4){k=exp(-abs(u.x)*16.0)*exp(-abs(u.y)*2.4)+exp(-abs(u.y)*16.0)*exp(-abs(u.x)*2.4)+exp(-d*d*26.0)*1.2;}
 else if(vForm==5){vec2 a=abs(u);float m=max(a.x*0.866+a.y*0.5,a.y);k=exp(-pow((m-0.5)*14.0,2.0))+exp(-d*d*9.0)*0.35;}
 else if(vForm==6){float m=max(abs(u.x)*0.866+u.y*0.5,-u.y);k=smoothstep(0.42,0.32,m)*0.9+exp(-d*d*6.0)*0.5;}
 else if(vForm==7){k=exp(-pow((d-0.6)*9.0,2.0))*0.8+exp(-d*d*30.0)*1.15+exp(-d*d*3.2)*0.2;}
 else if(vForm==8){float m=1.0-d;k=m*m*m*m;}
 else{k=exp(-d*d*10.0)*1.5+exp(-d*2.4)*0.45;}
 k*=smoothstep(1.0,0.82,d);
 o=vec4(vCol.rgb*vCol.a*k,1.0);
}`;

class WebGlLicht implements Licht {
 readonly art = 'webgl2' as const; info = 'webgl2';
 private daten = new Float32Array(4096 * FLOATS); private n = 0; private verworfen = 0;
 private prog: WebGLProgram; private inst: WebGLBuffer; private vao: WebGLVertexArrayObject;
 private u: { view: WebGLUniformLocation | null; cam: WebGLUniformLocation | null; time: WebGLUniformLocation | null };
 constructor(private gl: WebGL2RenderingContext) {
  const shader = (typ: number, quelle: string) => {
   const s = gl.createShader(typ)!; gl.shaderSource(s, quelle); gl.compileShader(s);
   if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s) || 'Shader');
   return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, shader(gl.VERTEX_SHADER, VS)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p) || 'Programm');
  this.prog = p;
  this.u = { view: gl.getUniformLocation(p, 'uView'), cam: gl.getUniformLocation(p, 'uCam'), time: gl.getUniformLocation(p, 'uTime') };
  this.vao = gl.createVertexArray()!; gl.bindVertexArray(this.vao);
  const quad = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  this.inst = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
  for (let i = 0; i < 3; i++) {
   gl.enableVertexAttribArray(i + 1); gl.vertexAttribPointer(i + 1, 4, gl.FLOAT, false, FLOATS * 4, i * 16); gl.vertexAttribDivisor(i + 1, 1);
  }
  gl.bindVertexArray(null);
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  this.info = 'webgl2 · ' + String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).slice(0, 80);
 }
 begin(w: number, h: number, dpr: number, k: Kamera, zeit: number) {
  const gl = this.gl, c = gl.canvas as HTMLCanvasElement, bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; }
  gl.viewport(0, 0, bw, bh); gl.clearColor(HINTERGRUND[0], HINTERGRUND[1], HINTERGRUND[2], 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(this.prog); gl.uniform2f(this.u.view, w, h); gl.uniform3f(this.u.cam, k.x, k.y, k.zoom); gl.uniform1f(this.u.time, zeit);
  this.n = 0; this.verworfen = 0;
 }
 sprite(x: number, y: number, g: number, r: number, gr: number, b: number, a: number, form: number, tiefe = 1, puls = 0, phase = 0, frequenz = 2.4) {
  if (a <= 0.004) return;
  if ((this.n + 1) * FLOATS > this.daten.length) {
   if (this.n >= MAX_SPRITES) { this.verworfen++; return; }
   const neu = new Float32Array(this.daten.length * 2); neu.set(this.daten); this.daten = neu;
  }
  const d = this.daten, o = this.n++ * FLOATS;
  d[o] = x; d[o + 1] = y; d[o + 2] = g; d[o + 3] = tiefe; d[o + 4] = r; d[o + 5] = gr; d[o + 6] = b; d[o + 7] = a;
  d[o + 8] = form; d[o + 9] = puls; d[o + 10] = phase; d[o + 11] = frequenz;
 }
 end() {
  const gl = this.gl;
  gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE);
  gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
  gl.bufferData(gl.ARRAY_BUFFER, this.daten.subarray(0, this.n * FLOATS), gl.STREAM_DRAW);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n);
  gl.bindVertexArray(null);
  return { sprites: this.n, verworfen: this.verworfen };
 }
 dispose() { this.gl.getExtension('WEBGL_lose_context')?.loseContext(); }
}

/** Ersatz ohne WebGL2: gleiche Szene, einfache additive Kreise, harte Obergrenze je Frame. */
class CanvasLicht implements Licht {
 readonly art = 'canvas2d' as const; readonly info = 'canvas2d (ohne WebGL2)';
 private w = 0; private h = 0; private k: Kamera = { x: 0, y: 0, zoom: 1 }; private t = 0; private n = 0; private verworfen = 0;
 constructor(private ctx: CanvasRenderingContext2D) {}
 begin(w: number, h: number, dpr: number, k: Kamera, zeit: number) {
  const c = this.ctx.canvas, bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; }
  this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.ctx.globalCompositeOperation = 'source-over';
  this.ctx.fillStyle = '#05070b'; this.ctx.fillRect(0, 0, w, h); this.ctx.globalCompositeOperation = 'lighter';
  this.w = w; this.h = h; this.k = k; this.t = zeit; this.n = 0; this.verworfen = 0;
 }
 sprite(x: number, y: number, g: number, r: number, gr: number, b: number, a: number, form: number, tiefe = 1, puls = 0, phase = 0, frequenz = 2.4) {
  if (a <= 0.01) return;
  if (this.n >= 7000) { this.verworfen++; return; }
  this.n++;
  const z = 1 + (this.k.zoom - 1) * tiefe, p = 1 + puls * Math.sin(this.t * frequenz + phase);
  const sx = (x - this.k.x * tiefe) * z + this.w / 2, sy = (y - this.k.y * tiefe) * z + this.h / 2, rad = Math.max(0.8, g * z * p * (form === 0 ? 0.32 : 0.24));
  if (sx < -rad || sy < -rad || sx > this.w + rad || sy > this.h + rad) return;
  const c = this.ctx;
  c.fillStyle = 'rgba(' + (r * 255 | 0) + ',' + (gr * 255 | 0) + ',' + (b * 255 | 0) + ',' + Math.min(1, a * (form === 0 ? 0.45 : 0.8)) + ')';
  c.beginPath(); c.arc(sx, sy, rad, 0, Math.PI * 2);
  if (form === 1 || form === 5) { c.strokeStyle = c.fillStyle; c.lineWidth = Math.max(1, rad * 0.18); c.stroke(); } else c.fill();
 }
 end() { this.ctx.globalCompositeOperation = 'source-over'; return { sprites: this.n, verworfen: this.verworfen }; }
 dispose() { /* nichts zu loesen */ }
}

export function erstelleLicht(canvas: HTMLCanvasElement): Licht | null {
 try {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  if (gl) return new WebGlLicht(gl);
 } catch { /* Ersatzweg unten */ }
 const ctx = canvas.getContext('2d');
 return ctx ? new CanvasLicht(ctx) : null;
}
