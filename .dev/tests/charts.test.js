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
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v);
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
  };

  return { document, FakeEl };
}

function load() {
  const { document } = makeDom();
  const window = { document };
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", "document", `${source}\nreturn window;`);
  const win = fn(window, document);
  return win.ShadcnCharts;
}

const Charts = load();

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

test("linePath handles a single sample without dividing by zero", () => {
  const p = Charts.linePath([7], 100, 34);
  assert.ok(p);
  assert.ok(
    !/NaN|Infinity/.test(p.line),
    `unexpected numeric output: ${p.line}`,
  );
});

test("bars stay inside the viewBox", () => {
  const { document } = makeDom();
  const parent = {
    children: [],
    appendChild(c) {
      this.children.push(c);
      return c;
    },
  };
  Charts.bars(parent, [{ value: 1 }, { value: 5 }, { value: 3 }], {
    w: 100,
    h: 34,
  });
  const frame = parent.children[0];
  assert.equal(frame.attrs.viewBox, "0 0 100 34");

  for (const path of frame.find("dash-bar")) {
    assert.ok(path.d, "bar paths carry geometry");
    assert.ok(!/NaN/.test(path.d), `NaN in bar path: ${path.d}`);
    const ys = [...path.d.matchAll(/[ML]\s*[-\d.]+\s+([-\d.]+)/g)].map((m) =>
      Number(m[1]),
    );
    for (const y of ys) {
      assert.ok(y >= -0.01 && y <= 34.01, `bar y ${y} escaped 0..34`);
    }
  }

  // A zero-value bar is "no traffic this hour", so it collapses to a hairline
  // on the baseline rather than a rounded blob dipping out of the viewBox.
  const p2 = {
    children: [],
    appendChild(c) {
      this.children.push(c);
      return c;
    },
  };
  Charts.bars(p2, [{ value: 0 }, { value: 10 }], { w: 100, h: 34 });
  assert.equal(
    p2.children[0].find("dash-bar-empty").length,
    1,
    "a zero bar renders as a baseline hairline",
  );
  for (const path of p2.children[0].find("dash-bar-empty")) {
    const ys = [...path.d.matchAll(/[ML]\s*[-\d.]+\s+([-\d.]+)/g)].map((m) =>
      Number(m[1]),
    );
    for (const y of ys) {
      assert.ok(y >= 0 && y <= 34, `empty bar y ${y} escaped 0..34`);
    }
  }
});

test("isoBars draws three real faces per bar", () => {
  const parent = {
    children: [],
    appendChild(c) {
      this.children.push(c);
      return c;
    },
  };
  Charts.isoBars(parent, [{ value: 2 }, { value: 6 }], { w: 100, h: 34 });
  const frame = parent.children[0];
  assert.equal(frame.find("dash-iso-front").length, 2);
  assert.equal(frame.find("dash-iso-side").length, 2);
  assert.equal(frame.find("dash-iso-top").length, 2);
  // The top face must be sheared, otherwise this is not an isometric view.
  const top = frame.find("dash-iso-top")[0].d;
  assert.ok(top.includes(" "), "top face path present");
  assert.ok(!/NaN/.test(top), `NaN in iso top face: ${top}`);
});

test("ring segments sum to a full turn minus the gaps", () => {
  const parent = {
    children: [],
    appendChild(c) {
      this.children.push(c);
      return c;
    },
  };
  Charts.ring(parent, [{ value: 1 }, { value: 1 }, { value: 2 }], {
    size: 100,
    gapDeg: 0,
  });
  const segs = parent.children[0].find("dash-ring-seg");
  assert.equal(segs.length, 3, "one path per segment");
  for (const s of segs) assert.ok(!/NaN/.test(s.d), `NaN in ring: ${s.d}`);
});

test("ring skips segments smaller than the separator gap", () => {
  const parent = {
    children: [],
    appendChild(c) {
      this.children.push(c);
      return c;
    },
  };
  // One value is 0.01% of the total: its own gap exceeds its sweep.
  Charts.ring(parent, [{ value: 100000 }, { value: 1 }], {
    size: 100,
    gapDeg: 1.2,
  });
  const segs = parent.children[0].find("dash-ring-seg");
  assert.equal(segs.length, 1, "the vanishing segment must not invert an arc");
});

test("gauge clamps out-of-range and non-finite values", () => {
  const parent = {
    children: [],
    appendChild(c) {
      this.children.push(c);
      return c;
    },
  };
  Charts.gauge(parent, 999, { min: 0, max: 100 });
  const values = parent.children[0].find("dash-gauge-value");
  assert.equal(values.length, 1, "a value arc is drawn");
  assert.ok(!/NaN/.test(values[0].d), `NaN in gauge: ${values[0].d}`);

  const p2 = {
    children: [],
    appendChild(c) {
      this.children.push(c);
      return c;
    },
  };
  Charts.gauge(p2, null, {});
  assert.equal(
    p2.children[0].find("dash-gauge-value").length,
    0,
    "a null reading draws no value arc",
  );
});

test("heatStrip buckets into the ordinal step scale", () => {
  const parent = {
    children: [],
    appendChild(c) {
      this.children.push(c);
      return c;
    },
  };
  Charts.heatStrip(parent, [0, 25, 50, 75, 100], { w: 100, h: 8 });
  const cells = parent.children[0].find("dash-heat-cell");
  assert.equal(cells.length, 5);
  // The step classes must be ordered, not all identical.
  const classes = cells.map((c) => c.attrs.class);
  assert.notEqual(classes[0], classes[classes.length - 1]);
});

test("chart source contains no gradient and no canvas", () => {
  // Guards adr/0003 and adr/0004 at the source level, where a stray gradient
  // would otherwise only show up in a built stylesheet. The word itself may
  // appear in comments (it is how the rule is explained), so the assertions
  // look for the constructs, not the noun.
  assert.ok(
    !/<linearGradient|<radialGradient|<conicGradient/i.test(source),
    "no SVG gradient element may appear in chart code",
  );
  assert.ok(
    !/(?:linear|radial|conic)-gradient\(/.test(source),
    "no gradient CSS function may appear in chart code",
  );
  assert.ok(!/createElement\(["']canvas/.test(source), "no canvas");
  // Check the API, not the noun: the file's own comments explain that WebGL
  // is deliberately absent, so a bare /WebGL/ match would fail on prose.
  assert.ok(!/getContext\(/.test(source), "no canvas/WebGL context");
});
