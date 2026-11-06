/**
 * The 3D prop library. Each prop is a browser-JS `build(THREE, P, K, CFG)`
 * that returns `{ root: THREE.Object3D, update?(t, T) }`, where P = the
 * scene's `params`, K = the kit (kit.ts), t = seconds into the beat, T = beat
 * length. The stage (generated/page.ts buildProp3d) handles lights, floor,
 * fitting, camera and the counter — props only model and animate.
 *
 * GROWING THE LIBRARY: when a reel needs an object that isn't here, write a
 * new entry in the same shape (primitives + kit materials, rounded edges, one
 * clear motion), render it with `scripts/prop-preview.ts <id>`, look at it,
 * and keep it. Every prop added makes the next reel cheaper.
 */
export interface PropDef {
  id: string;
  description: string;
  /** Human docs for `params` (shown by `scripts/prop-preview.ts --list`). */
  params: Record<string, string>;
  /** Optional: the stage reads `elevation` (camera degrees) from build()'s return. */
  code: string;
}

const watch: PropDef = {
  id: "watch",
  description: "Analog wristwatch standing upright, hands ticking, strap curving back. Styles: classic steel, gold, swatch (colourful plastic).",
  params: {
    style: "'classic' | 'gold' | 'swatch' (default classic)",
    case: "case colour (hex)", strap: "strap colour", face: "dial colour", hands: "hand colour",
    accent: "seconds hand colour", brand: "text printed on the dial", sweep: "true = smooth seconds",
  },
  code: String.raw`
function build(THREE, P, K) {
  const root = new THREE.Group();
  const style = P.style || 'classic';
  const caseMat = style === 'swatch' ? K.mat.plastic(P.case || '#e23b3b')
    : style === 'gold' ? K.mat.gold(0.28) : K.mat.metal(P.case || '#d6d8dc', 0.24);
  const strapMat = style === 'swatch' ? K.mat.plastic(P.strap || P.case || '#e23b3b') : K.mat.satin(P.strap || '#7a4a2a');
  const R = 1;
  const body = new THREE.Group();
  body.position.y = 2.45;
  root.add(body);
  const shell = K.mesh(new THREE.CylinderGeometry(R, R * 0.96, 0.36, 72), caseMat);
  shell.rotation.x = Math.PI / 2;
  body.add(shell);
  const bezel = K.mesh(new THREE.TorusGeometry(R * 0.93, 0.07, 16, 72), caseMat);
  bezel.position.z = 0.18;
  body.add(bezel);
  const faceTex = K.canvasTexture(1024, 1024, (g, w, h) => {
    g.fillStyle = P.face || '#f6f6f3'; g.fillRect(0, 0, w, h);
    g.translate(w / 2, h / 2);
    for (let i = 0; i < 60; i++) {
      g.save(); g.rotate(i * Math.PI / 30); g.fillStyle = '#26262a';
      if (i % 5 === 0) g.fillRect(-8, -440, 16, 78); else g.fillRect(-2.5, -440, 5, 26);
      g.restore();
    }
    if (P.brand) { g.fillStyle = '#3a3a3e'; g.font = '600 48px Helvetica, Arial'; g.textAlign = 'center'; g.fillText(P.brand, 0, -175); }
  });
  const face = K.mesh(new THREE.CircleGeometry(R * 0.88, 72), new THREE.MeshStandardMaterial({ map: faceTex, roughness: 0.55 }), false, true);
  face.position.z = 0.181;
  body.add(face);
  const glass = K.mesh(new THREE.CircleGeometry(R * 0.9, 72), K.mat.glass('#ffffff', 0.1), false);
  glass.position.z = 0.245;
  body.add(glass);
  const handMat = K.mat.satin(P.hands || '#1d1d1f');
  function hand(len, w, z, m) {
    const g = new THREE.Group();
    const b = K.mesh(K.roundedBox(w, len, 0.02, Math.min(w / 2.2, 0.009)), m);
    b.position.y = len / 2 - 0.09;
    g.add(b); g.position.z = z; body.add(g);
    return g;
  }
  const hourH = hand(0.5, 0.075, 0.2, handMat);
  const minH = hand(0.76, 0.052, 0.212, handMat);
  const secH = hand(0.84, 0.02, 0.224, K.mat.satin(P.accent || '#e11d2e'));
  const pin = K.mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.05, 24), K.mat.satin(P.accent || '#e11d2e'));
  pin.rotation.x = Math.PI / 2; pin.position.z = 0.236; body.add(pin);
  const crown = K.mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.16, 24), caseMat);
  crown.rotation.z = Math.PI / 2; crown.position.x = R + 0.07; body.add(crown);
  // Strap: a continuous band curving back behind the case, built from many
  // thin overlapping links so it reads as one strap, not a stack of blocks.
  for (const dir of [1, -1]) {
    const lug = K.mesh(K.roundedBox(0.98, 0.3, 0.2, 0.06), caseMat);
    lug.position.set(0, dir * (R * 0.86), -0.04);
    body.add(lug);
    let y = R * 0.95, z = -0.05, a = 0;
    for (let i = 0; i < 9; i++) {
      const link = K.mesh(K.roundedBox(0.86, 0.26, 0.09, 0.04), strapMat);
      link.position.set(0, dir * y, z);
      link.rotation.x = dir * a;
      body.add(link);
      a += 0.11;
      y += 0.22 * Math.cos(a);
      z -= 0.22 * Math.sin(a);
    }
  }
  const h0 = typeof P.time === 'number' ? P.time : 10.15;
  return {
    root,
    update(t) {
      const sec = P.sweep ? t : Math.floor(t * 1) ;
      secH.rotation.z = -(sec % 60) * Math.PI / 30 - 1.2;
      minH.rotation.z = -((h0 % 1) * 60 + t / 60) * Math.PI / 30;
      hourH.rotation.z = -((h0 % 12) + t / 3600) * Math.PI / 6;
      body.rotation.y = Math.sin(t * 0.35) * 0.16;
    },
  };
}`,
};

