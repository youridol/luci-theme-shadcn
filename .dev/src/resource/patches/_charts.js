"use strict";
/* Hand-written SVG chart primitives for the Overview dashboard.

   Why hand-written (see .dev/docs/adr/0004-handwritten-svg-charts.md):
   patches are copied through terser, not bundled by Rollup, so a chart
   library cannot be imported here. Each primitive below is therefore just
   "array of numbers → path/rect strings", which is a few lines apiece.

   House rules these enforce by construction:
   - pure SVG, no canvas, no WebGL — every shape is a DOM node the theme's
     tokens can colour;
   - no CSS gradients (.dev/docs/adr/0003-no-gradients.md). The one exception
     is a series' area fill, which uses an SVG `<linearGradient>` from the
     series colour to transparent (adr/0009): the stop colours still come from
     CSS classes on the stops, so no colour literal enters the chart code and
     the built stylesheet stays free of gradient functions;
   - no 3D projection (.dev/docs/adr/0008-chart-motion-and-flat-bars.md): the
     hourly bars are flat rounded columns with a rail, not three sheared faces.

   Motion (.dev/docs/adr/0008): charts morph between samples instead of being
   redrawn from scratch. The dashboard rebuilds its card bodies on every poll,
   so a CSS entrance animation would replay once a second and flicker; instead
   each primitive remembers the previous numbers under a caller-supplied key
   and tweens the geometry over one short frame budget. `prefers-reduced-motion`
   skips the tween and writes the final geometry on the first frame.

   Every function returns a string of SVG markup, a coordinate array, or the
   frame element; none of them touch the document except `svg()`. */

