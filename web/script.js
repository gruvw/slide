/* Slide: script

   1. Settings & helpers
   2. Backgrounds      one object per background: colors, scatter(), paint()
   3. Endless scroll   draws the background in canvas "chunks" as you scroll
   4. Background picker
   5. Panels
   6. Offline (PWA)

   How the backgrounds work
   The scroll is cut into chunks of CHUNK_HEIGHT pixels, each one a <canvas>.
   Every chunk has a number (its index). Things like clouds or stones are placed
   with a random generator seeded by that index, so each chunk looks different
   but always the same when you scroll back to it. A chunk also draws the things
   of its two neighbours, so shapes crossing a chunk border are never cut. */

"use strict";


/* 1. Settings & helpers
   ========================================================================== */

const STORAGE_KEY = "slide:background";
const DEFAULT_BACKGROUND = "leaves";

const CHUNK_HEIGHT = 1024;   // px of background per canvas
const CHUNK_OVERLAP = 2;     // px each canvas overlaps its neighbours (hides seams)
const BUFFER_CHUNKS = 1;     // chunks kept ready above and below the screen
const MAX_PIXEL_RATIO = 2;   // sharper than 2x costs memory for no visible gain
const RECENTER_MARGIN = 0.2; // recenter when within 20% of either end
const SCROLL_IDLE_MS = 200;
const PREVIEW_SCALE = 0.35;  // size of the picker previews vs. the real thing
const PREVIEW_INDEX = 7;     // which chunk the previews show

const TAU = Math.PI * 2;