const watchStacks: PropDef = {
  id: "watch-stacks",
  description: "Towers of stacked watches dropping into place — compare volumes (e.g. Apple vs all of Switzerland).",
  params: {
    columns: "[{ count, kind: 'smart' | 'round', color?, screen?, label? }] (default Apple 10 vs Swiss 5)",
  },
  code: String.raw`
function build(THREE, P, K) {
  const root = new THREE.Group();
  const cols = P.columns || [
    { count: 10, kind: 'smart', label: 'APPLE' },
    { count: 5, kind: 'round', label: 'SWISS' },
  ];
  const pieces = [];
  const gap = 1.45;
  cols.forEach((c, ci) => {
    const x = (ci - (cols.length - 1) / 2) * gap;
    const step = c.kind === 'smart' ? 0.46 : 0.38;
    for (let i = 0; i < c.count; i++) {
      const m = new THREE.Group();
      if (c.kind === 'smart') {
        m.add(K.mesh(K.roundedBox(0.9, 0.42, 1.05, 0.15), K.mat.satin(c.color || '#1d1d1f')));
        const scr = K.mesh(K.roundedBox(0.74, 0.02, 0.88, 0.009), K.mat.glow(c.screen || '#2f6fe0', 0.5), false);
        scr.position.y = 0.215; m.add(scr);
      } else {
        m.add(K.mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.34, 56), K.mat.metal(c.color || '#cfd2d6', 0.26)));
        const f = K.mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.02, 56), K.mat.matte('#f7f7f4'), false);
        f.position.y = 0.175; m.add(f);
      }
      const y = 0.22 + i * step;
      m.position.set(x, y, 0);
      m.rotation.y = (K.rnd() - 0.5) * 0.6;
      root.add(m);
      pieces.push({ m, y, i, ci });
    }
    if (c.label) {
      const l = K.label(c.label, { height: 0.24 });
      l.position.set(x, 0.2, 0.95);
      root.add(l);
    }
  });
  return {
    root,
    update(t) {
      for (const p of pieces) {
        const s = 0.1 + p.i * 0.11 + p.ci * 0.06;
        const k = K.seg(t, s, s + 0.45);
        p.m.position.y = p.y + (1 - K.ease(k)) * 3.2;
        p.m.visible = k > 0;
      }
    },
  };
}`,
};