(function (global) {
  const NS = "http://www.w3.org/2000/svg";

  // ── motion ───────────────────────────────────────────────────────────

  // One tween budget for every primitive. The fast path polls at 1 s by
  // default, so 420 ms leaves the curve settled for more than half of each
  // interval — long enough to read as motion, short enough never to lag the
  // next sample.
  const DURATION = 420;

  // key → { kind, values }: the last numbers a chart was asked to draw. The
  // card bodies are rebuilt on every poll, so this is the only thing that
  // survives a re-render.
  const memory = new Map();

  function reduceMotion() {
    try {
      return Boolean(
        global.matchMedia &&
        global.matchMedia("(prefers-reduced-motion: reduce)").matches,
      );
    } catch (e) {
      return false;
    }
  }

  // Ease-out cubic: fast start, soft landing — the shape readers expect from
  // a value that "arrived" rather than one that is still travelling.
  function ease(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  /* Run `step(progress)` on every animation frame for DURATION ms.
     Without a frame clock (unit tests, very old browsers) or with reduced
     motion requested, `step(1)` runs once synchronously, so callers always
     end up with the final geometry. Returns a cancel function. */
  function animate(step, done) {
    if (reduceMotion() || typeof global.requestAnimationFrame !== "function") {
      step(1);
      if (done) done();
      return function () {};
    }

    let start = null;
    let raf = 0;

    function tick(now) {
      if (start == null) start = now;
      const t = Math.min(1, (now - start) / DURATION);
      step(ease(t));
      if (t < 1) raf = global.requestAnimationFrame(tick);
      else if (done) done();
    }

    raf = global.requestAnimationFrame(tick);
    return function () {
      if (raf && typeof global.cancelAnimationFrame === "function")
        global.cancelAnimationFrame(raf);
      raf = 0;
    };
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // Element-wise interpolation that keeps gaps as gaps. A sample that appears
  // for the first time is drawn at its target value rather than flying in from
  // zero — inventing a value the device never reported is exactly the mistake
  // `linePath` refuses to make.
  function lerpSeries(from, to, t) {
    const out = new Array(to.length);
    for (let i = 0; i < to.length; i++) {
      const b = to[i];
      if (b == null || !isFinite(b)) {
        out[i] = null;
        continue;
      }
      const a = from ? from[i] : null;
      out[i] = a == null || !isFinite(a) ? b : lerp(a, b, t);
    }
    return out;
  }

  // Remember `next` under `key` and hand back what was there before, or null
  // when this is the first paint. A different chart kind under the same key
  // (a card switching from a ring to a line) never tweens across shapes.
  //
  // The map is bounded: keys include per-host ones (`host:192.168.3.238`), and
  // a page left open across a DHCP churn would otherwise accumulate one entry
  // per address it ever saw. 96 is far above the ~20 live charts and still
  // evicts the oldest entries first (Map keeps insertion order).
  const MEMORY_LIMIT = 96;

  function remember(key, kind, next) {
    if (!key) return null;
    const prev = memory.get(key);
    memory.delete(key);
    memory.set(key, { kind, values: next.slice() });
    if (memory.size > MEMORY_LIMIT) {
      const oldest = memory.keys().next();
      if (!oldest.done) memory.delete(oldest.value);
    }
    if (!prev || prev.kind !== kind) return null;
    return prev.values;
  }

  function reset() {
    memory.clear();
  }

  // ── numbers ──────────────────────────────────────────────────────────

  // Two decimal places, then trailing zeros dropped. Chart coordinates are
  // fractions of a viewBox, so 2dp is well below one device pixel even at
  // 3x scale, while keeping the markup readable.
  function n(v) {
    if (!isFinite(v)) return "0";
    const r = Math.round(v * 100) / 100;
    return String(r);
  }

  // Safe min/max over a series that may contain nulls (a gap in sampling).
  function extent(values) {
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
      if (v == null || !isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === Infinity) return { min: 0, max: 1 };
    // A flat series would collapse to zero height; give it a nominal span so
    // it renders on the centre line instead of along the baseline.
    if (max - min < 1e-9) {
      const c = min;
      min = c - 1;
      max = c + 1;
    }
    return { min, max };
  }

  // ── frame ────────────────────────────────────────────────────────────

  // Build an <svg> with a fixed viewBox. `preserveAspectRatio="none"` is the
  // default for stretchy sparklines; callers that need true proportions
  // (rings, gauges) pass aspect: true.
  function svg(opts) {
    const o = opts ?? {};
    const el = document.createElementNS(NS, "svg");
    el.setAttribute("viewBox", o.viewBox ?? "0 0 100 34");
    el.setAttribute("preserveAspectRatio", o.aspect ? "xMidYMid meet" : "none");
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("class", o.class ?? "shadcn-dash-chart");
    if (o.width) el.setAttribute("width", String(o.width));
    if (o.height) el.setAttribute("height", String(o.height));
    return el;
  }

  function add(parent, tag, attrs) {
    const el = document.createElementNS(NS, tag);
    for (const k in attrs ?? {}) el.setAttribute(k, attrs[k]);
    parent.appendChild(el);
    return el;
  }

  function set(el, attrs) {
    if (!el) return;
    for (const k in attrs) {
      const v = attrs[k];
      // `null` means "no such attribute" — setAttribute would write the string
      // "null" and, for `transform`, shift the element by nothing but leave a
      // property that a later tween could pick up.
      if (v == null) el.removeAttribute(k);
      else el.setAttribute(k, v);
    }
  }

  // ── area gradients ───────────────────────────────────────────────────

  // Unique ids per gradient. A document-wide counter is enough: the dashboard
  // is one page and the charts are rebuilt on every poll, so ids only have to
  // be unique among the frames that currently exist.
  let gradientSeq = 0;

  /* A vertical fade from the series colour to transparent, built as an SVG
     paint server rather than a CSS gradient.

     The colours come from CSS classes on the `<stop>` elements: each stop is
     `stop-color: currentColor`, and the `<linearGradient>` carries the series
     tone class, so `color` inherits down and the stylesheet still owns every
     colour. `scripts/check-built-css.js` therefore keeps finding zero gradient
     functions in the shipped stylesheet — the rule it guards is "no CSS
     gradients", and this is a different mechanism (adr/0009).

     The gradient is anchored to the area path's own bounding box (the default
     `objectBoundingBox`), not to the plot box. That is what makes a series
     that hugs the baseline still show a tint right under its line: the fade
     runs over the height of *its own* fill, so its brightest end always meets
     the curve. Anchoring to the plot box instead put the bright end at the
     chart's top edge, where a low series never reaches. */
  function areaGradient(frame, tone) {
    const id = `dash-grad-${++gradientSeq}`;
    const defs = add(frame, "defs", {});
    const grad = add(defs, "linearGradient", {
      id,
      class: `dash-grad dash-grad-${tone}`,
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 1,
    });
    add(grad, "stop", { offset: "0%", class: "dash-stop-top" });
    add(grad, "stop", { offset: "55%", class: "dash-stop-mid" });
    add(grad, "stop", { offset: "100%", class: "dash-stop-end" });
    return `url(#${id})`;
  }

  /* Round a maximum up to a readable step, so axis labels land on round
     numbers (0 / 50 / 100 rather than 0 / 46.6 / 93.1).

     Steps are 1/2/5 × 1024^k, matching the binary units the rate formatter
     prints. A decimal 1e11 rounded maximum would be printed as "93.1G" by a
     1024-based formatter, so the rounding would buy nothing; a plain
     power-of-two step overshoots badly (86.7 GiB → 128 GiB), which wastes half
     the plot. 1/2/5 keeps the top tick both round and close to the data. */
  function niceMax(v) {
    if (!(v > 0) || !isFinite(v)) return 1;
    let unit = 1;
    while (unit * 1024 <= v) unit *= 1024;
    const m = v / unit;
    for (const step of [1, 2, 5, 10, 20, 50, 100, 200, 500]) {
      if (step >= m) return step * unit;
    }
    // Nothing under 1000 fits: promote a whole binary magnitude instead of
    // printing a "1000K" top tick.
    return 1024 * unit;
  }

  // ── curve geometry ───────────────────────────────────────────────────

  /* Monotone cubic (Fritsch–Carlson) through points with a uniform x step.

     A plain Catmull-Rom spline overshoots at spikes, which on a CPU or rate
     chart invents values that were never measured — a dip below zero looks
     like a bug in the data. The monotone variant clamps the tangents so the
     curve stays inside the segment it interpolates, which is also why the
     area fill can never poke below the baseline.

     Returns { start, cmds } so the caller can build a line path and an area
     path from the same geometry. */
  function smoothRun(points) {
    if (points.length === 1)
      return { start: points[0], cmds: "", end: points[0] };

    const dx = points[1][0] - points[0][0];
    const slopes = [];
    for (let i = 0; i < points.length - 1; i++)
      slopes.push((points[i + 1][1] - points[i][1]) / dx);

    // Two points: a straight segment is already monotone.
    if (points.length === 2)
      return {
        start: points[0],
        cmds: `L${n(points[1][0])} ${n(points[1][1])}`,
        end: points[1],
      };

    const m = [slopes[0]];
    for (let i = 1; i < points.length - 1; i++)
      m.push((slopes[i - 1] + slopes[i]) / 2);
    m.push(slopes[slopes.length - 1]);

    for (let i = 0; i < slopes.length; i++) {
      if (slopes[i] === 0) {
        m[i] = 0;
        m[i + 1] = 0;
        continue;
      }
      const a = m[i] / slopes[i];
      const b = m[i + 1] / slopes[i];
      const s = a * a + b * b;
      if (s > 9) {
        const k = 3 / Math.sqrt(s);
        m[i] = k * a * slopes[i];
        m[i + 1] = k * b * slopes[i];
      }
    }

    const h = dx / 3;
    let cmds = "";
    for (let i = 0; i < points.length - 1; i++) {
      cmds +=
        `C${n(points[i][0] + h)} ${n(points[i][1] + m[i] * h)} ` +
        `${n(points[i + 1][0] - h)} ${n(points[i + 1][1] - m[i + 1] * h)} ` +
        `${n(points[i + 1][0])} ${n(points[i + 1][1])}`;
    }

    return { start: points[0], cmds, end: points[points.length - 1] };
  }

  /* A polyline through the series, plus an optional filled area under it.

     Gaps (null entries) break the line instead of dropping to zero: a missing
     sample is not a measurement of 0, and drawing it as one invents a spike
     that never happened. */
  function linePath(values, w, h, opts) {
    const o = opts ?? {};
    if (!values || !values.length) return null;

    const range = o.range ?? extent(values);
    const span = range.max - range.min || 1;
    const step = values.length > 1 ? w / (values.length - 1) : w;
    const y = (v) => h - ((v - range.min) / span) * h;

    let line = "";
    let area = "";
    let last = null;
    let run = [];

    const flush = () => {
      if (!run.length) return;
      const geo = smoothRun(run);
      const d = `M${n(geo.start[0])} ${n(geo.start[1])}${geo.cmds}`;
      line += d;
      // The fill closes back to the baseline at both ends of this run. Built
      // from the same geometry as the stroke, so the two can never disagree.
      area +=
        `M${n(geo.start[0])} ${n(h)}L${n(geo.start[0])} ${n(geo.start[1])}` +
        geo.cmds +
        `L${n(geo.end[0])} ${n(h)}Z`;
      last = geo.end;
      run = [];
    };

    values.forEach((v, i) => {
      if (v == null || !isFinite(v)) {
        flush();
        return;
      }
      run.push([i * step, y(v)]);
    });
    flush();

    if (!line) return null;

    return { line, area: o.area === false ? null : area, range, last };
  }

  // ── line charts (sparkline / multi-series) ───────────────────────────

  /* Draw one or more line series into `parent`.

     All series share one y-range, so a download line and an upload line are
     directly comparable — the ports card needs exactly that.

     `opts.axis` turns the bare sparkline into a framed plot like the one the
     reference design shows: a y-axis with 0 / 25 / 50 … labels, dashed
     horizontal guides, a baseline, and a left gutter the curves do not run
     into. Without it the frame is the plain 100×h sparkline the metric tiles
     need, where any furniture would be noise.

     series: [{ values, lineClass?, areaClass?, tone?, key? }]
     opts:   { w, h, grid, dot, range, class, key, area, axis, yLabels, nice } */
  function lineChart(parent, series, opts) {
    const o = opts ?? {};
    const list = (series ?? []).filter((s) => s && s.values && s.values.length);
    if (!list.length) return null;

    const axis = o.axis ?? null;

    // The plot box. With an axis the label gutter lives outside the viewBox
    // (HTML, in the wrapper's padding), so the drawing area itself starts at
    // x=0; only the top/right insets are inside it, keeping the stroke from
    // being clipped by the frame edge.
    const w = o.w ?? 100;
    const h = o.h ?? 34;
    const padL = axis ? (o.padLeft ?? 0) : 0;
    const padR = axis ? (o.padRight ?? 1.5) : 0;
    const padT = axis ? (o.padTop ?? 3) : 0;
    const padB = axis ? (o.padBottom ?? 0) : 0;
    const plotW = Math.max(1, w - padL - padR);
    const plotH = Math.max(1, h - padT - padB);

    const all = [];
    for (const s of list) for (const v of s.values) all.push(v);
    let range = o.range ?? extent(all);
    /* A framed plot is read against zero; only a sparkline may float.
       `zero: true` extends that to a sparkline, and it is what keeps an area
       fill honest: a series that floats on its own min..max maps a 1%–7% CPU
       signal onto the full box height, so the area path covers the whole plot
       and the card reads as a solid mountain instead of a shallow wave. With a
       zero floor the fill's height is proportional to the value. */
    if ((axis || o.zero === true) && o.nice !== false)
      range = { min: 0, max: niceMax(range.max) };

    const frame = svg({
      viewBox: `0 0 ${w} ${h}`,
      class: o.class ?? "shadcn-dash-chart shadcn-dash-spark",
    });

    /* Guides are drawn before the data so a translucent fill can sit on top of
       them: a guide showing through the fill is what makes the area read as
       "the space under the curve" rather than "a coloured shape". */
    if (axis) {
      const ticks = o.ticks ?? 2;
      // Inner guides only — the baseline gets its own, stronger rule.
      let grid = "";
      for (let i = 1; i < ticks; i++) {
        const y = n(padT + (plotH * i) / ticks);
        grid += `M${n(padL)} ${y}L${n(w - padR)} ${y}`;
      }
      if (grid) add(frame, "path", { d: grid, class: "dash-axis-grid" });
      add(frame, "path", {
        d: `M${n(padL)} ${n(padT + plotH)}L${n(w - padR)} ${n(padT + plotH)}`,
        class: "dash-axis-base",
      });
      add(frame, "path", {
        d: `M${n(padL)} ${n(padT)}L${n(padL)} ${n(padT + plotH)}`,
        class: "dash-axis-y",
      });
    } else if (o.grid) {
      let d = "";
      for (let i = 1; i <= o.grid; i++) {
        const y = n((h * i) / (o.grid + 1));
        d += `M0 ${y}L${w} ${y}`;
      }
      add(frame, "path", { d, class: "dash-grid" });
    }

    // Areas first, then strokes: a later series' translucent fill must not
    // wash over an earlier series' line.
    const nodes = list.map((s, i) => {
      const tone = s.tone ?? (i === 0 ? "a" : i === 1 ? "b" : "c");
      let fill = null;
      if (o.area !== false && s.areaClass !== null) {
        fill = areaGradient(frame, tone);
      }
      const area = fill
        ? add(frame, "path", {
            class: s.areaClass ?? o.areaClass ?? `dash-area dash-area-${tone}`,
            d: "",
            fill,
          })
        : null;
      return {
        area,
        line: null,
        key: `${o.key ?? ""}|${s.key ?? i}`,
        lineClass: s.lineClass ?? o.lineClass ?? `dash-line dash-line-${tone}`,
      };
    });

    for (const node of nodes)
      node.line = add(frame, "path", {
        class: node.lineClass,
        d: "",
        pathLength: "1",
      });

    /* The endpoint marker is a stroked zero-length line with a round cap, not
       a <circle>: the frame stretches with `preserveAspectRatio="none"`, which
       would squash a circle into a wide ellipse (it rendered as a 28×12 blob
       at the right edge of the ports card). A round cap with
       `non-scaling-stroke` stays a true circle at any card width.

       The tone suffix (`-a`, `-b`, …) is what colours it: the marker has to
       match the series it terminates, and the last series is not always the
       same one. */
    const lastTone =
      list[list.length - 1].tone ?? (list.length > 1 ? "b" : "a");
    const dot =
      o.dot === false
        ? null
        : {
            halo: add(frame, "line", {
              class: `dash-dot-halo dash-dot-${lastTone}`,
              x1: 0,
              y1: 0,
              x2: 0,
              y2: 0.01,
            }),
            dot: add(frame, "line", {
              class: `dash-dot dash-dot-${lastTone}`,
              x1: 0,
              y1: 0,
              x2: 0,
              y2: 0.01,
            }),
          };

    /* Axis labels are HTML, not SVG <text>.

       The frame uses `preserveAspectRatio="none"` so the chart fills any card
       width. That is right for geometry and wrong for glyphs: on a wide card
       the horizontal scale can be twice the vertical one, and the labels come
       out visibly wide and squat. HTML text is laid out by the browser at the
       real font size, so it stays crisp at any card width.

       So an axis chart is wrapped: `.shadcn-dash-plot` holds the SVG plus an
       absolutely-positioned label column. Each label sits at the exact
       fraction of the plot height where its gridline runs, so label and guide
       cannot drift apart. */
    let plot = null;
    if (axis) {
      const ticks = o.ticks ?? 2;
      const fmt = o.yLabels ?? ((v) => String(Math.round(v)));
      plot = document.createElement("div");
      plot.setAttribute("class", "shadcn-dash-plot");
      const inner = document.createElement("div");
      inner.setAttribute("class", "shadcn-dash-plot-inner");
      inner.appendChild(frame);
      plot.appendChild(inner);

      const col = document.createElement("div");
      col.setAttribute("class", "shadcn-dash-plot-labels");
      for (let i = 0; i <= ticks; i++) {
        const value = range.max - ((range.max - range.min) * i) / ticks;
        const label = document.createElement("span");
        label.setAttribute("class", "dash-axis-label");
        label.setAttribute(
          "style",
          `top:${n(((padT + (plotH * i) / ticks) / h) * 100)}%`,
        );
        label.textContent = fmt(value);
        col.appendChild(label);
      }
      // Inside the drawing area, hung to its left: the column then shares the
      // SVG's exact height, so a percentage `top` lands on the same line the
      // guide is drawn at.
      inner.appendChild(col);

      /* Horizontal axis: first and last tick only. A dense time axis on a
         card-width chart turns into a smear, and the two ends are what a
         reader actually checks ("how far back does this go?"). */
      const xs = o.xLabels;
      if (xs && xs.length) {
        const row = document.createElement("div");
        row.setAttribute("class", "shadcn-dash-plot-times");
        for (let i = 0; i < xs.length; i++) {
          const t = document.createElement("span");
          t.setAttribute("class", "dash-axis-label");
          t.textContent = xs[i];
          row.appendChild(t);
        }
        plot.appendChild(row);
      }

      parent.appendChild(plot);
    } else {
      parent.appendChild(frame);
    }

    const draw = (values) => {
      let lastPoint = null;
      nodes.forEach((node, i) => {
        const p = linePath(values[i], plotW, plotH, { range, area: o.area });
        if (!p) {
          set(node.line, { d: "" });
          set(node.area, { d: "" });
          return;
        }
        // Shift the geometry into the plot box. Building it at 0..plotW and
        // translating here keeps linePath free of layout knowledge.
        const shift = `translate(${n(padL)} ${n(padT)})`;
        set(node.line, { d: p.line, transform: axis ? shift : null });
        set(node.area, { d: p.area ?? "", transform: axis ? shift : null });
        if (i === nodes.length - 1) lastPoint = p.last;
      });

      if (dot) {
        if (lastPoint) {
          const x = lastPoint[0] + padL;
          const y = lastPoint[1] + padT;
          set(dot.dot, { x1: n(x), y1: n(y), x2: n(x + 0.01), y2: n(y) });
          set(dot.halo, { x1: n(x), y1: n(y), x2: n(x + 0.01), y2: n(y) });
        } else {
          set(dot.dot, { visibility: "hidden" });
          set(dot.halo, { visibility: "hidden" });
        }
      }
    };

    const from = list.map((s, i) =>
      remember(`${o.key ?? ""}|${s.key ?? i}`, "line", s.values),
    );
    const first = from.every((f) => f == null);

    // A first paint draws itself in with a stroke-dash animation (one-shot;
    // later polls never re-add the class). The class is dropped once the
    // animation has had time to finish: if the browser never runs it (an
    // animation-disabled build, a background tab), leaving the class on would
    // keep the line at `stroke-dashoffset: 1` — invisible — until the next
    // poll replaced the frame.
    if (first && !reduceMotion()) {
      const baseClass = frame.getAttribute("class");
      frame.setAttribute("class", `${baseClass} dash-enter`);
      if (typeof global.setTimeout === "function")
        global.setTimeout(() => frame.setAttribute("class", baseClass), 700);
    }

    draw(list.map((s) => s.values));

    if (!first) {
      const froms = list.map((s, i) => from[i] ?? s.values);
      animate((t) =>
        draw(froms.map((f, i) => lerpSeries(f, list[i].values, t))),
      );
    }

    return frame;
  }

  // A single call that renders a sparkline into `parent`.
  //
  // `classes` supplies the stroke and fill classes so the patch stylesheet
  // owns every colour (no hardcoded value ever enters a chart path).
  // `opts.axis` promotes it to a framed plot — see lineChart.
  function sparkline(parent, values, opts) {
    const o = opts ?? {};
    return lineChart(
      parent,
      [
        {
          values,
          lineClass: o.lineClass,
          areaClass: o.areaClass,
          tone: o.tone ?? "a",
          key: "0",
        },
      ],
      o,
    );
  }

  // Two series over one shared scale — the ports card's download/upload pair.
  function multiLine(parent, series, opts) {
    return lineChart(parent, series, opts);
  }

  // ── bars ─────────────────────────────────────────────────────────────

  // A bar from `base` upwards, with the top corners rounded. `r` is clamped
  // to half the width and half the height: a bar shorter than its own radius
  // would otherwise draw a curve that dips below the baseline (a zero-value
  // bar once came out as "M3 34 L3 35.2").
  function barPath(x, base, w, h, r) {
    if (!(h > 0.01)) return null;
    const yTop = base - h;
    const rr = Math.max(0, Math.min(r, w / 2, h));
    if (rr <= 0.01)
      return `M${n(x)} ${n(base)}L${n(x)} ${n(yTop)}L${n(x + w)} ${n(yTop)}L${n(x + w)} ${n(base)}Z`;
    return (
      `M${n(x)} ${n(base)}L${n(x)} ${n(yTop + rr)}` +
      `Q${n(x)} ${n(yTop)} ${n(x + rr)} ${n(yTop)}` +
      `L${n(x + w - rr)} ${n(yTop)}` +
      `Q${n(x + w)} ${n(yTop)} ${n(x + w)} ${n(yTop + rr)}` +
      `L${n(x + w)} ${n(base)}Z`
    );
  }

  /* Vertical bars in a 0..100 wide box. `bars` is [{ value, label? }].

     Heights are anchored at zero, not at the series minimum: a bar chart
     encodes magnitude, so a quiet hour must look short rather than being
     stretched to fill the box. */
  function bars(parent, items, opts) {
    const o = opts ?? {};
    const w = o.w ?? 100;
    const h = o.h ?? 34;
    const list = items ?? [];
    if (!list.length) return null;

    const values = list.map((it) => {
      const v = typeof it === "number" ? it : it && it.value;
      return v == null || !isFinite(v) ? null : v;
    });
    const max = Math.max(0, ...values.filter((v) => v != null));

    const gap = o.gap ?? 0.24;
    const slot = w / list.length;
    const barW = slot * (1 - gap);
    const radius = o.radius ?? 1.6;

    const frame = svg({
      viewBox: `0 0 ${w} ${h}`,
      class: o.class ?? "shadcn-dash-chart shadcn-dash-bars",
    });

    const nodes = list.map((it, i) => {
      const x = i * slot + (slot - barW) / 2;
      if (o.track)
        add(frame, "path", {
          d: barPath(x, h, barW, h, barW / 2) ?? "",
          class: "dash-bar-track",
        });
      return {
        x,
        bar: add(frame, "path", { d: "", class: o.barClass ?? "dash-bar" }),
        empty:
          o.empty === false
            ? null
            : add(frame, "path", {
                d:
                  `M${n(x)} ${n(h - 0.6)}L${n(x + barW)} ${n(h - 0.6)}` +
                  `L${n(x + barW)} ${n(h)}L${n(x)} ${n(h)}Z`,
                class: o.emptyClass ?? "dash-bar-empty",
              }),
      };
    });

    parent.appendChild(frame);

    const draw = (vals) => {
      nodes.forEach((node, i) => {
        const v = vals[i];
        const ratio = max > 0 && v != null ? Math.max(0, v) / max : 0;
        const barH = ratio * h;
        const d = barPath(node.x, h, barW, barH, radius);
        if (!d) {
          set(node.bar, { d: "" });
          set(node.empty, { opacity: 1 });
          return;
        }
        set(node.bar, { d });
        // A real bar sits on top of the hairline; the hairline stays for the
        // empty slots only.
        set(node.empty, { opacity: 0 });
      });
    };

    const prev = remember(o.key, "bars", values);
    const first = prev == null;
    draw(first ? values.map(() => 0) : values);

    if (!first) animate((t) => draw(lerpSeries(prev, values, t)));
    else if (!reduceMotion())
      animate((t) => draw(values.map((v) => (v == null ? null : v * t))));

    return frame;
  }

  /* Hourly traffic columns: a faint rail per slot, a rounded bar in front,
     and the busiest hour lifted out with its own class.

     This replaced the isometric three-face bars of adr/0007. The rail is what
     makes a 24-column chart readable at a glance: every hour keeps its slot
     even when it has no traffic, so the reader compares heights instead of
     counting gaps. */
  function hourBars(parent, items, opts) {
    const o = opts ?? {};
    const w = o.w ?? 100;
    const h = o.h ?? 44;
    const list = items ?? [];
    if (!list.length) return null;

    const values = list.map((it) => {
      if (it == null) return null;
      if (typeof it === "number") return isFinite(it) ? it : null;
      if (it.empty) return null;
      const v = it.value;
      return v == null || !isFinite(v) ? null : v;
    });
    const max = Math.max(0, ...values.filter((v) => v != null));
    let peak = -1;
    if (o.peak !== false && max > 0) peak = values.findIndex((v) => v === max);

    const gap = o.gap ?? 0.34;
    const slot = w / list.length;
    const barW = slot * (1 - gap);
    const radius = o.radius ?? Math.min(barW / 2, 2.4);

    const frame = svg({
      viewBox: `0 0 ${w} ${h}`,
      class: o.class ?? "shadcn-dash-chart shadcn-dash-hours",
    });

    const nodes = list.map((it, i) => {
      const x = i * slot + (slot - barW) / 2;
      add(frame, "path", {
        d: barPath(x, h, barW, h, barW / 2) ?? "",
        class: "dash-hour-rail",
      });
      return {
        x,
        bar: add(frame, "path", {
          d: "",
          class:
            i === peak
              ? `${o.barClass ?? "dash-bar"} dash-bar-peak`
              : (o.barClass ?? "dash-bar"),
        }),
        empty: add(frame, "path", {
          d:
            `M${n(x)} ${n(h - 0.7)}L${n(x + barW)} ${n(h - 0.7)}` +
            `L${n(x + barW)} ${n(h)}L${n(x)} ${n(h)}Z`,
          class: o.emptyClass ?? "dash-bar-empty",
        }),
      };
    });

    parent.appendChild(frame);

    const draw = (vals) => {
      nodes.forEach((node, i) => {
        const v = vals[i];
        const ratio = max > 0 && v != null ? Math.max(0, v) / max : 0;
        const d = barPath(node.x, h, barW, ratio * h, radius);
        set(node.bar, { d: d ?? "" });
        set(node.empty, { opacity: d ? 0 : 1 });
      });
    };

    const prev = remember(o.key, "hours", values);
    const first = prev == null;
    draw(first ? values.map(() => 0) : values);

    if (!first) animate((t) => draw(lerpSeries(prev, values, t)));
    else if (!reduceMotion())
      animate((t) => draw(values.map((v) => (v == null ? null : v * t))));

    return frame;
  }

  // ── ring / donut ─────────────────────────────────────────────────────

  /* A donut from [{ value, class?, key? }]. Segments are stroked arcs on a
     shared centreline: a stroke gives round caps and a uniform thickness for
     free, and the separator is a real angular gap rather than a drawn line
     that would need a colour fighting the segment behind it.

     `opts.total` fixes the denominator. Without it the ring is a share-of-sum
     donut (the protocol split); with it the ring becomes a single-value meter
     — one used arc over a full track (the memory card), where a lone segment
     must not sweep the whole circle just because it is the only one. */
  function ring(parent, items, opts) {
    const o = opts ?? {};
    const size = o.size ?? 100;
    const thickness = o.thickness ?? Math.max(size * 0.14, 4);
    const cap = o.cap ?? "butt";
    const pad = thickness / 2 + (cap === "round" ? thickness * 0.35 : 0) + 1;
    const r = Math.max(2, size / 2 - pad);
    const cx = size / 2;
    const cy = size / 2;

    const list = (items ?? []).filter(
      (it) => it && isFinite(it.value) && it.value > 0,
    );
    if (!list.length) return null;

    const sum = list.reduce((s, it) => s + it.value, 0);
    const total = o.total != null && o.total > 0 ? o.total : sum;
    const gapDeg = o.gapDeg ?? 2;

    const frame = svg({
      viewBox: `0 0 ${size} ${size}`,
      aspect: true,
      class: o.class ?? "shadcn-dash-chart shadcn-dash-ring",
    });

    const pt = (deg) => {
      const rad = ((deg - 90) * Math.PI) / 180;
      return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
    };

    const arc = (from, to) => {
      const [x0, y0] = pt(from);
      const [x1, y1] = pt(to);
      const large = to - from > 180 ? 1 : 0;
      return `M${n(x0)} ${n(y0)}A${n(r)} ${n(r)} 0 ${large} 1 ${n(x1)} ${n(y1)}`;
    };

    // A hairline track keeps the donut legible when every value is tiny.
    // `butt` caps, not the segment cap: a round-capped 359.99° track puts two
    // caps face to face at 12 o'clock and bulges out by half a thickness
    // (13px on the protocol ring).
    add(frame, "path", {
      d: arc(0, 359.99),
      class: "dash-ring-track",
      "stroke-width": n(thickness),
    });

    const group = add(frame, "g", { class: "dash-ring-segs" });

    /* One path per item, created once. The ring re-tweens on every poll, so
       rebuilding the group per frame would churn nodes for no gain; a frame
       only rewrites each path's `d`. An item whose sweep collapses to nothing
       keeps its node with an empty `d`, which draws nothing. */
    const segs = list.map((it, i) =>
      add(group, "path", {
        class: it.class ?? o.segmentClass ?? "dash-ring-seg",
        "data-index": String(i),
        "stroke-width": n(thickness),
        "stroke-linecap": cap,
        d: "",
      }),
    );

    if (o.center) {
      // Font sizes are user units, so they scale with the viewBox rather than
      // needing one CSS rule per ring size.
      const value = add(frame, "text", {
        x: n(cx),
        y: n(cy - size * 0.01),
        class: "dash-ring-value",
        "font-size": n(size * 0.17),
        "text-anchor": "middle",
        "dominant-baseline": "middle",
      });
      value.textContent = o.center.value ?? "";
      if (o.center.label) {
        const label = add(frame, "text", {
          x: n(cx),
          y: n(cy + size * 0.15),
          class: "dash-ring-label",
          "font-size": n(size * 0.1),
          "text-anchor": "middle",
          "dominant-baseline": "middle",
        });
        label.textContent = o.center.label;
      }
    }

    parent.appendChild(frame);

    const draw = (values) => {
      let angle = 0;
      list.forEach((it, i) => {
        const v = values[i];
        // A full turn would make the arc's end point coincide with its start,
        // which SVG renders as nothing at all — clamp just short of it.
        const sweep = Math.min(359.99, total > 0 ? (v / total) * 360 : 0);
        const a0 = angle + gapDeg / 2;
        const a1 = angle + sweep - gapDeg / 2;
        angle += sweep;

        // A segment smaller than the gap would invert; skip drawing it but
        // keep its share of the angle so the ring stays proportional.
        if (a1 <= a0 || sweep <= 0) {
          set(segs[i], { d: "" });
          return;
        }
        set(segs[i], { d: arc(a0, a1) });
      });
    };

    const values = list.map((it) => it.value);
    const key = o.key
      ? `${o.key}|${list.map((it, i) => it.key ?? i).join(",")}`
      : null;
    const prev = remember(key, "ring", values);
    const first = prev == null;

    if (first && !reduceMotion()) {
      animate((t) => draw(values.map((v) => v * t)));
    } else {
      draw(values);
      if (prev) animate((t) => draw(lerpSeries(prev, values, t)));
    }

    return frame;
  }

  // ── radial gauge ─────────────────────────────────────────────────────

  // A 240° arc gauge. `value` is clamped into [min, max]; the arc is drawn as
  // two strokes (track + value) so the unfilled part is a real guide rather
  // than a lighter fill of the same hue.
  function gauge(parent, value, opts) {
    const o = opts ?? {};
    const size = o.size ?? 100;
    const thickness = o.thickness ?? size * 0.09;
    const r = size / 2 - thickness;
    const cx = size / 2;
    const cy = size / 2;
    const start = 210;
    const sweepMax = 240;
    const min = o.min ?? 0;
    const max = o.max ?? 100;

    const frame = svg({
      viewBox: `0 0 ${size} ${size}`,
      aspect: true,
      class: o.class ?? "shadcn-dash-chart shadcn-dash-gauge",
    });

    const pt = (deg) => {
      const rad = (deg * Math.PI) / 180;
      return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
    };

    const arc = (fromDeg, toDeg) => {
      const [x0, y0] = pt(fromDeg);
      const [x1, y1] = pt(toDeg);
      const large = toDeg - fromDeg > 180 ? 1 : 0;
      return `M${n(x0)} ${n(y0)}A${n(r)} ${n(r)} 0 ${large} 1 ${n(x1)} ${n(y1)}`;
    };

    add(frame, "path", {
      d: arc(start, start + sweepMax),
      class: o.trackClass ?? "dash-gauge-track",
      "stroke-width": n(thickness),
    });

    const valueArc = add(frame, "path", {
      d: "",
      class: o.valueClass ?? "dash-gauge-value",
      "stroke-width": n(thickness),
    });

    parent.appendChild(frame);

    const ratio =
      value == null || !isFinite(value)
        ? null
        : Math.max(0, Math.min(1, (value - min) / (max - min)));

    const draw = (t) => {
      if (ratio == null) {
        set(valueArc, { d: "" });
        return;
      }
      // A hairline minimum so "just above zero" is still visible.
      const swept = Math.max(ratio * t * sweepMax, 0.6);
      set(valueArc, { d: arc(start, start + swept) });
    };

    if (ratio != null && !reduceMotion()) animate(draw);
    else draw(1);

    return frame;
  }

  // ── rank rows ────────────────────────────────────────────────────────

  /* Horizontal bars for a "Top N" list. The caller supplies the label cell;
     this draws only the proportional track behind it, so the list stays a
     real table (readable by a screen reader) with a chart underneath.

     Strokes with `vector-effect: non-scaling-stroke` keep the 4px height and
     the round caps exactly 4px wide at any card width — a scaled rect would
     turn its corner radius into an ellipse on a 400px-wide row. */
  function rankBar(parent, value, max, opts) {
    const o = opts ?? {};
    const ratio =
      max > 0 && value != null && isFinite(value)
        ? Math.max(0, Math.min(1, value / max))
        : 0;

    const frame = svg({
      viewBox: "0 0 100 4",
      class: o.class ?? "shadcn-dash-chart shadcn-dash-rank",
    });

    add(frame, "line", {
      x1: 0,
      y1: 2,
      x2: 100,
      y2: 2,
      class: o.trackClass ?? "dash-rank-track",
      "stroke-width": 4,
      "stroke-linecap": "round",
      "vector-effect": "non-scaling-stroke",
    });

    const bar = add(frame, "line", {
      x1: 0,
      y1: 2,
      x2: 0,
      y2: 2,
      class: o.barClass ?? "dash-rank-bar",
      "stroke-width": 4,
      "stroke-linecap": "round",
      "vector-effect": "non-scaling-stroke",
    });

    parent.appendChild(frame);

    const prev = remember(o.key, "rank", [ratio]);
    const from = prev ? prev[0] : 0;

    /* The tween starts from the previous ratio, not from zero.

       `ratio * 100 * t` was used here while `from` was computed and never read,
       so every refresh shrank the bar to nothing and grew it back — on the slow
       path that is once a minute, per host, which reads as a flicker rather than
       as a value changing. Interpolating from `from` makes a change look like a
       change. */
    const draw = (t) => {
      const value2 = (from + (ratio - from) * t) * 100;
      set(bar, {
        x2: n(value2),
        visibility: value2 > 0.4 ? "visible" : "hidden",
      });
    };

    if (!reduceMotion() && from !== ratio) animate(draw);
    else draw(1);

    return frame;
  }

  // ── heat / stacked strip ─────────────────────────────────────────────

  // A row of equal cells shaded by value — used for "which hour had traffic".
  // No gradient: each cell is one flat step picked from a small ordinal scale,
  // so the reader can count steps.
  const STEPS = ["s0", "s1", "s2", "s3", "s4"];

  function heatStrip(parent, values, opts) {
    const o = opts ?? {};
    const list = values ?? [];
    if (!list.length) return null;

    const w = o.w ?? 100;
    const h = o.h ?? 8;
    const gap = o.gap ?? 0.8;
    const slot = w / list.length;
    const cellW = Math.max(slot - gap, 0.5);
    const range = extent(list);
    const span = range.max - range.min || 1;

    const frame = svg({
      viewBox: `0 0 ${w} ${h}`,
      class: o.class ?? "shadcn-dash-chart shadcn-dash-heat",
    });

    list.forEach((v, i) => {
      const ratio = v == null || !isFinite(v) ? 0 : (v - range.min) / span;
      const step =
        STEPS[Math.min(STEPS.length - 1, Math.floor(ratio * STEPS.length))];
      add(frame, "rect", {
        x: n(i * slot),
        y: 0,
        width: n(cellW),
        height: n(h),
        rx: n(Math.min(cellW / 2, h / 2)),
        class: `${o.cellClass ?? "dash-heat-cell"} dash-${step}`,
      });
    });

    parent.appendChild(frame);
    return frame;
  }

  // ── public surface ───────────────────────────────────────────────────

  const Charts = {
    extent,
    linePath,
    sparkline,
    multiLine,
    bars,
    hourBars,
    ring,
    gauge,
    rankBar,
    heatStrip,
    animate,
    reduceMotion,
    reset,
    STEPS,
  };

  // The patch bundle has no module system; expose on a namespace the patch
  // can reach, and keep a local alias for same-file use.
  global.ShadcnCharts = Charts;
})(window);