/** Seeded random generator: same keys → same sequence of numbers in [0, 1). */
function seededRandom(...keys) {
  let seed = 2166136261;
  for (const char of keys.join(":")) {
    seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  }
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (random, min, max) => min + random() * (max - min);
const pick = (random, list) => list[Math.floor(random() * list.length)];
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

function rgba(hex, alpha = 1) {
  return `rgba(${hexToRgb(hex).join(",")},${alpha})`;
}

/** A value in [0, 1) for each integer n, spread by the golden ratio: never
    repeating, and always clearly different between neighbours n and n + 1. */
function goldenShade(n) {
  return (((n * 0.618034) % 1) + 1) % 1;
}

/** Mixes two [r, g, b] colors: t = 0 gives a, t = 1 gives b. */
function mixRgb(a, b, t) {
  return a.map((v, k) => Math.round(v + (b[k] - v) * t));
}

const rgbString = (rgb) => `rgb(${rgb.join(",")})`;

/** Color ([r, g, b]) at position t (any number, loops every 1) of a looping palette. */
function loopRgb(colors, t) {
  const x = (((t % 1) + 1) % 1) * colors.length;
  const i = Math.floor(x);
  return mixRgb(hexToRgb(colors[i]), hexToRgb(colors[(i + 1) % colors.length]), x - i);
}

const loopColor = (colors, t) => rgbString(loopRgb(colors, t));

/** Vertical gradient that flows through `colors`, one loop every `loopChunks` chunks. */
function paintSky(ctx, chunk, colors, loopChunks) {
  const gradient = ctx.createLinearGradient(0, 0, 0, chunk.height);
  const steps = 8;
  for (let s = 0; s <= steps; s++) {
    gradient.addColorStop(s / steps, loopColor(colors, (chunk.index + s / steps) / loopChunks));
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, -CHUNK_OVERLAP, chunk.width, chunk.height + 2 * CHUNK_OVERLAP);
}

/** Soft, blurry ellipse fading out to its edge. */
function softEllipse(ctx, x, y, rx, ry, color, alpha, angle = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(1, ry / rx);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  gradient.addColorStop(0, rgba(color, alpha));
  gradient.addColorStop(0.5, rgba(color, alpha * 0.55));
  gradient.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** Calls fn(n, y) for every horizontal line (spaced `spacing`) touching the chunk.
    n is the line's global number, so the same line looks the same in every chunk. */
function forEachLine(chunk, spacing, fn) {
  const first = Math.floor(chunk.top / spacing) - 1;
  const last = Math.ceil((chunk.top + chunk.height) / spacing) + 1;
  for (let n = first; n <= last; n++) fn(n, n * spacing - chunk.top);
}

/** Height at x of a horizontal line around y that wobbles with the given sine waves. */
function waveAt(x, y, waves) {
  return y + waves.reduce((sum, w) => sum + w.amp * Math.sin(TAU * x / w.len + w.phase), 0);
}

/** Traces such a wobbly line from x0 to x1. */
function traceWave(ctx, x0, x1, y, waves) {
  ctx.moveTo(x0, waveAt(x0, y, waves));
  for (let x = x0 + 6; x < x1; x += 6) ctx.lineTo(x, waveAt(x, y, waves));
  ctx.lineTo(x1, waveAt(x1, y, waves));
}

/** Closed, slightly irregular round shape (stones, puffs…). */
function traceBlob(ctx, x, y, r, shape) {
  const points = shape.map((k, i) => {
    const a = (i / shape.length) * TAU;
    return [x + Math.cos(a) * r * k, y + Math.sin(a) * r * k * 0.82];
  });
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  ctx.moveTo(...mid(points.at(-1), points[0]));
  points.forEach((p, i) => ctx.quadraticCurveTo(...p, ...mid(p, points[(i + 1) % points.length])));
  ctx.closePath();
}


/* 2. Backgrounds
   Each background has:
   - color      main color (status bar on phones, fallback while drawing)
   - scatter()  optional: the things placed in one chunk, at random spots
   - paint()    draws one chunk (its own things and its neighbours')

   To add one: add an entry here and a button with data-background="{name}"
   in index.html.
   ========================================================================== */

const BACKGROUNDS = {

  /* Dawn: a pastel sky with soft clouds, sometimes a sun or a few birds */
  dawn: {
    color: "#f7dccb",
    sky: ["#f7dccb", "#f4cdd3", "#e2d3ed", "#cadcf0", "#d4e9e2", "#f6e8cd"],

    scatter(random, width, height) {
      const items = [];
      if (random() < 0.3) {
        items.push({ type: "sun", x: between(random, 0.2, 0.8) * width, y: between(random, 150, height - 150), r: between(random, 30, 50) });
      }
      const clouds = 3 + Math.floor(random() * 3);
      for (let i = 0; i < clouds; i++) {
        const size = between(random, 55, 115);
        const puffs = Array.from({ length: 6 + Math.floor(random() * 5) }, () => ({
          dx: between(random, -1.5, 1.5) * size,
          dy: between(random, -0.35, 0.2) * size,
          r: between(random, 0.45, 0.9) * size,
        }));
        // one cloud per slice of the chunk, at a random spot within it, so they never all bunch up
        const y = ((i + random()) / clouds) * height;
        items.push({ type: "cloud", x: random() * width, y, puffs, alpha: between(random, 0.45, 0.7) });
      }
      if (random() < 0.3) {
        const birds = Array.from({ length: 2 + Math.floor(random() * 3) }, () => ({
          dx: between(random, -40, 40), dy: between(random, -20, 20), size: between(random, 4, 7), lift: between(random, 0.3, 0.7),
        }));
        items.push({ type: "birds", x: between(random, 0.15, 0.85) * width, y: random() * height, birds });
      }
      return items;
    },

    paint(ctx, chunk) {
      paintSky(ctx, chunk, this.sky, 4);
      for (const item of chunk.items) {
        if (item.type === "sun") {
          softEllipse(ctx, item.x, item.y, item.r * 5, item.r * 5, "#fff2da", 0.55);
          const disc = ctx.createRadialGradient(item.x, item.y, 0, item.x, item.y, item.r);
          disc.addColorStop(0, "rgba(255,251,242,1)");
          disc.addColorStop(0.85, "rgba(255,247,232,0.95)");
          disc.addColorStop(1, "rgba(255,247,232,0)");
          ctx.fillStyle = disc;
          ctx.beginPath();
          ctx.arc(item.x, item.y, item.r, 0, TAU);
          ctx.fill();
        } else if (item.type === "cloud") {
          for (const puff of item.puffs) {
            softEllipse(ctx, item.x + puff.dx, item.y + puff.dy, puff.r * 1.6, puff.r * 0.75, "#ffffff", item.alpha);
          }
        } else if (item.type === "birds") {
          ctx.strokeStyle = rgba("#5d4e63", 0.4);
          ctx.lineWidth = 1.3;
          ctx.lineCap = "round";
          for (const b of item.birds) {
            const x = item.x + b.dx;
            const y = item.y + b.dy;
            ctx.beginPath();
            ctx.moveTo(x - b.size, y - b.size * b.lift);
            ctx.quadraticCurveTo(x - b.size * 0.4, y - b.size * 0.55, x, y);
            ctx.quadraticCurveTo(x + b.size * 0.4, y - b.size * 0.55, x + b.size, y - b.size * b.lift);
            ctx.stroke();
          }
        }
      }
    },
  },

  /* Tide: calm water seen from above: slow swells, ripple lines, sparkles,
     rings where a drop just fell, and now and then a little paper boat */
  tide: {
    color: "#d3e8ec",
    sky: ["#d6eaee", "#cce3e9", "#d1e6e8", "#d9ecec"],
    deep: "#7fb0bf",

    scatter(random, width, height) {
      const items = [];
      if (random() < 0.35) {
        items.push({ type: "boat", x: between(random, 0.15, 0.85) * width, y: between(random, 120, height - 60), size: between(random, 1.4, 1.8), flip: random() < 0.5 ? -1 : 1 });
      }
      const rings = Math.floor(random() * 3);
      for (let i = 0; i < rings; i++) {
        items.push({ type: "rings", x: random() * width, y: random() * height, r: between(random, 10, 20) });
      }
      const sparkles = 6 + Math.floor(random() * 7);
      for (let i = 0; i < sparkles; i++) {
        items.push({ type: "sparkle", x: random() * width, y: random() * height, r: between(random, 2.5, 5.5), alpha: between(random, 0.5, 0.95) });
      }
      return items;
    },

    paint(ctx, chunk) {
      // Broad swells: wavy bands, each a shade deeper or lighter than its neighbours
      const spacing = 120;
      const depth = spacing * 2.5;
      const first = Math.floor((chunk.top - depth) / spacing);
      const last = Math.ceil((chunk.top + chunk.height + spacing) / spacing);
      for (let n = first; n <= last; n++) {
        const random = seededRandom("tide-swell", n);
        const y = n * spacing - chunk.top;
        const waves = [
          { amp: between(random, 10, 22), len: between(random, 320, 620), phase: random() * TAU },
          { amp: between(random, 2, 5), len: between(random, 110, 180), phase: random() * TAU },
        ];
        const base = loopRgb(this.sky, (n * spacing) / (CHUNK_HEIGHT * 6));
        ctx.fillStyle = rgbString(mixRgb(base, hexToRgb(this.deep), goldenShade(n) * 0.18));
        ctx.beginPath();
        traceWave(ctx, 0, chunk.width, y, waves);
        ctx.lineTo(chunk.width, y + depth);
        ctx.lineTo(0, y + depth);
        ctx.closePath();
        ctx.fill();
      }

      // Ripple lines
      ctx.lineCap = "round";
      forEachLine(chunk, 22, (n, y) => {
        const random = seededRandom("tide", n);
        const waves = [
          { amp: between(random, 2, 6), len: between(random, 180, 340), phase: random() * TAU },
          { amp: between(random, 0.5, 1.8), len: between(random, 45, 90), phase: random() * TAU },
        ];
        ctx.strokeStyle = rgba("#ffffff", between(random, 0.3, 0.65));
        ctx.lineWidth = between(random, 1, 2);
        ctx.beginPath();
        for (let x = -random() * 150; x < chunk.width; ) {
          const length = between(random, 50, 220);
          if (random() < 0.7) traceWave(ctx, x, x + length, y, waves);
          x += length + between(random, 20, 90);
        }
        ctx.stroke();
      });

      for (const item of chunk.items) {
        if (item.type === "sparkle") {
          const { x, y, r } = item;
          ctx.fillStyle = rgba("#ffffff", item.alpha);
          ctx.beginPath();
          ctx.moveTo(x, y - r);
          ctx.quadraticCurveTo(x, y, x + r, y);
          ctx.quadraticCurveTo(x, y, x, y + r);
          ctx.quadraticCurveTo(x, y, x - r, y);
          ctx.quadraticCurveTo(x, y, x, y - r);
          ctx.fill();
        } else if (item.type === "rings") {
          ctx.lineWidth = 1.3;
          for (let k = 0; k < 3; k++) {
            const rx = item.r * (1 + k * 0.75);
            ctx.strokeStyle = rgba("#ffffff", 0.6 - k * 0.17);
            ctx.beginPath();
            ctx.ellipse(item.x, item.y, rx, rx * 0.42, 0, 0, TAU);
            ctx.stroke();
          }
        } else if (item.type === "boat") {
          paintBoat(ctx, item);
        }
      }
    },
  },

  /* Sand: a zen garden, raked lines flowing around groups of stones */
  sand: {
    color: "#ede4d2",
    sky: ["#efe6d4", "#eadfca", "#eee4cf", "#e8ddc8"],

    scatter(random, width, height) {
      const islands = [];
      const count = random() < 0.2 ? 0 : random() < 0.6 ? 1 : 2;
      for (let i = 0; i < count; i++) {
        for (let attempt = 0; attempt < 12; attempt++) {
          const island = makeIsland(random, width, height);
          const fits = islands.every((o) => Math.hypot(o.x - island.x, o.y - island.y) > o.radius + island.radius + 24);
          if (fits) {
            islands.push(island);
            break;
          }
        }
      }
      return islands;
    },

    paint(ctx, chunk) {
      paintSky(ctx, chunk, this.sky, 3);

      // Raked lines everywhere except inside the islands
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, -CHUNK_OVERLAP, chunk.width, chunk.height + 2 * CHUNK_OVERLAP);
      for (const island of chunk.items) {
        ctx.moveTo(island.x + island.radius, island.y);
        ctx.arc(island.x, island.y, island.radius, 0, TAU);
      }
      ctx.clip("evenodd");
      forEachLine(chunk, 14, (n, y) => {
        const random = seededRandom("sand", n);
        const waves = [{ amp: between(random, 1, 2.5), len: between(random, 260, 480), phase: random() * TAU }];
        rakeGroove(ctx, (offset) => traceWave(ctx, 0, chunk.width, y + offset, waves));
      });
      ctx.restore();

      for (const island of chunk.items) {
        for (let k = 0; k < island.rings; k++) {
          const r = island.core + 14 + k * 13;
          rakeGroove(ctx, (offset) => ctx.arc(island.x, island.y, r + offset, 0, TAU));
        }
        for (const stone of island.stones) paintStone(ctx, island.x + stone.dx, island.y + stone.dy, stone);
      }
    },
  },

  /* Night: a deep sky with stars, faint nebulae and a rare shooting star */
  night: {
    color: "#141a2c",
    sky: ["#141a2c", "#1b2441", "#221f3e", "#152739"],

    scatter(random, width, height) {
      const items = [];
      const nebulae = Math.floor(random() * 3);
      for (let i = 0; i < nebulae; i++) {
        items.push({
          type: "nebula", x: random() * width, y: random() * height,
          r: between(random, 160, 320), stretch: between(random, 0.35, 0.7), angle: random() * Math.PI,
          color: pick(random, ["#5a4a8c", "#2e5f80", "#6d4a7c", "#3d5a8f"]), alpha: between(random, 0.12, 0.22),
        });
      }
      const stars = Math.round((width * height) / 2600);
      for (let i = 0; i < stars; i++) {
        const p = random();
        items.push({
          type: "star", x: random() * width, y: random() * height,
          r: p < 0.78 ? between(random, 0.4, 0.9) : p < 0.96 ? between(random, 1, 1.5) : between(random, 1.6, 2.2),
          alpha: between(random, 0.35, 0.95), color: pick(random, ["#ffffff", "#fff2d9", "#dde7ff"]),
        });
      }
      if (random() < 0.12) {
        items.push({ type: "meteor", x: random() * width, y: random() * height, length: between(random, 70, 140), angle: between(random, 0.15, 0.3) * Math.PI });
      }
      return items;
    },

    paint(ctx, chunk) {
      paintSky(ctx, chunk, this.sky, 4);
      for (const item of chunk.items) {
        if (item.type === "nebula") {
          softEllipse(ctx, item.x, item.y, item.r, item.r * item.stretch, item.color, item.alpha, item.angle);
        } else if (item.type === "star") {
          if (item.r > 1.5) {
            softEllipse(ctx, item.x, item.y, item.r * 7, item.r * 7, "#dfe8ff", item.alpha * 0.3);
            ctx.strokeStyle = rgba("#ffffff", item.alpha * 0.4);
            ctx.lineWidth = 0.6;
            ctx.beginPath();
            ctx.moveTo(item.x - item.r * 5, item.y);
            ctx.lineTo(item.x + item.r * 5, item.y);
            ctx.moveTo(item.x, item.y - item.r * 5);
            ctx.lineTo(item.x, item.y + item.r * 5);
            ctx.stroke();
          }
          ctx.fillStyle = rgba(item.color, item.alpha);
          ctx.beginPath();
          ctx.arc(item.x, item.y, item.r, 0, TAU);
          ctx.fill();
        } else if (item.type === "meteor") {
          const tailX = item.x - Math.cos(item.angle) * item.length;
          const tailY = item.y - Math.sin(item.angle) * item.length;
          const trail = ctx.createLinearGradient(tailX, tailY, item.x, item.y);
          trail.addColorStop(0, "rgba(255,255,255,0)");
          trail.addColorStop(1, "rgba(255,255,255,0.75)");
          ctx.strokeStyle = trail;
          ctx.lineWidth = 1.4;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(tailX, tailY);
          ctx.lineTo(item.x, item.y);
          ctx.stroke();
        }
      }
    },
  },

  /* Glow: soft, flat rounded shapes in the spirit of Material 3 Expressive
     (scalloped cookies, clovers, flowers, sunbursts, pills, circles), each one
     a single solid shape with a gentle glow behind it, plus a few tiny dots */
  glow: {
    color: "#fbf2ea",
    sky: ["#fbf2ea", "#f9edf1", "#f3effa", "#eef6f2", "#fbf2e6"],
    tones: ["#f6b9cf", "#cbbcfb", "#acd9bd", "#ffc5a1", "#a8cdf3", "#fbd98a"],
    shapes: [
      { kind: "round", lobes: 4, depth: 0.12, pinch: 1.5 },  // 4-sided cookie
      { kind: "round", lobes: 6, depth: 0.1, pinch: 1.5 },   // 6-sided cookie
      { kind: "round", lobes: 9, depth: 0.08, pinch: 1.5 },  // 9-sided cookie
      { kind: "round", lobes: 12, depth: 0.07, pinch: 1.5 }, // soft burst
      { kind: "round", lobes: 4, depth: 0.32, pinch: 2 },    // clover
      { kind: "round", lobes: 8, depth: 0.2, pinch: 1.5 },   // flower
      { kind: "round", lobes: 0, depth: 0, pinch: 1 },     // circle
      { kind: "pill" },
    ],

    scatter(random, width, height) {
      const items = [];
      const count = 8 + Math.floor(random() * 4);
      for (let i = 0; i < count; i++) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const r = between(random, 16, 42);
          const item = {
            type: "shape", ...pick(random, this.shapes), r, turn: random() * TAU,
            x: between(random, r, width - r), y: ((i + random()) / count) * height, // one per slice: evenly spread
            color: pick(random, this.tones),
          };
          if (items.every((o) => Math.hypot(o.x - item.x, o.y - item.y) > (o.r + item.r) * 1.6)) {
            items.push(item);
            break;
          }
        }
      }
      for (let i = 0, n = 10 + Math.floor(random() * 8); i < n; i++) {
        items.push({ type: "dot", x: random() * width, y: random() * height, r: between(random, 2, 4), color: pick(random, this.tones) });
      }
      return items;
    },

    paint(ctx, chunk) {
      paintSky(ctx, chunk, this.sky, 3);
      // the little dots first, so they always sit behind the shapes
      for (const item of chunk.items) {
        if (item.type !== "dot") continue;
        ctx.fillStyle = item.color;
        ctx.beginPath();
        ctx.arc(item.x, item.y, item.r, 0, TAU);
        ctx.fill();
      }
      for (const item of chunk.items) {
        if (item.type === "dot") continue;
        softEllipse(ctx, item.x, item.y, item.r * 2, item.r * 2, item.color, 0.3);
        ctx.fillStyle = item.color;
        ctx.beginPath();
        if (item.kind === "pill") {
          ctx.save();
          ctx.translate(item.x, item.y);
          ctx.rotate(item.turn);
          ctx.roundRect(-item.r, -item.r * 0.5, item.r * 2, item.r, item.r * 0.5);
          ctx.restore();
        } else {
          traceRoundShape(ctx, item.x, item.y, item.r, item, item.turn);
        }
        ctx.fill();
      }
    },
  },

  /* Petals: cherry blossom petals drifting by in loose clusters, now and then
     a whole flower, and sometimes a blossoming branch reaching in from the side */
  petals: {
    color: "#faf1ee",
    sky: ["#faf1ee", "#f8ebe8", "#f6eef0", "#f9efe9"],

    scatter(random, width, height) {
      const items = [];
      if (random() < 0.4) items.push(makeBranch(random, width, height));
      for (let i = 0; i < 2; i++) {
        items.push({ type: "blush", x: random() * width, y: random() * height, r: between(random, 120, 220) });
      }
      const petal = (x, y) => ({
        type: "petal", x, y, size: between(random, 0.8, 1.5),
        angle: random() * TAU, flip: random() < 0.5 ? -1 : 1, tilt: between(random, 0.55, 1),
        tone: Math.floor(random() * PETAL_TONES.length), alpha: between(random, 0.75, 1),
      });
      // loose clusters, as if a gust just carried them
      for (let c = 0, clusters = 3 + Math.floor(random() * 3); c < clusters; c++) {
        const cx = random() * width;
        const cy = random() * height;
        for (let i = 0, n = 3 + Math.floor(random() * 4); i < n; i++) {
          items.push(petal(cx + between(random, -50, 50), cy + between(random, -60, 60)));
        }
      }
      // and some on their own
      for (let i = 0, n = 8 + Math.floor(random() * 6); i < n; i++) {
        items.push(petal(random() * width, random() * height));
      }
      if (random() < 0.5) {
        items.push({ type: "flower", x: random() * width, y: random() * height, size: between(random, 1.2, 1.7), angle: random() * TAU });
      }
      return items;
    },

    paint(ctx, chunk) {
      paintSky(ctx, chunk, this.sky, 3);
      for (const item of chunk.items) {
        if (item.type === "blush") {
          softEllipse(ctx, item.x, item.y, item.r, item.r * 0.8, "#f6d3db", 0.35);
        } else if (item.type === "branch") {
          paintBranch(ctx, item);
        } else if (item.type === "petal") {
          ctx.save();
          ctx.translate(item.x, item.y);
          ctx.rotate(item.angle);
          ctx.scale(item.size * item.flip, item.size * item.tilt);
          ctx.globalAlpha = item.alpha;
          paintPetal(ctx, PETAL_TONES[item.tone]);
          ctx.restore();
        } else if (item.type === "flower") {
          paintFlower(ctx, item.x, item.y, item.size, item.angle);
        }
      }
    },
  },

  /* Hills: crisp layered ridges at dusk, with little pine trees on some of them */
  hills: {
    color: "#bfc6dc",
    bands: ["#c9d0e4", "#c6c2df", "#bfcde1", "#d0cbe0"], // slow drift of similar brightness
    shadow: "#26355c",

    paint(ctx, chunk) {
      const spacing = 46;
      const depth = spacing * 3; // how far below its ridge each band is filled
      const first = Math.floor((chunk.top - depth) / spacing);
      const last = Math.ceil((chunk.top + chunk.height + spacing) / spacing);

      for (let n = first; n <= last; n++) {
        const random = seededRandom("hills", n);
        const y = n * spacing - chunk.top;
        const waves = [
          { amp: between(random, 8, 18), len: between(random, 300, 600), phase: random() * TAU },
          { amp: between(random, 2, 6), len: between(random, 90, 160), phase: random() * TAU },
        ];
        // Each ridge gets a little shade, spread by the golden ratio so neighbours
        // always differ a bit but the overall brightness never swings far.
        const shade = goldenShade(n);
        const base = loopRgb(this.bands, n / 120);
        ctx.fillStyle = rgbString(mixRgb(base, hexToRgb(this.shadow), 0.06 + shade * 0.3));

        ctx.beginPath();
        traceWave(ctx, 0, chunk.width, y, waves);
        ctx.lineTo(chunk.width, y + depth);
        ctx.lineTo(0, y + depth);
        ctx.closePath();
        ctx.fill();

        if (random() < 0.4) {
          let x = random() * chunk.width;
          const trees = 3 + Math.floor(random() * 5);
          ctx.beginPath();
          for (let t = 0; t < trees; t++) {
            const height = between(random, 8, 18);
            const base = waveAt(x, y, waves) + 3;
            ctx.moveTo(x - height * 0.28, base);
            ctx.lineTo(x, base - height);
            ctx.lineTo(x + height * 0.28, base);
            x += between(random, 6, 14);
          }
          ctx.fill();
        }
      }
    },
  },

  /* Leaves: flat, paper-cut leaves and ginkgo fans scattered on warm paper */
  leaves: {
    color: "#f5f0e6",
    sky: ["#f6f1e6", "#f2ece0", "#f4efe7", "#f1ebdd"],

    scatter(random, width, height) {
      // big pale paper shapes in the back
      const patches = Array.from({ length: 2 + Math.floor(random() * 2) }, () => ({
        type: "patch", x: random() * width, y: random() * height, r: between(random, 90, 170),
        shape: blobShape(random), color: pick(random, ["#ece3cf", "#e6e8d8", "#f1dfd2", "#e2e8df", "#efe6c9"]),
      }));
      // tiny seeds
      const seeds = Array.from({ length: 18 + Math.floor(random() * 12) }, () => ({
        type: "seed", x: random() * width, y: random() * height, r: between(random, 1.2, 2.4),
        color: pick(random, ["#d3c29f", "#c9b48d", "#bfc6a6"]),
      }));
      const items = [];
      const count = Math.round((width * height) / 12000);
      for (let i = 0; i < count; i++) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const ginkgo = random() < 0.3;
          const item = {
            type: ginkgo ? "ginkgo" : "leaf", x: random() * width, y: random() * height,
            size: between(random, 12, 22) * (ginkgo ? 1.3 : 1), angle: random() * TAU,
            color: ginkgo ? pick(random, ["#e2c27a", "#d9ac5e", "#ecd08e"]) : pick(random, LEAF_COLORS),
          };
          // keep leaves from piling on top of each other
          if (items.every((o) => Math.hypot(o.x - item.x, o.y - item.y) > (o.size + item.size) * 1.3)) {
            items.push(item);
            break;
          }
        }
      }
      return [...patches, ...seeds, ...items];
    },

    paint(ctx, chunk) {
      paintSky(ctx, chunk, this.sky, 3);
      for (const item of chunk.items) {
        if (item.type === "patch") {
          ctx.fillStyle = "rgba(120,95,60,0.05)";
          ctx.beginPath();
          traceBlob(ctx, item.x + 4, item.y + 4, item.r, item.shape);
          ctx.fill();
          ctx.fillStyle = item.color;
          ctx.beginPath();
          traceBlob(ctx, item.x, item.y, item.r, item.shape);
          ctx.fill();
          continue;
        }
        if (item.type === "seed") {
          ctx.fillStyle = item.color;
          ctx.beginPath();
          ctx.ellipse(item.x, item.y, item.r, item.r * 0.6, item.x % Math.PI, 0, TAU);
          ctx.fill();
          continue;
        }
        ctx.save();
        ctx.translate(item.x, item.y);
        ctx.rotate(item.angle);
        ctx.scale(item.size, item.size);
        ctx.lineWidth = 1.2 / item.size;
        ctx.lineCap = "round";
        const shape = item.type === "ginkgo" ? GINKGO_SHAPE : LEAF_SHAPE;

        // a crisp offset shadow, like a paper cut-out
        ctx.save();
        ctx.translate(0.12, 0.12);
        ctx.fillStyle = "rgba(90,70,40,0.1)";
        ctx.fill(shape);
        ctx.restore();

        ctx.fillStyle = item.color;
        ctx.fill(shape);
        ctx.strokeStyle = "rgba(255,255,255,0.45)";
        ctx.beginPath();
        if (item.type === "ginkgo") {
          for (let k = -2; k <= 2; k++) {
            const a = -Math.PI / 2 + k * 0.3;
            ctx.moveTo(0, -0.05);
            ctx.lineTo(Math.cos(a) * 0.85, Math.sin(a) * 0.85);
          }
        } else {
          ctx.moveTo(0, -0.85);
          ctx.lineTo(0, 1);
          for (const t of [-0.45, -0.1, 0.25, 0.6]) {
            ctx.moveTo(0, t);
            ctx.lineTo(-0.38, t - 0.28);
            ctx.moveTo(0, t);
            ctx.lineTo(0.38, t - 0.28);
          }
        }
        ctx.stroke();

        ctx.strokeStyle = item.color;
        ctx.lineWidth = 1.6 / item.size;
        ctx.beginPath();
        ctx.moveTo(0, item.type === "ginkgo" ? 0 : 1);
        ctx.lineTo(0, item.type === "ginkgo" ? 0.6 : 1.35);
        ctx.stroke();
        ctx.restore();
      }
    },
  },
};