const coinPile: PropDef = {
  id: "coin-pile",
  description: "Stacks of gold coins raining down into piles — money, revenue, cost.",
  params: { stacks: "number of stacks (default 7)" },
  code: String.raw`
function build(THREE, P, K) {
  const root = new THREE.Group();
  const N = P.stacks || 7;
  const coinMat = K.mat.gold(0.26);
  const geo = new THREE.CylinderGeometry(0.32, 0.32, 0.07, 40);
  const coins = [];
  for (let s = 0; s < N; s++) {
    const a = (s / N) * Math.PI * 2;
    const rr = s === 0 ? 0 : 0.78 + K.rnd() * 0.3;
    const x = s === 0 ? 0 : Math.cos(a) * rr;
    const z = s === 0 ? 0 : Math.sin(a) * rr * 0.8;
    const h = (s === 0 ? 14 : 4) + Math.floor(K.rnd() * 9);
    for (let i = 0; i < h; i++) {
      const c = K.mesh(geo, coinMat);
      const y = 0.035 + i * 0.072;
      c.position.set(x + (K.rnd() - 0.5) * 0.04, y, z + (K.rnd() - 0.5) * 0.04);
      c.rotation.y = K.rnd() * 6;
      root.add(c);
      coins.push({ c, y, d: s * 0.05 + i * 0.03 });
    }
  }
  for (let i = 0; i < 7; i++) {
    const c = K.mesh(geo, coinMat);
    const a = K.rnd() * 6.28, r = 1.35 + K.rnd() * 0.5;
    c.position.set(Math.cos(a) * r, 0.07, Math.sin(a) * r * 0.7);
    c.rotation.set(0.25 + K.rnd() * 0.5, K.rnd() * 6, 0.15);
    root.add(c);
  }
  return {
    root,
    update(t) {
      for (const k of coins) {
        const p = K.seg(t, 0.05 + k.d, 0.45 + k.d);
        k.c.position.y = k.y + (1 - K.ease(p)) * 2.6;
        k.c.visible = p > 0;
      }
    },
  };
}`,
};

const tuningFork: PropDef = {
  id: "tuning-fork",
  description: "Glowing quartz crystal shaped like a tuning fork, vibrating, emitting pulse rings — oscillation, frequency, 'it vibrates N times a second'.",
  params: { color: "crystal colour (default ice blue)", glow: "false = no emissive pulse" },
  code: String.raw`
function build(THREE, P, K) {
  const root = new THREE.Group();
  const col = P.color || '#8fe0ff';
  const m = new THREE.MeshPhysicalMaterial({ color: col, emissive: col, emissiveIntensity: 0.3, roughness: 0.12,
    metalness: 0, transparent: true, opacity: 0.94, clearcoat: 1 });
  const prongL = K.mesh(K.roundedBox(0.22, 1.6, 0.22, 0.09), m);
  prongL.position.set(-0.32, 1.42, 0);
  const prongR = K.mesh(K.roundedBox(0.22, 1.6, 0.22, 0.09), m);
  prongR.position.set(0.32, 1.42, 0);
  const base = K.mesh(new THREE.TorusGeometry(0.32, 0.11, 20, 48, Math.PI), m);
  base.rotation.z = Math.PI; base.position.y = 0.62;
  const stem = K.mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.5, 24), m);
  stem.position.y = 0.26;
  root.add(prongL, prongR, base, stem);
  const pad = K.mesh(K.roundedBox(1.0, 0.08, 0.5, 0.03), K.mat.metal('#bfc4cb', 0.35), true, true);
  pad.position.y = 0.04; root.add(pad);
  const rings = [];
  for (let i = 0; i < 3; i++) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.016, 12, 96),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0, depthWrite: false }));
    r.position.y = 1.42;
    root.add(r);
    rings.push(r);
  }
  return {
    root,
    update(t) {
      const on = K.seg(t, 0.35, 0.9);
      const v = Math.sin(t * 88) * 0.014 * on;
      prongL.position.x = -0.32 - v;
      prongR.position.x = 0.32 + v;
      rings.forEach((r, i) => {
        const ph = (t * 0.85 + i / 3) % 1;
        r.scale.setScalar(0.55 + ph * 1.5);
        r.material.opacity = on * (1 - ph) * 0.85;
      });
      m.emissiveIntensity = (P.glow === false ? 0.05 : 0.22) + 0.4 * on * (0.5 + 0.5 * Math.sin(t * 7));
    },
  };
}`,
};

