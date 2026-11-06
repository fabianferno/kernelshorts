/**
 * The prop kit: helpers every library prop can use, injected into the scene
 * page as `K`. Plain browser JS (it runs in the recorded Chromium page, with
 * `THREE` on window), kept here as a string so the page stays self-contained
 * and offline.
 *
 * Look: the OnePrompt "toy studio" — clean primitives, soft matte/satin
 * materials, a few metals, rounded edges everywhere (teardown §5b).
 */
export const KIT_JS = String.raw`
const K = (() => {
  const mat = {
    matte: (c, r = 0.8) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: 0 }),
    satin: (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.42, metalness: 0 }),
    plastic: (c) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.28, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.25 }),
    metal: (c = '#c9ccd1', r = 0.3) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: 1 }),
    gold: (r = 0.32) => new THREE.MeshStandardMaterial({ color: '#d4a64a', roughness: r, metalness: 1 }),
    glass: (c = '#ffffff', o = 0.22) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.04, metalness: 0, transparent: true, opacity: o, clearcoat: 1 }),
    glow: (c, i = 1.6) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: i, roughness: 0.4 }),
    flat: (c) => new THREE.MeshBasicMaterial({ color: c }),
  };

  function mesh(geo, m, cast = true, receive = false) {
    const o = new THREE.Mesh(geo, m);
    o.castShadow = cast;
    o.receiveShadow = receive;
    return o;
  }

  /** Box with rounded edges (extruded rounded rect + bevel), centred. */
  function roundedBox(w, h, d, r = 0.06, seg = 5) {
    r = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3);
    const s = new THREE.Shape();
    const x = -w / 2 + r, y = -h / 2 + r, ww = w - 2 * r, hh = h - 2 * r;
    s.moveTo(x, y - r);
    s.lineTo(x + ww, y - r); s.quadraticCurveTo(x + ww + r, y - r, x + ww + r, y);
    s.lineTo(x + ww + r, y + hh); s.quadraticCurveTo(x + ww + r, y + hh + r, x + ww, y + hh + r);
    s.lineTo(x, y + hh + r); s.quadraticCurveTo(x - r, y + hh + r, x - r, y + hh);
    s.lineTo(x - r, y); s.quadraticCurveTo(x - r, y - r, x, y - r);
    const g = new THREE.ExtrudeGeometry(s, {
      depth: Math.max(1e-3, d - 2 * r), bevelEnabled: true, bevelThickness: r, bevelSize: r * 0.98,
      bevelSegments: seg, curveSegments: seg * 2,
    });
    g.center();
    return g;
  }

  /** Spur gear outline, extruded, with a centre hole. Faces +z. */
  function gearGeometry(teeth, radius, depth, toothH = radius * 0.14, hole = radius * 0.22) {
    const s = new THREE.Shape();
    const steps = teeth * 4;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const phase = i % 4;
      const r = phase === 1 || phase === 2 ? radius + toothH : radius;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
    }
    const h = new THREE.Path();
    h.absarc(0, 0, hole, 0, Math.PI * 2, true);
    s.holes.push(h);
    const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: depth * 0.15, bevelSize: depth * 0.12, bevelSegments: 2, curveSegments: 24 });
    g.center();
    return g;
  }

  function canvasTexture(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  /** A mono pill label as a camera-facing sprite (world height ≈ h). */
  function label(text, opts = {}) {
    const bg = opts.bg || '#111214', fg = opts.fg || '#ffffff', h = opts.height || 0.16;
    const fontPx = 64;
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = '600 ' + fontPx + 'px "SF Mono", Menlo, monospace';
    const tw = Math.ceil(meas.measureText(text).width);
    const W = tw + 80, H = fontPx + 44;
    const tex = canvasTexture(W, H, (g) => {
      g.fillStyle = bg;
      const r = H / 2;
      g.beginPath(); g.moveTo(r, 0); g.lineTo(W - r, 0); g.arc(W - r, r, r, -Math.PI / 2, Math.PI / 2);
      g.lineTo(r, H); g.arc(r, r, r, Math.PI / 2, -Math.PI / 2); g.fill();
      g.fillStyle = fg; g.font = meas.font; g.textBaseline = 'middle'; g.textAlign = 'center';
      g.fillText(text, W / 2, H / 2 + 2);
    });
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sp.scale.set(h * W / H, h, 1);
    sp.renderOrder = 10;
    return sp;
  }

  let seed = 20261106;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const seg = (t, a, b) => clamp((t - a) / Math.max(1e-6, b - a), 0, 1);
  const ease = (x) => 1 - Math.pow(1 - x, 3);
  const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const back = (x) => { const c = 1.4; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };

  return { mat, mesh, roundedBox, gearGeometry, canvasTexture, label, rnd, clamp, seg, ease, easeInOut, back };
})();
`;