/* Helpers used by the backgrounds above */

/** A puffy rounded shape of radius r with `lobes` full bumps. Between bumps the
    outline dips inward by `depth` (a fraction of r); a higher `pinch` makes the
    dips narrower, so the bumps stay round and full.
    0 lobes = circle; many shallow dips = cookie; few deep dips = clover. */
function traceRoundShape(ctx, x, y, r, { lobes, depth, pinch }, turn) {
  const steps = 160;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * TAU;
    const radius = r * (1 - depth * Math.abs(Math.sin((lobes * a) / 2)) ** (2 * pinch));
    const px = x + Math.cos(a + turn) * radius;
    const py = y + Math.sin(a + turn) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** A small folded paper boat floating on the water (y is the waterline). */
function paintBoat(ctx, { x, y, size, flip }) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size * flip, size);
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(-15, 4);
  ctx.lineTo(13, 4);
  ctx.moveTo(-8, 8);
  ctx.lineTo(7, 8);
  ctx.stroke();
  ctx.fillStyle = "rgba(60,110,130,0.18)";
  ctx.beginPath();
  ctx.moveTo(-13, 1);
  ctx.lineTo(13, 1);
  ctx.lineTo(9, 5);
  ctx.lineTo(-9, 5);
  ctx.fill();
  ctx.fillStyle = "#fbfdfd";
  ctx.beginPath();
  ctx.moveTo(-15, -6);
  ctx.lineTo(15, -6);
  ctx.lineTo(10, 1);
  ctx.lineTo(-10, 1);
  ctx.fill();
  ctx.fillStyle = "#f3f7f8";
  ctx.beginPath();
  ctx.moveTo(-7, -6);
  ctx.lineTo(0, -21);
  ctx.lineTo(7, -6);
  ctx.fill();
  ctx.fillStyle = "#dde9ec";
  ctx.beginPath();
  ctx.moveTo(0, -21);
  ctx.lineTo(7, -6);
  ctx.lineTo(0, -6);
  ctx.fill();
  ctx.fillStyle = "#e6eff1";
  ctx.beginPath();
  ctx.moveTo(-15, -6);
  ctx.lineTo(-10, 1);
  ctx.lineTo(-6, -6);
  ctx.fill();
  ctx.restore();
}