const chip: PropDef = {
  id: "chip",
  description: "Circuit board with a central chip, gold traces and glowing signal pulses travelling outward — electronics, computation, 'a chip divides…'.",
  params: { board: "board colour", pulse: "pulse colour", label: "text printed on the chip" },
  code: String.raw`
function build(THREE, P, K) {
  const root = new THREE.Group();
  const board = K.mesh(K.roundedBox(3.2, 0.12, 2.2, 0.05), K.mat.satin(P.board || '#1d4f37'), true, true);
  board.position.y = 0.06;
  root.add(board);
  const chipBody = K.mesh(K.roundedBox(0.9, 0.16, 0.9, 0.04), K.mat.satin('#151517'));
  chipBody.position.y = 0.2;
  root.add(chipBody);
  const pinMat = K.mat.metal('#d9dbe0', 0.3);
  for (let i = 0; i < 8; i++) {
    const o = -0.35 + i * 0.1;
    for (const [x, z, ry] of [[o, 0.52, 0], [o, -0.52, 0], [0.52, o, Math.PI / 2], [-0.52, o, Math.PI / 2]]) {
      const p = K.mesh(new THREE.BoxGeometry(0.05, 0.04, 0.14), pinMat, false);
      p.position.set(x, 0.14, z); p.rotation.y = ry; root.add(p);
    }
  }
  const traceMat = K.mat.metal('#c8a24a', 0.38);
  const paths = [];
  for (let i = 0; i < 10; i++) {
    const z = (-0.9 + i * 0.2) * 0.9;
    const dir = i % 2 ? 1 : -1;
    const x0 = dir * 0.62, x1 = dir * 1.5;
    const tr = K.mesh(new THREE.BoxGeometry(Math.abs(x1 - x0), 0.012, 0.035), traceMat, false);
    tr.position.set((x0 + x1) / 2, 0.125, z);
    root.add(tr);
    paths.push({ x0, x1, z });
  }
  const pulses = paths.map((p, i) => {
    const s = K.mesh(new THREE.SphereGeometry(0.05, 16, 12), K.mat.glow(P.pulse || '#5fd4ff', 2.6), false);
    s.position.y = 0.15;
    root.add(s);
    return { s, p, off: i * 0.137 };
  });
  if (P.label) {
    const tex = K.canvasTexture(512, 512, (g, w, h) => {
      g.fillStyle = '#151517'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#c3c7cd'; g.font = '600 70px Helvetica, Arial'; g.textAlign = 'center'; g.fillText(P.label, w / 2, h / 2 + 24);
    });
    const top = K.mesh(new THREE.PlaneGeometry(0.8, 0.8), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }), false);
    top.rotation.x = -Math.PI / 2; top.position.y = 0.282; root.add(top);
  }
  return {
    root,
    elevation: 40,
    update(t) {
      for (const q of pulses) {
        const ph = (t * 0.75 + q.off) % 1;
        q.s.position.x = q.p.x0 + (q.p.x1 - q.p.x0) * ph;
        q.s.position.z = q.p.z;
        q.s.scale.setScalar(0.5 + 0.6 * Math.sin(ph * Math.PI));
      }
    },
  };
}`,
};

