import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// The chart primitives are a browser file (no module system, patches are
// copied through terser rather than bundled), so this harness evaluates it
// against a minimal DOM stand-in. That keeps the geometry — which is the part
// that can be wrong in a way a screenshot would not reveal — under test.
const source = readFileSync(
  resolve(import.meta.dirname, "../src/resource/patches/_charts.js"),
  "utf8",
);

function makeDom() {
  class FakeEl {
    constructor(tag) {
      this.tag = tag;
      this.attrs = {};
      this.children = [];
      this.textContent = "";
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    }
    removeAttribute(k) {
      delete this.attrs[k];
    }
    getAttribute(k) {
      return this.attrs[k];
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    // Path geometry is what the assertions read.
    get d() {
      return this.attrs.d;
    }
    // Match a whole class token, not a substring: `includes("dash-bar")`
    // also matches "shadcn-dash-bars" (the frame) and "dash-bar-empty".
    find(classFragment) {
      const out = [];
      const walk = (el) => {
        const cls = el.attrs?.class;
        if (typeof cls === "string" && cls.split(/\s+/).includes(classFragment))
          out.push(el);
        for (const c of el.children ?? []) walk(c);
      };
      walk(this);
      return out;
    }
  }

  const document = {
    createElementNS: (_ns, tag) => new FakeEl(tag),
    // The axis wrapper and its label column are HTML, not SVG (see the
    // preserveAspectRatio note in _charts.js), so the harness needs both.
    createElement: (tag) => new FakeEl(tag),
  };

  return { document, FakeEl };
}

/* The harness has no animation frames, so `animate()` resolves every tween
   synchronously to its final value — exactly what a reduced-motion reader
   sees. `reduced` flips the matchMedia answer for the one test that asserts
   the static path. */
function load({ reduced = false } = {}) {
  const { document } = makeDom();
  const window = {
    document,
    matchMedia: () => ({ matches: reduced }),
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", "document", `${source}\nreturn window;`);
  const win = fn(window, document);
  return win.ShadcnCharts;
}

const Charts = load();

function parent() {
  return {
    children: [],
    appendChild(c) {
      this.children.push(c);
      return c;
    },
  };
}

// Every y coordinate in a path built from M/L/C/Q commands. Those commands all
// take coordinate *pairs*, so after the letters are stripped the odd indices
// are the y values — including every control point of a curve, which is what
// an overshoot check has to look at.
function ys(d) {
  const nums = (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  const out = [];
  for (let i = 1; i < nums.length; i += 2) out.push(nums[i]);
  return out;
}

test("extent gives a nominal span to a flat series", () => {
  const r = Charts.extent([5, 5, 5]);
  assert.ok(r.max > r.min, "flat series must not collapse to zero height");
  // A flat series should still be centred, not pinned to the baseline.
  assert.equal((r.min + r.max) / 2, 5);
});

test("extent ignores nulls and empty input", () => {
  assert.deepEqual(Charts.extent([null, null]), { min: 0, max: 1 });
  const r = Charts.extent([1, null, 9]);
  assert.equal(r.min, 1);
  assert.equal(r.max, 9);
});

test("linePath breaks the line at a gap instead of dropping to zero", () => {
  const p = Charts.linePath([10, 20, null, 40, 50], 100, 34);
  assert.ok(p, "a series with one gap still yields a path");
  // Two separate subpaths => one "M" per run, so the gap is a break.
  const moves = p.line.match(/M/g) ?? [];
  assert.equal(moves.length, 2, "a null must start a new subpath");
  // The gap must not appear as a point at y = height (which would read as 0).
  assert.ok(
    !p.line.includes("M50 34") && !p.line.includes("L50 34"),
    "a missing sample must not be plotted on the baseline",
  );
});

test("linePath curves smoothly and stays inside the value range", () => {
  // The monotone cubic must not overshoot: an overshooting spline on a rate
  // chart invents a peak the device never reported.
  const p = Charts.linePath([0, 100, 0, 100], 90, 34);
  assert.ok(/C/.test(p.line), `expected curve segments: ${p.line}`);
  for (const y of ys(p.line)) {
    assert.ok(y >= -0.01 && y <= 34.01, `curve y ${y} escaped 0..34`);
  }
  // The area is built from the same geometry and must not poke below either.
  for (const y of ys(p.area)) {
    assert.ok(y >= -0.01 && y <= 34.01, `area y ${y} escaped 0..34`);
  }
});

test("linePath handles a single sample without dividing by zero", () => {
  const p = Charts.linePath([7], 100, 34);
  assert.ok(p);
  assert.ok(
    !/NaN|Infinity/.test(p.line),
    `unexpected numeric output: ${p.line}`,
  );
});

test("sparkline writes the final geometry on a first paint", () => {
  // No requestAnimationFrame in the harness, so this is also the static path
  // a reduced-motion reader gets.
  const p = parent();
  Charts.sparkline(p, [1, 4, 2, 8], { h: 34 });
  const frame = p.children[0];
  const line = frame.find("dash-line");
  assert.equal(line.length, 1, "one stroke path");
  assert.ok(line[0].d.startsWith("M"), `path not drawn: ${line[0].d}`);
  assert.equal(frame.find("dash-dot").length, 1, "the endpoint carries a dot");
});

test("multiLine shares one y-scale across series", () => {
  // A shared scale is the point of the ports card: two separate scales made
  // the download and upload lines incomparable.
  const p = parent();
  Charts.multiLine(
    p,
    [
      { values: [0, 10, 20], key: "down" },
      { values: [0, 100, 200], key: "up", lineClass: "dash-line-up" },
    ],
    { h: 34, key: "test-shared" },
  );
  const frame = p.children[0];
  const down = frame.find("dash-line")[0].d;
  const up = frame.find("dash-line-up")[0].d;
  const downMax = Math.min(...ys(down));
  const upMax = Math.min(...ys(up));
  assert.ok(upMax < downMax, "the larger series must sit higher");
  // The big series tops out at the top of the box, the small one well below.
  assert.ok(upMax <= 0.5, `up line should reach the top: ${upMax}`);
  assert.ok(downMax > 10, `down line should stay low: ${downMax}`);
});

test("axis mode wraps the frame and labels every tick", () => {
  // adr/0009-adjacent: the labels are HTML, not SVG <text>, because the frame
  // stretches horizontally and would distort glyphs. That means an axis chart
  // is a wrapper, and callers that query `.shadcn-dash-chart` directly would
  // silently find nothing.
  const p = parent();
  Charts.multiLine(
    p,
    [
      { values: [0, 50, 100], key: "a" },
      { values: [0, 25, 50], key: "b" },
    ],
    {
      h: 56,
      key: "test-axis",
      axis: true,
      ticks: 2,
      yLabels: (v) => String(Math.round(v)),
      xLabels: ["13:18:40", "13:20:56"],
    },
  );

  const plot = p.children[0];
  assert.equal(plot.attrs.class, "shadcn-dash-plot", "axis charts are wrapped");

  const labels = plot.find("dash-axis-label");
  // 3 y ticks + 2 x ticks
  assert.equal(labels.length, 5, "three y labels and two time labels");
  assert.deepEqual(
    labels.slice(0, 3).map((l) => l.textContent),
    ["100", "50", "0"],
    "y labels run top-down, zero at the baseline",
  );
  assert.deepEqual(
    labels.slice(3).map((l) => l.textContent),
    ["13:18:40", "13:20:56"],
    "time axis shows only the two ends",
  );

  // Each y label is positioned by percentage so it lands on its own guide.
  const tops = labels
    .slice(0, 3)
    .map((l) => parseFloat(l.attrs.style.split(":")[1]));
  assert.ok(
    tops[0] < tops[1] && tops[1] < tops[2],
    `labels not ordered: ${tops}`,
  );
  assert.ok(
    tops[2] > 90,
    `the zero label should sit at the baseline: ${tops[2]}`,
  );
});

test("axis mode anchors the scale at zero and rounds the top", () => {
  // A framed plot is read against zero; a floating minimum would make a
  // 4.8→5.0 MB/s wobble fill the whole height and look like a crisis.
  const p = parent();
  Charts.sparkline(p, [4.8e6, 4.9e6, 5.0e6], {
    h: 56,
    key: "test-zero",
    axis: true,
    ticks: 2,
    yLabels: (v) => String(v),
  });
  const labels = p.children[0].find("dash-axis-label");
  assert.equal(
    labels[labels.length - 1].textContent,
    "0",
    "bottom tick is zero",
  );
  // 5.0 MB/s rounds up to a binary step (5 MiB), not to the raw maximum.
  const top = Number(labels[0].textContent);
  assert.ok(top >= 5.0e6, `top tick must cover the data: ${top}`);
  assert.equal(
    top,
    5 * 1024 * 1024,
    `top tick should be a round binary step: ${top}`,
  );
});

test("area fill uses a gradient that never carries its own colour", () => {
  const p = parent();
  Charts.sparkline(p, [1, 2, 3], { h: 34, key: "test-grad" });
  const frame = p.children[0];

  const grad = frame.find("dash-grad");
  assert.equal(grad.length, 1, "one gradient per area series");
  // The id is what the path's fill references, so they must agree.
  const id = grad[0].attrs.id;
  const area = frame.find("dash-area")[0];
  assert.equal(area.attrs.fill, `url(#${id})`, "area points at its gradient");

  // Colour ownership stays in CSS: stops carry a class, never a stop-color.
  const stops = grad[0].children.filter((c) => c.tag === "stop");
  assert.equal(stops.length, 3, "top / mid / transparent");
  for (const s of stops) {
    assert.ok(s.attrs.class, "every stop carries a class");
    assert.equal(
      s.attrs["stop-color"],
      undefined,
      "no colour literal on a stop",
    );
  }
  // objectBoundingBox (the default) is what keeps a low series tinted under
  // its own line; userSpaceOnUse would anchor the fade to the plot box.
  assert.equal(grad[0].attrs.gradientUnits, undefined);
});

test("each series gets its own tone, and the dot follows the last one", () => {
  const p = parent();
  Charts.multiLine(
    p,
    [
      { values: [0, 1], key: "a", tone: "a" },
      { values: [1, 0], key: "b", tone: "c" },
    ],
    { h: 34, key: "test-tones" },
  );
  const frame = p.children[0];
  assert.equal(frame.find("dash-line-a").length, 1);
  assert.equal(frame.find("dash-line-c").length, 1);
  // Both the marker and its halo carry the tone, so the pair reads as one dot.
  assert.equal(
    frame.find("dash-dot-c").length,
    2,
    "dot and halo match the last series",
  );
  assert.equal(frame.find("dash-dot-a").length, 0);
  // Two areas, two gradients: sharing one would tint both the first colour.
  assert.equal(frame.find("dash-grad").length, 2);
});

test("bars stay inside the viewBox", () => {
  const p = parent();
  Charts.bars(p, [{ value: 1 }, { value: 5 }, { value: 3 }], {
    w: 100,
    h: 34,
  });
  const frame = p.children[0];
  assert.equal(frame.attrs.viewBox, "0 0 100 34");

  for (const path of frame.find("dash-bar")) {
    assert.ok(path.d, "bar paths carry geometry");
    assert.ok(!/NaN/.test(path.d), `NaN in bar path: ${path.d}`);
    for (const y of ys(path.d)) {
      assert.ok(y >= -0.01 && y <= 34.01, `bar y ${y} escaped 0..34`);
    }
  }

  // A zero-value bar is "no traffic this hour", so it collapses to a hairline
  // on the baseline rather than a rounded blob dipping out of the viewBox.
  const p2 = parent();
  Charts.bars(p2, [{ value: 0 }, { value: 10 }], { w: 100, h: 34 });
  const empty = p2.children[0].find("dash-bar-empty");
  assert.equal(empty.length, 2, "one hairline slot per bar");
  // The drawn bar is opaque and the zero slot keeps its hairline visible.
  const bars = p2.children[0].find("dash-bar");
  assert.equal(bars[0].d, "", "a zero bar draws no filled path");
  assert.equal(empty[0].attrs.opacity, "1");
  assert.equal(empty[1].attrs.opacity, "0", "a drawn bar hides its hairline");
});

test("bars anchor at zero, not at the series minimum", () => {
  // Anchoring at the minimum would make a flat, high series look like a flat,
  // empty one; magnitude is what a bar chart encodes.
  const p = parent();
  Charts.bars(p, [{ value: 90 }, { value: 100 }], { w: 100, h: 34 });
  const paths = p.children[0].find("dash-bar").map((b) => b.d);
  assert.ok(paths[0] && paths[1], "both bars drawn");
  const top0 = Math.min(...ys(paths[0]));
  const top1 = Math.min(...ys(paths[1]));
  assert.ok(top1 < top0, "100 must be taller than 90");
  assert.ok(top0 > 1, "90 must still be visibly below the top");
});

test("hourBars draws a rail per slot and lifts the peak", () => {
  const p = parent();
  Charts.hourBars(
    p,
    [{ value: 1 }, { value: 9 }, { value: 4 }, { value: 0, empty: true }],
    { w: 100, h: 44 },
  );
  const frame = p.children[0];
  assert.equal(frame.find("dash-hour-rail").length, 4, "one rail per hour");
  const peak = frame.find("dash-bar-peak");
  assert.equal(peak.length, 1, "exactly one peak column");
  for (const path of frame.find("dash-bar")) {
    for (const y of ys(path.d)) {
      assert.ok(y >= -0.01 && y <= 44.01, `hour bar y ${y} escaped 0..44`);
    }
  }
  // The empty hour keeps its hairline; the others hide theirs.
  const empty = frame.find("dash-bar-empty");
  assert.equal(empty[0].attrs.opacity, "0");
  assert.equal(empty[3].attrs.opacity, "1");
});

test("ring segments sum to a full turn minus the gaps", () => {
  const p = parent();
  Charts.ring(p, [{ value: 1 }, { value: 1 }, { value: 2 }], {
    size: 100,
    gapDeg: 0,
  });
  const segs = p.children[0].find("dash-ring-seg");
  assert.equal(segs.length, 3, "one path per segment");
  for (const s of segs) assert.ok(!/NaN/.test(s.d), `NaN in ring: ${s.d}`);
  // Stroked arcs, not filled wedges: a stroke gets round caps for free.
  for (const s of segs) assert.equal(s.attrs.fill, undefined);
});

test("ring skips segments smaller than the separator gap", () => {
  const p = parent();
  // One value is 0.01% of the total: its own gap exceeds its sweep.
  Charts.ring(p, [{ value: 100000 }, { value: 1 }], {
    size: 100,
    gapDeg: 1.2,
  });
  const segs = p.children[0].find("dash-ring-seg");
  // The node is created up front (the ring reuses its paths across frames),
  // so "skipped" means an empty path rather than a missing one.
  assert.equal(segs.length, 2);
  assert.equal(segs[1].d, "", "the vanishing segment must not invert an arc");
  assert.ok(segs[0].d, "the surviving segment still draws");
});

test("ring honours an explicit total so a lone value is a meter", () => {
  // The memory card passes total: 100 — one used arc over a full track. Without
  // it the single segment would sweep the whole circle.
  const p = parent();
  Charts.ring(p, [{ value: 42, class: "dash-ring-used" }], {
    size: 100,
    total: 100,
    gapDeg: 0,
    center: { value: "42%", label: "内存" },
  });
  const frame = p.children[0];
  const seg = frame.find("dash-ring-used");
  assert.equal(seg.length, 1);
  // An arc of 42% of the circle is under 180°, so the large-arc flag is 0.
  assert.ok(
    /A[\d.]+ [\d.]+ 0 0 1/.test(seg[0].d),
    `expected small arc: ${seg[0].d}`,
  );
  const values = frame.find("dash-ring-value");
  assert.equal(values.length, 1, "centre value rendered");
  assert.equal(values[0].textContent, "42%");
});

test("gauge clamps out-of-range and non-finite values", () => {
  const p = parent();
  Charts.gauge(p, 999, { min: 0, max: 100 });
  const values = p.children[0].find("dash-gauge-value");
  assert.equal(values.length, 1, "a value arc is drawn");
  assert.ok(!/NaN/.test(values[0].d), `NaN in gauge: ${values[0].d}`);

  const p2 = parent();
  Charts.gauge(p2, null, {});
  assert.equal(
    p2.children[0].find("dash-gauge-value")[0].d,
    "",
    "a null reading draws no value arc",
  );
});

test("rankBar scales to the value and hides a zero bar", () => {
  const p = parent();
  Charts.rankBar(p, 5, 10);
  const frame = p.children[0];
  assert.equal(frame.attrs.viewBox, "0 0 100 4");
  const bar = frame.find("dash-rank-bar")[0];
  assert.equal(bar.attrs.x2, "50", "half the track for half the value");
  // Round caps need an unscaled stroke or they turn into ellipses.
  assert.equal(bar.attrs["vector-effect"], "non-scaling-stroke");

  const p2 = parent();
  Charts.rankBar(p2, 0, 10);
  assert.equal(
    p2.children[0].find("dash-rank-bar")[0].attrs.visibility,
    "hidden",
    "a zero row must not draw a round dot",
  );
});

test("heatStrip buckets into the ordinal step scale", () => {
  const p = parent();
  Charts.heatStrip(p, [0, 25, 50, 75, 100], { w: 100, h: 8 });
  const cells = p.children[0].find("dash-heat-cell");
  assert.equal(cells.length, 5);
  // The step classes must be ordered, not all identical.
  const classes = cells.map((c) => c.attrs.class);
  assert.notEqual(classes[0], classes[classes.length - 1]);
});

test("a tween starts from the previous sample", () => {
  // Two successive paints under the same key: the first is the seed, the
  // second must animate rather than jump. The harness resolves the tween
  // synchronously, so the observable is that the geometry still lands on the
  // new value and the memory kept the old one.
  const key = "tween-test";
  const p1 = parent();
  Charts.bars(p1, [{ value: 10 }, { value: 10 }], { w: 100, h: 34, key });
  const p2 = parent();
  Charts.bars(p2, [{ value: 20 }, { value: 20 }], { w: 100, h: 34, key });
  const bars = p2.children[0].find("dash-bar");
  const top = Math.min(...ys(bars[0].d));
  assert.ok(top < 1, `the taller bar must reach the top: ${top}`);

  // reset() drops the memory, so the next paint is a first paint again.
  Charts.reset();
  const p3 = parent();
  Charts.bars(p3, [{ value: 20 }], { w: 100, h: 34, key });
  assert.ok(p3.children[0].find("dash-bar")[0].d);
});

test("reduced motion draws the final geometry without a tween", () => {
  const still = load({ reduced: true });
  const p = parent();
  still.sparkline(p, [1, 2, 3, 4], { h: 34, key: "rm" });
  assert.ok(!/dash-enter/.test(p.children[0].attrs.class ?? ""));
  assert.ok(p.children[0].find("dash-line")[0].d.startsWith("M"));
});

test("chart source keeps the colour rules it can still prove", () => {
  // Guards adr/0003, adr/0004 and adr/0009 at the source level, where a stray
  // gradient function would otherwise only show up in a built stylesheet. The
  // rules are explained in the file's own comments, so the assertions run
  // against the code with comments stripped — otherwise every rule would trip
  // on the paragraph describing it.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  assert.ok(
    !/(?:linear|radial|conic)-gradient\(/.test(code),
    "no CSS gradient function may appear in chart code",
  );
  assert.ok(!/createElement\(["']canvas/.test(code), "no canvas");
  assert.ok(!/getContext\(/.test(code), "no canvas/WebGL context");
  // adr/0008: the isometric projection is gone, so no sheared faces remain.
  assert.ok(!/isoBars|dash-iso/.test(code), "no isometric projection");

  // adr/0009 allows one SVG gradient — the area fill — but only as a paint
  // server whose colours come from CSS. A colour literal on a stop (or on any
  // chart attribute) would move colour ownership into JS, which is the thing
  // adr/0003 actually protects. So: the element may exist, `stop-color` may
  // not.
  assert.ok(
    !/stop-color|stopColor/.test(code),
    "stop colours must come from CSS classes, not chart code",
  );
  // And the gradient must stay scoped to fills: a gradient on a stroke would
  // put a fade on a line, which no design here asks for.
  assert.ok(!/stroke:\s*`?url\(#/.test(code), "no gradient on a stroke");
});