const LEAF_COLORS = ["#9caf88", "#7f9a6e", "#b7c29a", "#d6a85c", "#c9805a", "#e2c27a"];
const LEAF_SHAPE = new Path2D("M0 -1C0.6 -0.55 0.55 0.55 0 1C-0.55 0.55 -0.6 -0.55 0 -1Z");
const GINKGO_SHAPE = new Path2D(
  "M0 0Q-0.35 -0.3 -0.9 -0.72Q-0.6 -1.15 -0.08 -1.05L0 -0.84L0.08 -1.05Q0.6 -1.15 0.9 -0.72Q0.35 -0.3 0 0Z",
);

function makeIsland(random, width, height) {
  const r = between(random, 20, 34);
  const stones = [{ dx: 0, dy: 0, r, shape: blobShape(random), moss: random() < 0.6 }];
  const extra = Math.floor(random() * 3);
  for (let i = 0; i < extra; i++) {
    const small = r * between(random, 0.4, 0.65);
    const a = random() * TAU;
    const d = r + small + between(random, 3, 10);
    stones.push({ dx: Math.cos(a) * d, dy: Math.sin(a) * d * 0.8, r: small, shape: blobShape(random), moss: false });
  }
  const core = Math.max(...stones.map((s) => Math.hypot(s.dx, s.dy) + s.r));
  const rings = 3 + Math.floor(random() * 3);
  const radius = core + 14 + (rings - 1) * 13 + 7;
  return {
    x: width > 2 * radius ? between(random, radius * 0.6, width - radius * 0.6) : width / 2,
    y: between(random, radius + 4, height - radius - 4),
    stones, core, rings, radius,
  };
}

