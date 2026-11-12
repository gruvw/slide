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
const DEFAULT_BACKGROUND = "night";

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

  /* Dawn: a pastel sky with soft clouds, sometimes a sun or a few birds.
     Rare: a hot-air balloon, a faint rainbow */
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
      // rare
      if (random() < 0.05) {
        items.push({ type: "balloon", x: between(random, 0.15, 0.85) * width, y: between(random, 80, height - 80), size: between(random, 1.1, 1.6), colors: pick(random, BALLOON_COLORS) });
      }
      if (random() < 0.04) {
        items.push({ type: "rainbow", x: between(random, 0.3, 0.7) * width, y: between(random, 200, height - 100), r: between(random, 180, 260) });
      }
      return items;
    },

    paint(ctx, chunk) {
      paintSky(ctx, chunk, this.sky, 4);
      for (const item of chunk.items) {
        if (item.type === "rainbow") paintRainbow(ctx, item); // behind the clouds
      }
      for (const item of chunk.items) {
        if (item.type === "balloon") {
          paintBalloon(ctx, item);
        } else if (item.type === "sun") {
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
          paintBirds(ctx, item, rgba("#5d4e63", 0.4));
        }
      }
    },
  },

  /* Tide: calm water seen from above: slow swells, ripple lines, sparkles,
     rings where a drop just fell, and now and then a little paper boat.
     Rare: koi swimming under the surface, lily pads with a lotus flower */
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
      // rare
      if (random() < 0.05) {
        const x = between(random, 0.2, 0.8) * width;
        const y = between(random, 80, height - 80);
        const angle = random() * TAU;
        const fish = random() < 0.5 ? 1 : 2;
        for (let i = 0; i < fish; i++) {
          items.push({
            type: "koi", x: x + i * between(random, 35, 55), y: y + i * between(random, 28, 45),
            angle: angle + i * between(random, -0.4, 0.4), size: between(random, 21, 26), pattern: Math.floor(random() * 3),
          });
        }
      }
      if (random() < 0.06) {
        const x = between(random, 0.15, 0.85) * width;
        const y = between(random, 80, height - 80);
        const pads = 2 + Math.floor(random() * 3);
        for (let i = 0; i < pads; i++) {
          items.push({
            type: "pad", x: x + between(random, -45, 45), y: y + between(random, -30, 30), r: between(random, 13, 22),
            notch: random() * TAU, color: pick(random, ["#8cbf8c", "#7db381", "#9ac795"]), flower: i === 0,
          });
        }
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

      // Koi swim under the surface, so the ripples pass over them
      for (const item of chunk.items) {
        if (item.type === "koi") paintKoi(ctx, item);
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
        } else if (item.type === "pad") {
          paintLilyPad(ctx, item);
        }
      }
    },
  },

  /* Sand: a zen garden, raked lines flowing around groups of stones.
     Rare: a raked spiral, a fallen maple leaf */
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
      // rare
      if (random() < 0.06) {
        const reach = between(random, 40, 60);
        const radius = reach + 7;
        const spiral = {
          spiral: true, reach, radius, stones: [], rings: 0, turn: random() * TAU,
          x: width > 2 * radius ? between(random, radius, width - radius) : width / 2,
          y: between(random, radius + 4, height - radius - 4),
        };
        if (islands.every((o) => Math.hypot(o.x - spiral.x, o.y - spiral.y) > o.radius + spiral.radius + 24)) islands.push(spiral);
      }
      const items = [...islands];
      if (random() < 0.08) {
        items.push({ type: "maple", x: random() * width, y: random() * height, size: between(random, 14, 18), angle: random() * TAU, color: pick(random, ["#c9553f", "#d8733f", "#c4423f"]) });
      }
      return items;
    },

    paint(ctx, chunk) {
      paintSky(ctx, chunk, this.sky, 3);

      // Raked lines everywhere except inside the islands
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, -CHUNK_OVERLAP, chunk.width, chunk.height + 2 * CHUNK_OVERLAP);
      const islands = chunk.items.filter((item) => item.type !== "maple");
      for (const island of islands) {
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

      for (const island of islands) {
        if (island.spiral) {
          rakeGroove(ctx, (offset) => traceSpiral(ctx, island.x, island.y, island.reach, island.turn, offset));
        }
        for (let k = 0; k < island.rings; k++) {
          const r = island.core + 14 + k * 13;
          rakeGroove(ctx, (offset) => ctx.arc(island.x, island.y, r + offset, 0, TAU));
        }
        for (const stone of island.stones) paintStone(ctx, island.x + stone.dx, island.y + stone.dy, stone);
      }
      for (const item of chunk.items) {
        if (item.type === "maple") paintMaple(ctx, item);
      }
    },
  },

  /* Night: a deep sky with stars, faint nebulae and a rare shooting star.
     Rare: a crescent moon, a constellation, a little ringed planet */
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
      // rare
      if (random() < 0.06) {
        items.push({ type: "moon", x: between(random, 0.2, 0.8) * width, y: between(random, 60, height - 60), r: between(random, 16, 24), angle: between(random, -0.6, 0.6) });
      }
      if (random() < 0.08) {
        const points = [{ x: between(random, 0.2, 0.8) * width, y: between(random, 80, height - 80) }];
        let heading = random() * TAU;
        for (let i = 0, n = 3 + Math.floor(random() * 3); i < n; i++) {
          heading += between(random, -1.2, 1.2);
          const step = between(random, 28, 55);
          const last = points.at(-1);
          points.push({ x: last.x + Math.cos(heading) * step, y: last.y + Math.sin(heading) * step });
        }
        items.push({ type: "constellation", y: points[0].y, points: points.map((p) => ({ dx: p.x - points[0].x, dy: p.y - points[0].y })), x: points[0].x });
      }
      if (random() < 0.03) {
        items.push({ type: "planet", x: between(random, 0.15, 0.85) * width, y: between(random, 40, height - 40), r: between(random, 7, 11), tilt: between(random, -0.5, 0.5), color: pick(random, ["#d9c3a0", "#c7b8e6", "#e6b9a8"]) });
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
        } else if (item.type === "moon") {
          paintMoon(ctx, item);
        } else if (item.type === "constellation") {
          paintConstellation(ctx, item);
        } else if (item.type === "planet") {
          paintPlanet(ctx, item);
        }
      }
    },
  },

  /* Glow: soft, flat rounded shapes in the spirit of Material 3 Expressive
     (scalloped cookies, clovers, flowers, sunbursts, pills, circles), each one
     a single solid shape with a gentle glow behind it, plus a few tiny dots.
     Rare: a heart, a sparkle, a cookie with a little smiling face */
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
      // rare: take the place of a regular shape, so they never crowd the others
      const shapes = items.filter((item) => item.type === "shape");
      const swap = (changes) => {
        if (!shapes.length) return;
        const target = shapes.splice(Math.floor(random() * shapes.length), 1)[0];
        Object.assign(target, changes, { r: Math.max(target.r, 26) });
      };
      if (random() < 0.06) swap({ type: "heart", color: pick(random, ["#f6a9bf", "#f4b2c5", "#ffb3a7"]), turn: between(random, -0.3, 0.3) });
      if (random() < 0.06) swap({ type: "sparkle", color: pick(random, ["#fbd98a", "#ffd27a", "#cbbcfb"]), turn: between(random, -0.25, 0.25) });
      if (random() < 0.04) swap({ type: "shape", face: true, kind: "round", lobes: 9, depth: 0.08, pinch: 1.5, turn: 0 });
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
        if (item.type === "heart") {
          traceHeart(ctx, item.x, item.y, item.r, item.turn);
        } else if (item.type === "sparkle") {
          traceSparkle(ctx, item.x, item.y, item.r, item.turn);
        } else if (item.kind === "pill") {
          ctx.save();
          ctx.translate(item.x, item.y);
          ctx.rotate(item.turn);
          ctx.roundRect(-item.r, -item.r * 0.5, item.r * 2, item.r, item.r * 0.5);
          ctx.restore();
        } else {
          traceRoundShape(ctx, item.x, item.y, item.r, item, item.turn);
        }
        ctx.fill();
        if (item.type === "sparkle") {
          ctx.strokeStyle = item.color;
          ctx.lineWidth = item.r * 0.16;
          ctx.lineJoin = "round";
          ctx.stroke();
        }
        if (item.face) paintFace(ctx, item);
      }
    },
  },

  /* Petals: cherry blossom petals drifting by in loose clusters, now and then
     a whole flower, and sometimes a blossoming branch reaching in from the side.
     Rare: a butterfly, a little bird perched on a branch */
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
      // rare
      if (random() < 0.07) {
        items.push({ type: "butterfly", x: between(random, 0.15, 0.85) * width, y: between(random, 40, height - 40), size: between(random, 1.8, 2.3), angle: between(random, -0.6, 0.6), colors: pick(random, BUTTERFLY_COLORS) });
      }
      const branch = items[0]?.type === "branch" ? items[0] : null;
      if (branch && random() < 0.2) {
        const t = between(random, 0.4, 0.7);
        branch.bird = { t, size: between(random, 1.6, 1.9), facing: random() < 0.5 ? -1 : 1 };
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
        } else if (item.type === "butterfly") {
          paintButterfly(ctx, item);
        }
      }
    },
  },

  /* Hills: crisp layered ridges at dusk, with little pine trees on some of them.
     Rare: a cabin with a warm lit window, a hot-air balloon, a flock of birds */
  hills: {
    color: "#bfc6dc",
    bands: ["#c9d0e4", "#c6c2df", "#bfcde1", "#d0cbe0"], // slow drift of similar brightness
    shadow: "#26355c",

    scatter(random, width, height) {
      const items = [];
      if (random() < 0.05) {
        items.push({ type: "balloon", x: between(random, 0.15, 0.85) * width, y: between(random, 80, height - 80), size: between(random, 1.1, 1.5), colors: pick(random, BALLOON_COLORS) });
      }
      if (random() < 0.06) {
        const birds = Array.from({ length: 4 + Math.floor(random() * 4) }, (_, i) => ({
          dx: (i % 2 ? 1 : -1) * Math.ceil(i / 2) * between(random, 10, 14), dy: Math.ceil(i / 2) * between(random, 6, 9),
          size: between(random, 3.5, 5), lift: between(random, 0.35, 0.6),
        }));
        items.push({ type: "flock", x: between(random, 0.2, 0.8) * width, y: between(random, 40, height - 60), birds });
      }
      return items;
    },

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

        // rare: a little cabin sitting on this ridge
        if (random() < 0.004) {
          const x = between(random, 0.15, 0.85) * chunk.width;
          paintCabin(ctx, x, waveAt(x, y, waves) + 3, between(random, 1.5, 1.8));
        }
      }

      for (const item of chunk.items) {
        if (item.type === "balloon") paintBalloon(ctx, item);
        else if (item.type === "flock") paintBirds(ctx, item, rgba("#34466f", 0.55));
      }
    },
  },

  /* Leaves: flat, paper-cut leaves and ginkgo fans scattered on warm paper.
     Rare: a ladybug, an acorn */
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
      // rare
      const free = (x, y, r) => items.every((o) => Math.hypot(o.x - x, o.y - y) > o.size + r + 6);
      if (random() < 0.07) {
        const bug = { type: "ladybug", x: random() * width, y: random() * height, size: between(random, 1.8, 2.2), angle: random() * TAU };
        if (free(bug.x, bug.y, 16)) items.push(bug);
      }
      if (random() < 0.06) {
        const acorn = { type: "acorn", x: random() * width, y: random() * height, size: between(random, 1.6, 1.9), angle: random() * TAU };
        if (free(acorn.x, acorn.y, 20)) items.push(acorn);
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
        if (item.type === "ladybug") {
          paintLadybug(ctx, item);
          continue;
        }
        if (item.type === "acorn") {
          paintAcorn(ctx, item);
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

/* ---- Rare items ---- */

const BALLOON_COLORS = [
  ["#f3a9a0", "#fbe3c4"], ["#a9c7ec", "#f5efe3"], ["#f6cf7e", "#f2a98f"], ["#b9a6e3", "#f6dce6"],
];
const BUTTERFLY_COLORS = [
  ["#f2b8c9", "#f8dbe3"], ["#cdbff0", "#ebe4fb"], ["#f6d58f", "#fbecc4"], ["#a9d5e6", "#dcf0f6"],
];

/** Small V-shaped birds (dx/dy relative to item.x/item.y). */
function paintBirds(ctx, item, color) {
  ctx.strokeStyle = color;
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

/** A hot-air balloon with two-tone gores and a little basket. */
function paintBalloon(ctx, { x, y, size, colors: [main, stripe] }) {
  const envelope = new Path2D("M0 14C-6 9 -17 1 -17 -9A17 17 0 0 1 17 -9C17 1 6 9 0 14Z");
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size, size);
  ctx.fillStyle = main;
  ctx.fill(envelope);
  ctx.save();
  ctx.clip(envelope);
  ctx.fillStyle = stripe;
  for (const k of [-0.62, 0, 0.62]) {
    ctx.beginPath();
    ctx.ellipse(k * 17, -6, 3.2, 22, k * 0.25, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.beginPath();
  ctx.ellipse(-7, -14, 5, 7, -0.5, 0, TAU);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = "rgba(90,70,60,0.55)";
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(-4, 11);
  ctx.lineTo(-2.6, 18);
  ctx.moveTo(4, 11);
  ctx.lineTo(2.6, 18);
  ctx.stroke();
  ctx.fillStyle = "#9b7458";
  ctx.beginPath();
  ctx.roundRect(-3.2, 18, 6.4, 4.6, 1);
  ctx.fill();
  ctx.restore();
}

/** A faint rainbow arc (y is the top of the arc). */
function paintRainbow(ctx, { x, y, r }) {
  const colors = ["#f4a6a6", "#f7c99b", "#f6e3a1", "#b9dfb0", "#a9cbea", "#c6b4e6"];
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  colors.forEach((color, i) => {
    ctx.strokeStyle = rgba(color, 0.3);
    ctx.beginPath();
    ctx.arc(x, y + r, r - i * 7, Math.PI + 0.45, TAU - 0.45);
    ctx.stroke();
  });
}

const KOI_BODY = new Path2D(
  "M0 -1C0.42 -0.9 0.44 0.15 0.1 0.72L0.38 1.18Q0 1 -0.38 1.18L-0.1 0.72C-0.44 0.15 -0.42 -0.9 0 -1Z",
);

/** A koi seen from above, slightly faded as it swims below the surface. */
function paintKoi(ctx, { x, y, angle, size, pattern }) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(size, size);
  ctx.globalAlpha = 0.88;
  // side fins
  ctx.fillStyle = "#f6efe6";
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(side * 0.33, -0.3, 0.26, 0.12, side * 0.6, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = "#fbf6ef";
  ctx.fill(KOI_BODY);
  ctx.save();
  ctx.clip(KOI_BODY);
  ctx.fillStyle = pattern === 2 ? "#e9a24c" : "#ef7d4b";
  const spots = [
    [[0, -0.7, 0.32], [0.05, 0.2, 0.24]],
    [[-0.1, -0.35, 0.3], [0.12, 0.45, 0.2]],
    [[0, -0.2, 0.55]],
  ][pattern];
  for (const [sx, sy, sr] of spots) {
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
  ctx.restore();
}

/** A round lily pad with its notch; the first pad of a group carries a lotus. */
function paintLilyPad(ctx, { x, y, r, notch, color, flower }) {
  ctx.fillStyle = "rgba(60,110,120,0.15)";
  ctx.beginPath();
  ctx.ellipse(x + 2, y + 2.5, r, r * 0.92, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.arc(x, y, r, notch + 0.28, notch - 0.28 + TAU);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  for (let k = 1; k < 6; k++) {
    const a = notch + (k / 6) * TAU;
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8);
  }
  ctx.stroke();
  if (!flower) return;
  ctx.save();
  ctx.translate(x - r * 0.15, y - r * 0.1);
  for (const [count, length, tone] of [[7, 9, "#f3b7c6"], [5, 6.5, "#f9d5df"]]) {
    for (let k = 0; k < count; k++) {
      ctx.save();
      ctx.rotate((k / count) * TAU + length);
      ctx.fillStyle = tone;
      ctx.beginPath();
      ctx.ellipse(0, -length * 0.55, length * 0.32, length * 0.6, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }
  ctx.fillStyle = "#f2d27a";
  ctx.beginPath();
  ctx.arc(0, 0, 2.4, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** An Archimedean spiral raked around (x, y), out to `reach`. */
function traceSpiral(ctx, x, y, reach, turn, offset) {
  const spacing = 13 / TAU;
  const end = (reach - 4) / spacing;
  for (let a = 0; a <= end; a += 0.08) {
    const radius = 4 + spacing * a + offset;
    const px = x + Math.cos(a + turn) * radius;
    const py = y + Math.sin(a + turn) * radius;
    if (a === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
}

/** A five-lobed maple leaf (unit size, pointing up), built from its tips and notches. */
const MAPLE_SHAPE = (() => {
  const points = [
    [-145, 0.88], [-117, 0.36], [-90, 1], [-63, 0.36], [-35, 0.88], [-8, 0.34],
    [22, 0.6], [90, 0.2], [158, 0.6], [188, 0.34],
  ];
  const path = new Path2D();
  points.forEach(([deg, length], i) => {
    const a = (deg * Math.PI) / 180;
    path[i ? "lineTo" : "moveTo"](Math.cos(a) * length, Math.sin(a) * length);
  });
  path.closePath();
  return path;
})();

function paintMaple(ctx, { x, y, size, angle, color }) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(size, size);
  ctx.lineJoin = "round";
  ctx.lineWidth = 0.12;
  ctx.save();
  ctx.translate(0.14, 0.14);
  ctx.fillStyle = ctx.strokeStyle = "rgba(110,85,50,0.18)";
  ctx.fill(MAPLE_SHAPE);
  ctx.stroke(MAPLE_SHAPE);
  ctx.restore();
  ctx.fillStyle = ctx.strokeStyle = color;
  ctx.fill(MAPLE_SHAPE);
  ctx.stroke(MAPLE_SHAPE);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 0.06;
  ctx.beginPath();
  for (const deg of [-145, -90, -35, 22, 158]) {
    const a = (deg * Math.PI) / 180;
    ctx.moveTo(0, 0.05);
    ctx.lineTo(Math.cos(a) * 0.7, Math.sin(a) * 0.7);
  }
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.09;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0, 0.15);
  ctx.quadraticCurveTo(0.05, 0.5, 0.15, 0.75);
  ctx.stroke();
  ctx.restore();
}

/** A crescent moon with a soft glow. */
function paintMoon(ctx, { x, y, r, angle }) {
  softEllipse(ctx, x, y, r * 4.5, r * 4.5, "#fff1d6", 0.16);
  softEllipse(ctx, x, y, r * 2, r * 2, "#fff1d6", 0.18);
  const shadowX = x + Math.cos(angle) * r * 0.45;
  const shadowY = y + Math.sin(angle) * r * 0.45 - r * 0.12;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x - r * 2, y - r * 2, r * 4, r * 4);
  ctx.arc(shadowX, shadowY, r * 0.86, 0, TAU);
  ctx.clip("evenodd");
  ctx.fillStyle = "#fff3da";
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** A few bright stars joined by faint lines. */
function paintConstellation(ctx, { x, y, points }) {
  ctx.strokeStyle = "rgba(200,215,255,0.28)";
  ctx.lineWidth = 0.8;
  ctx.lineJoin = "round";
  ctx.beginPath();
  points.forEach((p, i) => ctx[i ? "lineTo" : "moveTo"](x + p.dx, y + p.dy));
  ctx.stroke();
  for (const p of points) {
    softEllipse(ctx, x + p.dx, y + p.dy, 9, 9, "#dfe8ff", 0.35);
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(x + p.dx, y + p.dy, 1.9, 0, TAU);
    ctx.fill();
  }
}

/** A tiny planet with a tilted ring. */
function paintPlanet(ctx, { x, y, r, tilt, color }) {
  const ring = (start, end) => {
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 2, r * 0.55, 0, start, end);
    ctx.stroke();
  };
  softEllipse(ctx, x, y, r * 3, r * 3, color, 0.15);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  ctx.strokeStyle = rgba(color, 0.85);
  ctx.lineWidth = 1.6;
  ring(Math.PI, TAU); // back half
  const body = ctx.createLinearGradient(-r, -r, r, r);
  body.addColorStop(0, color);
  body.addColorStop(1, rgba(color, 0.55));
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();
  ring(0, Math.PI); // front half
  ctx.restore();
}

/** A soft, rounded heart centered on (x, y). */
function traceHeart(ctx, x, y, r, turn) {
  const steps = 120;
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * TAU;
    const hx = 16 * Math.sin(t) ** 3;
    const hy = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    const px = (hx * Math.cos(turn) - hy * Math.sin(turn)) * (r / 16);
    const py = (hx * Math.sin(turn) + hy * Math.cos(turn)) * (r / 16) - r * 0.1;
    ctx[i ? "lineTo" : "moveTo"](x + px, y + py);
  }
  ctx.closePath();
}

/** A four-pointed sparkle: concave sides, gently rounded tips. */
function traceSparkle(ctx, x, y, r, turn) {
  const point = (a, length) => [x + Math.cos(a + turn) * length, y + Math.sin(a + turn) * length];
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * TAU - Math.PI / 2;
    const tip = point(a, r);
    const control = point(a + Math.PI / 4, r * 0.24);
    const next = point(a + Math.PI / 2, r);
    if (k === 0) ctx.moveTo(...tip);
    ctx.quadraticCurveTo(...control, ...next);
  }
  ctx.closePath();
}

/** Two dot eyes, rosy cheeks and a small smile, in a darker tone of the shape. */
function paintFace(ctx, { x, y, r, color }) {
  const ink = rgbString(mixRgb(hexToRgb(color), [70, 55, 80], 0.6));
  ctx.fillStyle = ink;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(x + side * r * 0.3, y - r * 0.1, r * 0.075, r * 0.1, 0, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = "rgba(255,140,160,0.35)";
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(x + side * r * 0.5, y + r * 0.12, r * 0.13, r * 0.08, 0, 0, TAU);
    ctx.fill();
  }
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(1.5, r * 0.07);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(x, y + r * 0.05, r * 0.2, 0.2 * Math.PI, 0.8 * Math.PI);
  ctx.stroke();
}

/** A soft pastel butterfly, wings open. */
function paintButterfly(ctx, { x, y, size, angle, colors: [wing, light] }) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(size, size);
  for (const side of [-1, 1]) {
    ctx.fillStyle = wing;
    ctx.beginPath();
    ctx.ellipse(side * 7, -4, 7.5, 6, side * -0.5, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(side * 5.5, 5, 5, 4.2, side * 0.6, 0, TAU);
    ctx.fill();
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.ellipse(side * 8, -5, 3, 2.3, side * -0.5, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(side * 6, 5.5, 1.6, 0, TAU);
    ctx.fill();
  }
  ctx.strokeStyle = "#6b5560";
  ctx.lineCap = "round";
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(0, -6);
  ctx.lineTo(0, 7);
  ctx.stroke();
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(-0.5, -6);
  ctx.quadraticCurveTo(-2, -11, -4, -12);
  ctx.moveTo(0.5, -6);
  ctx.quadraticCurveTo(2, -11, 4, -12);
  ctx.stroke();
  ctx.restore();
}

/** A small round songbird (a white-eye) sitting on the branch at point p. */
function paintPerchedBird(ctx, p, { size, facing }) {
  ctx.save();
  ctx.translate(p.x, p.y - 2);
  ctx.scale(size * facing, size);
  ctx.strokeStyle = "#5b4a44";
  ctx.lineWidth = 1;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-1.5, -3);
  ctx.lineTo(-2, 0);
  ctx.moveTo(1.5, -3);
  ctx.lineTo(1.5, 0);
  ctx.stroke();
  ctx.fillStyle = "#7f9550"; // tail
  ctx.beginPath();
  ctx.moveTo(-6, -7);
  ctx.lineTo(-14, -4);
  ctx.lineTo(-13, -7.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#93a85e"; // body
  ctx.beginPath();
  ctx.ellipse(-1, -8, 7.5, 5.5, -0.15, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#e9e3b8"; // belly
  ctx.beginPath();
  ctx.ellipse(0.5, -5.5, 5, 2.8, -0.1, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#9db365"; // head
  ctx.beginPath();
  ctx.arc(5, -13, 4.2, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#7f9550"; // wing
  ctx.beginPath();
  ctx.ellipse(-3, -8.5, 4.5, 2.6, 0.25, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#ffffff"; // eye ring
  ctx.beginPath();
  ctx.arc(6.3, -13.6, 1.7, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#2f2a2a";
  ctx.beginPath();
  ctx.arc(6.5, -13.6, 0.9, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#4e463f"; // beak
  ctx.beginPath();
  ctx.moveTo(8.8, -13.5);
  ctx.lineTo(11.2, -12.6);
  ctx.lineTo(8.8, -11.9);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** A tiny cabin silhouette in the ridge color, with a warm lit window and smoke. */
function paintCabin(ctx, x, ground, size) {
  const ridgeColor = ctx.fillStyle;
  ctx.save();
  ctx.translate(x, ground);
  ctx.scale(size, size);
  ctx.beginPath();
  ctx.rect(-8, -9, 16, 10);
  ctx.moveTo(-10.5, -8.5);
  ctx.lineTo(0, -17);
  ctx.lineTo(10.5, -8.5);
  ctx.closePath();
  ctx.rect(4, -18, 3, 6);
  ctx.fill();
  softEllipse(ctx, -2.5, -4.5, 9, 9, "#ffd48a", 0.35);
  ctx.fillStyle = "#ffd998";
  ctx.fillRect(-4.5, -6.5, 4, 3.5);
  ctx.strokeStyle = "rgba(255,255,255,0.45)";
  ctx.lineWidth = 1.2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(5.5, -20);
  ctx.bezierCurveTo(3, -24, 9, -26, 6.5, -31);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = ridgeColor;
}

/** A paper-cut ladybug. */
function paintLadybug(ctx, { x, y, size, angle }) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(size, size);
  ctx.fillStyle = "rgba(90,70,40,0.12)";
  ctx.beginPath();
  ctx.ellipse(1.2, 1.5, 6.5, 7.5, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#3a3330"; // head
  ctx.beginPath();
  ctx.arc(0, -6.2, 3.4, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#d9493c"; // shell
  ctx.beginPath();
  ctx.ellipse(0, 0.8, 6.3, 7.2, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = "#3a3330";
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(0, -6.2);
  ctx.lineTo(0, 8);
  ctx.stroke();
  ctx.fillStyle = "#3a3330";
  for (const [dx, dy, r] of [[2.8, -2, 1.3], [-2.8, -2, 1.3], [3.3, 3, 1.2], [-3.3, 3, 1.2], [1.6, 6, 0.9], [-1.6, 6, 0.9]]) {
    ctx.beginPath();
    ctx.arc(dx, dy, r, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath();
  ctx.ellipse(-2.6, -2.8, 1.4, 0.8, -0.6, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** A paper-cut acorn with its textured cap. */
function paintAcorn(ctx, { x, y, size, angle }) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(size, size);
  ctx.fillStyle = "rgba(90,70,40,0.12)";
  ctx.beginPath();
  ctx.ellipse(1.5, 3.5, 6.5, 9, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#c99a5b"; // nut
  ctx.beginPath();
  ctx.ellipse(0, 2.5, 6, 8, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  ctx.beginPath();
  ctx.ellipse(-2.4, 3, 1.6, 4, 0.1, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#8a6a46"; // cap
  ctx.beginPath();
  ctx.ellipse(0, -3.5, 7.5, 4.6, 0, Math.PI, TAU);
  ctx.ellipse(0, -3.5, 7.5, 1.6, 0, 0, Math.PI);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  for (let k = -2; k <= 2; k++) {
    ctx.beginPath();
    ctx.arc(k * 2.6, -4.5 + Math.abs(k) * 0.4, 0.75, 0, TAU);
    ctx.fill();
  }
  ctx.strokeStyle = "#7a5b3c"; // stem
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0, -7.6);
  ctx.quadraticCurveTo(0.6, -10.5, 2.2, -11.2);
  ctx.stroke();
  ctx.restore();
}

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
  if (branch.bird) paintPerchedBird(ctx, branch.along(branch.bird.t), branch.bird);
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

/** Stops a running fling, e.g. when switching to another background. A tiny
    instant scroll interrupts it in most browsers (a scroll to the current spot
    is ignored, hence the 1px, unnoticeable while the background is redrawn);
    briefly turning scrolling off also stops it on iPhone. */
function stopScroll() {
  scroller.classList.add("is-frozen");
  scroller.scrollTo({ top: scroller.scrollTop + 1, behavior: "instant" });
  requestAnimationFrame(() => requestAnimationFrame(() => scroller.classList.remove("is-frozen")));
}

// When the list of backgrounds was just flicked, a tap only stops it: not a choice.
let pickerScrolledAt = -Infinity;
document.querySelector("#backgrounds-panel .panel__content")
  .addEventListener("scroll", () => { pickerScrolledAt = performance.now(); }, { passive: true });

for (const button of backgroundButtons) {
  onTap(button, () => {
    if (performance.now() - pickerScrolledAt < 150) return;
    if (button.dataset.background !== backgroundName) {
      stopScroll();
      setBackground(button.dataset.background);
      saveBackground(backgroundName);
    }
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
  openToggle = toggle;
  panel.focus({ preventScroll: true });
}

function closePanel({ restoreFocus = true } = {}) {
  if (!openToggle) return;
  const panel = document.getElementById(openToggle.getAttribute("aria-controls"));
  panel.classList.remove("is-open");
  backdrop.classList.remove("is-open");
  openToggle.setAttribute("aria-expanded", "false");
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
  onTap(button, () => closePanel());
}

onTap(backdrop, () => closePanel());

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