const gears: PropDef = {
  id: "gears",
  description: "A train of meshing brass/steel gears turning at the right ratios — mechanical watches, machinery, 'betting on gears'.",
  params: { gears: "[{ t: teeth, r: radius }] (default 3 gears)" },
  code: String.raw`
function build(THREE, P, K) {
  const root = new THREE.Group();
  const holder = new THREE.Group();
  root.add(holder);
  const mats = [K.mat.gold(0.3), K.mat.metal('#c9ccd1', 0.28), K.mat.gold(0.4), K.mat.metal('#9aa0a8', 0.3)];
  const spec = P.gears || [{ t: 26, r: 0.95 }, { t: 13, r: 0.48 }, { t: 19, r: 0.7 }, { t: 11, r: 0.4 }];
  const placed = [];
  let ang = 0.35;
  spec.forEach((g, i) => {
    let x = 0, y = 0;
    if (i > 0) {
      const p = placed[i - 1];
      const d = (p.r + g.r) * 1.07 + 0.02;
      ang += i % 2 ? -1.15 : 0.95;
      x = p.x + Math.cos(ang) * d;
      y = p.y + Math.sin(ang) * d;
    }
    placed.push({ ...g, x, y });
  });
  const cx = placed.reduce((s, g) => s + g.x, 0) / placed.length;
  const cy = placed.reduce((s, g) => s + g.y, 0) / placed.length;
  const items = placed.map((g, i) => {
    const m = K.mesh(K.gearGeometry(g.t, g.r, 0.16), mats[i % mats.length]);
    m.position.set(g.x - cx, g.y - cy, (i % 2) * 0.05);
    holder.add(m);
    const ax = K.mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.34, 20), K.mat.metal('#8e949b', 0.25));
    ax.rotation.x = Math.PI / 2; ax.position.copy(m.position); holder.add(ax);
    return { m, t: g.t, dir: i % 2 ? -1 : 1, phase: i * 0.13 };
  });
  holder.position.y = 1.6;
  holder.rotation.x = -0.18;
  return {
    root,
    update(t) {
      const w0 = 0.55;
      for (const it of items) it.m.rotation.z = it.dir * w0 * (items[0].t / it.t) * t + it.phase;
    },
  };
}`,
};

const giftBox: PropDef = {
  id: "gift-box",
  description: "Wrapped present whose lid lifts open, a small Christmas tree beside it, optionally a gold watch rising out — launches, holidays, 'sold on Christmas Day'.",
  params: { color: "box colour", ribbon: "ribbon colour", tree: "false = no tree", item: "'watch' = gold watch rises out" },
  code: String.raw`
function build(THREE, P, K) {
  const root = new THREE.Group();
  const boxC = P.color || '#d9363e', rib = P.ribbon || '#f2c14e';
  const rMat = K.mat.satin(rib);
  const box = K.mesh(K.roundedBox(1.2, 0.95, 1.2, 0.05), K.mat.satin(boxC));
  box.position.y = 0.475; root.add(box);
  const r1 = K.mesh(new THREE.BoxGeometry(1.22, 0.96, 0.16), rMat); r1.position.y = 0.475; root.add(r1);
  const r2 = K.mesh(new THREE.BoxGeometry(0.16, 0.96, 1.22), rMat); r2.position.y = 0.475; root.add(r2);
  const lid = new THREE.Group(); lid.position.set(0, 0.95, -0.62); root.add(lid);
  const lidM = K.mesh(K.roundedBox(1.32, 0.2, 1.32, 0.05), K.mat.satin(boxC)); lidM.position.set(0, 0.1, 0.62); lid.add(lidM);
  const l1 = K.mesh(new THREE.BoxGeometry(1.34, 0.21, 0.16), rMat); l1.position.set(0, 0.1, 0.62); lid.add(l1);
  const l2 = K.mesh(new THREE.BoxGeometry(0.16, 0.21, 1.34), rMat); l2.position.set(0, 0.1, 0.62); lid.add(l2);
  for (const s of [-1, 1]) {
    const loop = K.mesh(new THREE.TorusGeometry(0.2, 0.06, 12, 32), rMat);
    loop.position.set(s * 0.2, 0.32, 0.62); loop.rotation.set(0, s * 0.5, s * 0.6); lid.add(loop);
  }
  let star = null;
  if (P.tree !== false) {
    const tree = new THREE.Group(); tree.position.set(1.55, 0, -0.35);
    const g = K.mat.satin('#2f8f4e');
    for (const [r, h, y] of [[0.75, 0.9, 0.55], [0.58, 0.78, 1.05], [0.4, 0.62, 1.5]]) {
      const c = K.mesh(new THREE.ConeGeometry(r, h, 32), g); c.position.y = y; tree.add(c);
    }
    const trunk = K.mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.3, 16), K.mat.satin('#7a4a2a')); trunk.position.y = 0.15; tree.add(trunk);
    star = K.mesh(new THREE.OctahedronGeometry(0.15), K.mat.glow('#f6c945', 1.3)); star.position.y = 1.95; tree.add(star);
    root.add(tree);
  }
  let item = null;
  if (P.item === 'watch') {
    item = new THREE.Group();
    const c = K.mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.12, 48), K.mat.gold(0.25)); c.rotation.x = Math.PI / 2; item.add(c);
    const f = K.mesh(new THREE.CircleGeometry(0.29, 48), K.mat.matte('#f8f4ea'), false); f.position.z = 0.062; item.add(f);
    item.position.set(0, 0.5, 0); item.visible = false; root.add(item);
  }
  return {
    root,
    update(t) {
      const o = K.ease(K.seg(t, 0.5, 1.5));
      lid.rotation.x = -o * 0.55; lid.position.y = 0.95 + o * 0.35;
      if (star) star.rotation.y = t * 1.4;
      if (item) {
        const r = K.ease(K.seg(t, 1.2, 2.4));
        item.visible = r > 0; item.position.set(0, 0.5 + r * 1.9, 0.35 * r); item.rotation.y = Math.sin(t * 0.8) * 0.4;
      }
    },
  };
}`,
};