function blobShape(random) {
  return Array.from({ length: 10 }, () => between(random, 0.84, 1.08));
}

/** A raked groove: a darker line with a light edge just below it. */
function rakeGroove(ctx, trace) {
  ctx.lineWidth = 2;
  ctx.strokeStyle = rgba("#c8b897", 0.75);
  ctx.beginPath();
  trace(0);
  ctx.stroke();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = rgba("#fbf6ec", 0.8);
  ctx.beginPath();
  trace(1.6);
  ctx.stroke();
}

function paintStone(ctx, x, y, stone) {
  const { r } = stone;
  softEllipse(ctx, x + 3, y + r * 0.55, r * 1.3, r * 0.55, "#a8977a", 0.45);
  const body = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r * 1.3);
  body.addColorStop(0, "#bdb8ac");
  body.addColorStop(1, "#86817a");
  ctx.fillStyle = body;
  ctx.beginPath();
  traceBlob(ctx, x, y, r, stone.shape);
  ctx.fill();
  softEllipse(ctx, x - r * 0.3, y - r * 0.4, r * 0.45, r * 0.18, "#ffffff", 0.3);
  if (stone.moss) {
    softEllipse(ctx, x - r * 0.45, y + r * 0.45, r * 0.5, r * 0.28, "#8da078", 0.9);
    softEllipse(ctx, x - r * 0.15, y + r * 0.58, r * 0.35, r * 0.2, "#a3b68c", 0.8);
  }
}

const PETAL_SHAPE = new Path2D(
  "M0 -6L-2.2 -10.5C-6 -11 -9 -6 -8 -1C-7 5 -2 10 0 12C2 10 7 5 8 -1C9 -6 6 -11 2.2 -10.5Z",
);
const PETAL_TONES = [["#fff0f2", "#f4c4cb"], ["#fde6e9", "#efb3bd"], ["#fbd9de", "#e89fac"]];

function paintPetal(ctx, [light, deep]) {
  const fill = ctx.createLinearGradient(0, -11, 0, 12);
  fill.addColorStop(0, light);
  fill.addColorStop(1, deep);
  ctx.fillStyle = fill;
  ctx.fill(PETAL_SHAPE);
  // a soft crease down the middle
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 0.7;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0, -5);
  ctx.quadraticCurveTo(0.8, 2, 0, 8);
  ctx.stroke();
}

/** A five-petal cherry blossom centered on (x, y). */
function paintFlower(ctx, x, y, size, angle) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(size, size);
  for (let k = 0; k < 5; k++) {
    ctx.save();
    ctx.rotate((k / 5) * TAU);
    ctx.translate(0, -12);
    paintPetal(ctx, PETAL_TONES[0]);
    ctx.restore();
  }
  ctx.fillStyle = "#e7a1ae";
  ctx.beginPath();
  ctx.arc(0, 0, 3.5, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#d98293";
  for (let k = 0; k < 8; k++) {
    ctx.beginPath();
    ctx.arc(Math.cos((k / 8) * TAU) * 6, Math.sin((k / 8) * TAU) * 6, 1.1, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/** A blossoming branch growing in from the left or right edge. */
function makeBranch(random, width, height) {
  const fromLeft = random() < 0.5;
  const dir = fromLeft ? 1 : -1;
  const start = { x: fromLeft ? -10 : width + 10, y: between(random, 160, height - 160) };
  const reach = between(random, 0.4, 0.6) * width;
  const rise = between(random, -90, 90);
  const end = { x: start.x + dir * reach, y: start.y + rise };
  const bend = { x: start.x + dir * reach * 0.5, y: start.y + rise * 0.5 + between(random, -60, 60) };
  const along = (t) => ({
    x: (1 - t) ** 2 * start.x + 2 * (1 - t) * t * bend.x + t * t * end.x,
    y: (1 - t) ** 2 * start.y + 2 * (1 - t) * t * bend.y + t * t * end.y,
  });
  const twigs = Array.from({ length: 2 + Math.floor(random() * 2) }, () => {
    const from = along(between(random, 0.3, 0.8));
    const a = (fromLeft ? 0 : Math.PI) + dir * between(random, -1.1, 1.1) + (random() < 0.5 ? -0.6 : 0.6);
    const length = between(random, 30, 60);
    return { from, to: { x: from.x + Math.cos(a) * length, y: from.y + Math.sin(a) * length } };
  });
  const flowers = [end, ...twigs.map((t) => t.to)].map((p) => ({ ...p, size: between(random, 0.9, 1.3), angle: random() * TAU }));
  const buds = Array.from({ length: 2 + Math.floor(random() * 3) }, () => {
    const p = along(between(random, 0.35, 0.95));
    return { x: p.x + between(random, -8, 8), y: p.y + between(random, -8, 8), angle: random() * TAU };
  });
  return { type: "branch", y: start.y, start, bend, end, twigs, flowers, buds, along };
}

function paintBranch(ctx, branch) {
  // positions were made relative to the chunk the branch belongs to; shift by
  // the same offset the renderer applied to branch.y
  const dy = branch.y - branch.start.y;
  ctx.save();
  ctx.translate(0, dy);
  ctx.strokeStyle = "#6e5450";
  ctx.lineCap = "round";
  const steps = 16;
  for (let i = 0; i < steps; i++) {
    const a = branch.along(i / steps);
    const b = branch.along((i + 1) / steps);
    ctx.lineWidth = 7 - (5 * i) / steps;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.lineWidth = 2;
  for (const twig of branch.twigs) {
    ctx.beginPath();
    ctx.moveTo(twig.from.x, twig.from.y);
    ctx.lineTo(twig.to.x, twig.to.y);
    ctx.stroke();
  }
  for (const bud of branch.buds) {
    ctx.save();
    ctx.translate(bud.x, bud.y);
    ctx.rotate(bud.angle);
    ctx.fillStyle = "#8a9a6a";
    ctx.beginPath();
    ctx.ellipse(0, 3, 2.2, 2.6, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "#eea3b2";
    ctx.beginPath();
    ctx.ellipse(0, -1, 3, 4.5, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
  for (const f of branch.flowers) paintFlower(ctx, f.x, f.y, f.size, f.angle);
  ctx.restore();
}


/* 3. Endless scroll
   The track is very tall. Only the chunks near the screen exist as canvases.
   When the user stops scrolling near an end, we jump back toward the middle
   by whole chunks and shift the chunk numbering by the same amount, so what
   is on screen stays exactly the same. */

const scroller = document.getElementById("scroller");
const track = document.getElementById("track");

const chunks = new Map(); // chunk index → canvas
// Index of the chunk at the very top of the track. It starts at a random value
// so every visit begins at a different spot of the endless background.
let indexOffset = Math.floor(Math.random() * 1000000);
let backgroundName = DEFAULT_BACKGROUND;

function pixelRatio() {
  return Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
}

/** Draws chunk `index` of a background, in chunk coordinates (0 = chunk top). */
function paintChunk(ctx, name, index, width) {
  const background = BACKGROUNDS[name];
  const chunk = { index, width, height: CHUNK_HEIGHT, top: index * CHUNK_HEIGHT, items: [] };
  if (background.scatter) {
    for (const d of [-1, 0, 1]) {
      const random = seededRandom(name, index + d);
      for (const item of background.scatter(random, width, CHUNK_HEIGHT)) {
        chunk.items.push({ ...item, y: item.y + d * CHUNK_HEIGHT });
      }
    }
  }
  background.paint(ctx, chunk);
}

function createChunk(index) {
  const width = scroller.clientWidth;
  const ratio = pixelRatio();
  const canvas = document.createElement("canvas");
  canvas.className = "chunk";
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round((CHUNK_HEIGHT + 2 * CHUNK_OVERLAP) * ratio);
  canvas.style.height = `${CHUNK_HEIGHT + 2 * CHUNK_OVERLAP}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  ctx.translate(0, CHUNK_OVERLAP);
  paintChunk(ctx, backgroundName, index, width);
  return canvas;
}

function placeChunk(index, canvas) {
  canvas.style.top = `${(index - indexOffset) * CHUNK_HEIGHT - CHUNK_OVERLAP}px`;
}

/** Creates the chunks around the screen and removes the far away ones. */
function updateChunks() {
  const top = scroller.scrollTop;
  const first = Math.floor(top / CHUNK_HEIGHT) - BUFFER_CHUNKS + indexOffset;
  const last = Math.floor((top + scroller.clientHeight) / CHUNK_HEIGHT) + BUFFER_CHUNKS + indexOffset;

  for (const [index, canvas] of chunks) {
    if (index < first || index > last) {
      canvas.remove();
      chunks.delete(index);
    }
  }
  for (let index = first; index <= last; index++) {
    if (chunks.has(index)) continue;
    const canvas = createChunk(index);
    placeChunk(index, canvas);
    track.append(canvas);
    chunks.set(index, canvas);
  }
}

function redrawChunks() {
  for (const canvas of chunks.values()) canvas.remove();
  chunks.clear();
  updateChunks();
}

function maxScroll() {
  return scroller.scrollHeight - scroller.clientHeight;
}

function recenterIfNeeded() {
  const max = maxScroll();
  const top = scroller.scrollTop;
  const margin = max * RECENTER_MARGIN;
  if (top > margin && top < max - margin) return;

  const shift = Math.round((max / 2 - top) / CHUNK_HEIGHT);
  indexOffset -= shift;
  for (const [index, canvas] of chunks) placeChunk(index, canvas);
  scroller.scrollTop = top + shift * CHUNK_HEIGHT;
  updateChunks();
}

let frameRequested = false;
let idleTimer;
scroller.addEventListener("scroll", () => {
  if (!frameRequested) {
    frameRequested = true;
    requestAnimationFrame(() => {
      frameRequested = false;
      updateChunks();
    });
  }
  clearTimeout(idleTimer);
  idleTimer = setTimeout(recenterIfNeeded, SCROLL_IDLE_MS);
}, { passive: true });

let lastWidth = scroller.clientWidth;
new ResizeObserver(() => {
  if (scroller.clientWidth !== lastWidth) {
    lastWidth = scroller.clientWidth;
    redrawChunks();
    paintPreviews();
  } else {
    updateChunks();
  }
}).observe(scroller);


/* 4. Background picker
   ========================================================================== */

const themeColor = document.querySelector('meta[name="theme-color"]');
const backgroundButtons = [...document.querySelectorAll("[data-background]")];

function loadBackground() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveBackground(name) {
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // Storage unavailable (private mode…): the choice just won't persist.
  }
}

function setBackground(name) {
  backgroundName = name in BACKGROUNDS ? name : DEFAULT_BACKGROUND;
  const { color } = BACKGROUNDS[backgroundName];
  track.style.backgroundColor = color;
  themeColor.content = color;

  for (const button of backgroundButtons) {
    const isSelected = button.dataset.background === backgroundName;
    button.classList.toggle("is-selected", isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
  }
  redrawChunks();
}

/** Draws a small piece of each background in its picker button,
    centered on the first thing scattered there (a stone, a cloud…). */
function paintPreviews() {
  for (const button of backgroundButtons) {
    const name = button.dataset.background;
    const canvas = button.querySelector("canvas");
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width) continue;

    const ratio = pixelRatio();
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);

    const viewWidth = width / PREVIEW_SCALE;
    const viewHeight = height / PREVIEW_SCALE;
    const items = BACKGROUNDS[name].scatter?.(seededRandom(name, PREVIEW_INDEX), viewWidth, CHUNK_HEIGHT) ?? [];
    const focus = items.length ? items[0].y : CHUNK_HEIGHT / 2;
    const viewTop = clamp(focus - viewHeight / 2, 0, CHUNK_HEIGHT - viewHeight);

    const ctx = canvas.getContext("2d");
    ctx.scale(ratio * PREVIEW_SCALE, ratio * PREVIEW_SCALE);
    ctx.translate(0, -viewTop);
    paintChunk(ctx, name, PREVIEW_INDEX, viewWidth);
  }
}

for (const button of backgroundButtons) {
  button.addEventListener("click", () => {
    setBackground(button.dataset.background);
    saveBackground(backgroundName);
    closePanel();
  });
}


/* 5. Panels
   On small screens the about and backgrounds panels open as floating windows.
   On desktop they are always-visible side bars (CSS only), and the toggles
   are hidden, so none of this runs there.
   ========================================================================== */

const backdrop = document.getElementById("backdrop");
let openToggle = null;

/** Runs fn when the element is tapped or clicked. Phones swallow the click of a
    tap that stops a running scroll, so touch taps are handled as soon as the
    finger lifts. That touch's own follow-up click is cancelled, otherwise it
    could land on the window that just opened and close it again. */
function onTap(element, fn) {
  let start = null;
  element.addEventListener("touchstart", (event) => {
    const touch = event.changedTouches[0];
    start = { x: touch.clientX, y: touch.clientY };
  }, { passive: true });
  element.addEventListener("touchend", (event) => {
    const touch = event.changedTouches[0];
    if (!start || Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) return; // a swipe, not a tap
    event.preventDefault();
    fn();
  });
  element.addEventListener("click", fn); // mouse and keyboard
}

function openPanel(toggle) {
  closePanel({ restoreFocus: false });
  const panel = document.getElementById(toggle.getAttribute("aria-controls"));
  panel.classList.add("is-open");
  backdrop.classList.add("is-open");
  toggle.setAttribute("aria-expanded", "true");
  scroller.classList.add("is-frozen"); // stops the background while the window is open
  openToggle = toggle;
  panel.focus();
}

function closePanel({ restoreFocus = true } = {}) {
  if (!openToggle) return;
  const panel = document.getElementById(openToggle.getAttribute("aria-controls"));
  panel.classList.remove("is-open");
  backdrop.classList.remove("is-open");
  openToggle.setAttribute("aria-expanded", "false");
  scroller.classList.remove("is-frozen");
  if (restoreFocus) openToggle.focus();
  openToggle = null;
}

for (const toggle of document.querySelectorAll("[data-toggle]")) {
  onTap(toggle, () => {
    if (openToggle === toggle) closePanel();
    else openPanel(toggle);
  });
}

for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => closePanel());
}

backdrop.addEventListener("click", () => closePanel());

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePanel();
});


/* 6. Offline (PWA)
   ========================================================================== */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js");
  });
}


/* Start
   ========================================================================== */

scroller.scrollTop = Math.round(maxScroll() / 2 / CHUNK_HEIGHT) * CHUNK_HEIGHT;
setBackground(loadBackground());
paintPreviews();
scroller.focus({ preventScroll: true });