const barPair: PropDef = {
  id: "bar-pair",
  description: "Two or three solid 3D bars rising to their values with labels — share, proportion, 'a third of units but 80% of value'.",
  params: { bars: "[{ value: 0..1 (height), label, text?: shown above the bar (default 'NN%'), color: hex | 'gold' }] (default units 33% vs value 80%)" },
  code: String.raw`
function build(THREE, P, K) {
  const root = new THREE.Group();
  const bars = P.bars || [
    { value: 0.33, label: 'UNITS', color: '#c9ccd1' },
    { value: 0.8, label: 'VALUE', color: 'gold' },
  ];
  const H = 2.3;
  const items = bars.map((b, i) => {
    const x = (i - (bars.length - 1) / 2) * 1.1;
    const m = K.mesh(K.roundedBox(0.8, 1, 0.8, 0.07), K.mat.satin(b.color === 'gold' ? '#d9a93f' : (b.color || '#c9ccd1')));
    m.position.x = x; root.add(m);
    const l = K.label(b.label, { height: 0.19 }); l.position.set(x, 0.14, 0.75); root.add(l);
    const v = K.label(b.text || Math.round(b.value * 100) + '%', { height: 0.24, bg: '#ffffff', fg: '#111214' }); root.add(v);
    const h = Math.max(0.05, b.value) * H;
    m.scale.y = h; m.position.y = h / 2; v.position.set(x, h + 0.28, 0);
    return { m, v, h, x, i };
  });
  return {
    root,
    update(t) {
      for (const it of items) {
        const k = K.ease(K.seg(t, 0.3 + it.i * 0.3, 1.5 + it.i * 0.3));
        const h = Math.max(0.02, it.h * k);
        it.m.scale.y = h; it.m.position.y = h / 2; it.v.position.y = h + 0.28;
        it.v.material.opacity = k;
      }
    },
  };
}`,
};

const laptop: PropDef = {
  id: "laptop",
  description: "Open laptop, screen of code that scrolls; optionally turns hostile (red, warning badge) — a developer's machine, malware, 'the assignment'.",
  params: {
    state: "'clean' | 'infected' (screen turns red mid-beat, warning badge pops) — default clean",
    lid: "'open' (default) | 'opening' (lid swings open first)",
    label: "short text shown on the screen title bar (e.g. 'assignment.zip')",
  },
  code: String.raw`
function build(THREE, P, K) {
  const root = new THREE.Group();
  const body = K.mat.metal('#c7cad0', 0.35);
  const base = K.mesh(K.roundedBox(2.2, 0.09, 1.5, 0.05), body, true, true);
  base.position.y = 0.045; root.add(base);
  const deck = K.mesh(K.roundedBox(1.95, 0.012, 0.8, 0.005), K.mat.satin('#2a2c31'), false);
  deck.position.set(0, 0.096, -0.18); root.add(deck);
  const pad = K.mesh(K.roundedBox(0.7, 0.01, 0.42, 0.02), K.mat.satin('#b4b8bf'), false);
  pad.position.set(0, 0.095, 0.42); root.add(pad);
  const hinge = new THREE.Group(); hinge.position.set(0, 0.09, -0.74); root.add(hinge);
  const lid = K.mesh(K.roundedBox(2.2, 1.45, 0.06, 0.05), body);
  lid.position.set(0, 0.72, 0); hinge.add(lid);
  // the screen is a live canvas: code lines scroll; infected → red + warning
  const W = 1024, H = 640;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(2.02, 1.27), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  screen.position.set(0, 0.72, 0.032); hinge.add(screen);
  const words = ['import', 'const', 'await', 'fetch(', 'token', 'deploy', 'wallet', 'sign()', 'exec', 'pyenv', 'brew', 'zsh', 'return'];
  function draw(t, infected) {
    g.fillStyle = infected ? '#2a0c0e' : '#0f1216'; g.fillRect(0, 0, W, H);
    g.fillStyle = infected ? '#5a1418' : '#1d232b'; g.fillRect(0, 0, W, 56);
    g.font = '600 30px "SF Mono", Menlo, monospace'; g.fillStyle = infected ? '#ff8a8a' : '#9fb3c8';
    g.fillText(P.label || 'assignment/', 24, 38);
    const scroll = (t * 70) % 46;
    for (let i = 0; i < 14; i++) {
      const y = 100 + i * 46 - scroll;
      let x = 24 + ((i * 37) % 5) * 28;
      for (let k = 0; k < 4; k++) {
        const w = words[(i * 3 + k * 5) % words.length];
        g.fillStyle = infected ? (k % 2 ? '#ff6b6b' : '#ffb3b3') : (k % 2 ? '#7cc4ff' : '#c9d6e3');
        g.fillText(w, x, y); x += g.measureText(w + ' ').width;
      }
    }
    if (infected) {
      g.fillStyle = 'rgba(225,29,46,0.92)'; g.fillRect(W / 2 - 230, H / 2 - 70, 460, 140);
      g.fillStyle = '#fff'; g.font = '800 58px Helvetica, Arial'; g.textAlign = 'center';
      g.fillText('⚠ COMPROMISED', W / 2, H / 2 + 20); g.textAlign = 'left';
    }
    tex.needsUpdate = true;
  }
  const glow = new THREE.PointLight(0x6fb6ff, 0.9, 4); glow.position.set(0, 0.9, 0.6); root.add(glow);
  hinge.rotation.x = P.lid === 'opening' ? 1.4 : -0.22;
  return {
    root,
    update(t, T) {
      if (P.lid === 'opening') hinge.rotation.x = 1.4 - K.ease(K.seg(t, 0.1, 1.1)) * 1.62;
      const infected = P.state === 'infected' && t > Math.min(T * 0.45, 2.2);
      draw(t, infected);
      glow.color.set(infected ? 0xff3b3b : 0x6fb6ff);
      glow.intensity = infected ? 1.6 + 0.6 * Math.sin(t * 10) : 0.9;
    },
  };
}`,
};

const vault: PropDef = {
  id: "vault",
  description: "Round bank-vault door that unlocks and swings open, gold glowing inside — wallets, keys, 'the signing service', access granted.",
  params: { open: "true (default) = the door swings open during the beat", inside: "'gold' (default) | 'coins'" },
  code: String.raw`
function build(THREE, P, K) {
  const root = new THREE.Group();
  const steel = K.mat.metal('#a9adb4', 0.32);
  const dark = K.mat.metal('#6d727a', 0.4);
  // frame: a rounded square with a real round opening, so what's inside shows
  const shape = new THREE.Shape();
  const hw = 1.3, r = 0.14;
  shape.moveTo(-hw + r, -hw); shape.lineTo(hw - r, -hw); shape.quadraticCurveTo(hw, -hw, hw, -hw + r);
  shape.lineTo(hw, hw - r); shape.quadraticCurveTo(hw, hw, hw - r, hw); shape.lineTo(-hw + r, hw);
  shape.quadraticCurveTo(-hw, hw, -hw, hw - r); shape.lineTo(-hw, -hw + r); shape.quadraticCurveTo(-hw, -hw, -hw + r, -hw);
  const opening = new THREE.Path(); opening.absarc(0, 0, 0.98, 0, Math.PI * 2, true); shape.holes.push(opening);
  const frameGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, curveSegments: 48 });
  const frame = K.mesh(frameGeo, K.mat.satin('#2c3036'), true, true);
  frame.position.set(0, 1.3, -0.52); root.add(frame);
  const tunnel = K.mesh(new THREE.CylinderGeometry(0.98, 0.98, 0.5, 64, 1, true), new THREE.MeshStandardMaterial({ color: '#3a3f46', metalness: 0.6, roughness: 0.4, side: THREE.BackSide }));
  tunnel.rotation.x = Math.PI / 2; tunnel.position.set(0, 1.3, -0.27); root.add(tunnel);
  const back = K.mesh(new THREE.CircleGeometry(0.98, 64), K.mat.matte('#15171a'));
  back.position.set(0, 1.3, -0.5); root.add(back);
  // what's inside
  const inside = new THREE.Group(); inside.position.set(0, 1.3, -0.36); root.add(inside);
  const gold = K.mat.gold(0.3);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4 - (r % 2); c++) {
    const bar = K.mesh(K.roundedBox(0.36, 0.16, 0.22, 0.03), gold);
    bar.position.set(-0.6 + c * 0.4 + (r % 2) * 0.2, -0.5 + r * 0.18, 0); inside.add(bar);
  }
  const shine = new THREE.PointLight(0xffc860, 0, 3); shine.position.set(0.2, 1.5, 0.1); root.add(shine);
  // the door, hinged on its left edge
  const hinge = new THREE.Group(); hinge.position.set(-1.0, 1.3, 0.02); root.add(hinge);
  const door = new THREE.Group(); door.position.set(1.0, 0, 0); hinge.add(door);
  door.add(K.mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.34, 64), steel));
  door.children[0].rotation.x = Math.PI / 2;
  const ring = K.mesh(new THREE.TorusGeometry(0.82, 0.05, 16, 64), dark); ring.position.z = 0.18; door.add(ring);
  for (let i = 0; i < 10; i++) {
    const bolt = K.mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.08, 16), dark);
    const a = (i / 10) * Math.PI * 2; bolt.rotation.x = Math.PI / 2;
    bolt.position.set(Math.cos(a) * 0.9, Math.sin(a) * 0.9, 0.18); door.add(bolt);
  }
  const wheel = new THREE.Group(); wheel.position.z = 0.22; door.add(wheel);
  wheel.add(K.mesh(new THREE.TorusGeometry(0.34, 0.035, 12, 48), dark));
  for (let i = 0; i < 4; i++) {
    const spoke = K.mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.68, 12), dark);
    spoke.rotation.z = (i * Math.PI) / 4; wheel.add(spoke);
  }
  const hub = K.mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.08, 24), steel); hub.rotation.x = Math.PI / 2; wheel.add(hub);
  return {
    root,
    elevation: 8,
    update(t, T) {
      const unlock = K.easeInOut(K.seg(t, 0.2, 1.2));
      wheel.rotation.z = -unlock * Math.PI * 1.5;
      const swing = P.open === false ? 0 : K.ease(K.seg(t, 1.2, Math.min(T * 0.7, 2.8)));
      hinge.rotation.y = -swing * 1.6;
      shine.intensity = swing * 2.4;
    },
  };
}`,
};

export const PROPS: PropDef[] = [watch, watchStacks, coinPile, tuningFork, chip, gears, giftBox, barPair, laptop, vault];

export function getProp(id: string): PropDef {
  const p = PROPS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown prop "${id}" — library has: ${PROPS.map((x) => x.id).join(", ")}`);
  return p;
}
