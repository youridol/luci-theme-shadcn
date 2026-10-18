"use strict";
/* Hand-written SVG chart primitives for the Overview dashboard.

   Why hand-written (see .dev/docs/adr/0004-handwritten-svg-charts.md):
   patches are copied through terser, not bundled by Rollup, so a chart
   library cannot be imported here. Each primitive below is therefore just
   "array of numbers → path/rect strings", which is a few lines apiece.

   House rules these enforce by construction:
   - pure SVG, no canvas, no WebGL — every shape is a DOM node the theme's
     tokens can colour;
   - no gradients (.dev/docs/adr/0003-no-gradients.md): fills come from CSS
     classes the patch stylesheet defines, so each series is one flat colour;
   - no motion inside a chart: 3D is an isometric static view, not a spin
     (.dev/docs/adr/0007-3d-visual-boundary.md).

   Every function returns a string of SVG markup or a coordinate array; none
   of them touch the document except `svg()`, which builds the frame. */

(function (global) {
  const NS = "http://www.w3.org/2000/svg";

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
  // (rings, gauges, the isometric bars) pass aspect: true.
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

  // ── sparkline / waveform ─────────────────────────────────────────────

  // A polyline through the series, plus an optional filled area under it.
  //
  // Gaps (null entries) break the line instead of dropping to zero: a
  // missing sample is not a measurement of 0, and drawing it as one invents
  // a spike that never happened.
  function linePath(values, w, h, opts) {
    const o = opts ?? {};
    if (!values || !values.length) return null;

    const range = o.range ?? extent(values);
    const span = range.max - range.min || 1;
    const step = values.length > 1 ? w / (values.length - 1) : w;

    const y = (v) => h - ((v - range.min) / span) * h;

    let d = "";
    let area = "";
    let started = false;
    let firstX = 0;
    let lastX = 0;

    values.forEach((v, i) => {
      const x = i * step;
      if (v == null || !isFinite(v)) {
        started = false;
        return;
      }
      d += (started ? "L" : "M") + n(x) + " " + n(y(v)) + " ";
      if (!started) firstX = x;
      started = true;
      lastX = x;
    });

    if (!d) return null;

    if (o.area !== false) {
      area =
        `M${n(firstX)} ${n(h)} L${n(firstX)} ${n(y(values.find((v) => v != null)))} ` +
        d.slice(d.indexOf("L") >= 0 ? d.indexOf("L") : d.length) +
        `L${n(lastX)} ${n(h)} Z`;
    }

    return { line: d.trim(), area: area || null, range };
  }

  // A single call that renders a sparkline into `parent`.
  //
  // `classes` supplies the stroke and fill classes so the patch stylesheet
  // owns every colour (no hardcoded value ever enters a chart path).
  function sparkline(parent, values, opts) {
    const o = opts ?? {};
    const w = o.w ?? 100;
    const h = o.h ?? 34;
    const paths = linePath(values, w, h, o);
    if (!paths) return null;

    const frame = svg({
      viewBox: `0 0 ${w} ${h}`,
      class: o.class ?? "shadcn-dash-chart shadcn-dash-spark",
    });

    if (paths.area && o.areaClass)
      add(frame, "path", { d: paths.area, class: o.areaClass });
    add(frame, "path", { d: paths.line, class: o.lineClass ?? "dash-line" });

    parent.appendChild(frame);
    return frame;
  }

  // ── bars ─────────────────────────────────────────────────────────────

  // Vertical bars in a 0..100 wide box. `bars` is [{ value, label? }].
  // Heights are relative to the tallest bar; a zero baseline sits at h.
  function bars(parent, items, opts) {
    const o = opts ?? {};
    const w = o.w ?? 100;
    const h = o.h ?? 34;
    const list = items ?? [];
    if (!list.length) return null;

    const values = list.map((it) => (typeof it === "number" ? it : it.value));
    const range = extent(values);
    const span = range.max - range.min || 1;
    const gap = o.gap ?? 0.18;
    const slot = w / list.length;
    const barW = slot * (1 - gap);

    const frame = svg({
      viewBox: `0 0 ${w} ${h}`,
      class: o.class ?? "shadcn-dash-chart shadcn-dash-bars",
    });

    list.forEach((it, i) => {
      const value = values[i];
      if (value == null || !isFinite(value)) return;
      const ratio = (value - range.min) / span;
      const barH = Math.max(ratio * h, o.minHeight ?? 0);
      const x = i * slot + (slot - barW) / 2;

      // The corner radius can never exceed half the bar's height: a bar
      // shorter than its own radius would otherwise draw a curve that dips
      // *below* the baseline and out of the viewBox (a zero-value bar came
      // out as "M3 34 L3 35.2" before this clamp).
      const limit = Math.min(barW / 2, barH / 2);
      const r = Math.min(o.radius ?? 1.2, limit);
      const yTop = Math.max(h - barH, 0);

      // A zero-height bar is a legitimate "no traffic this hour": draw a
      // hairline sitting on the baseline so the slot is still readable.
      if (barH <= 0.01) {
        add(frame, "path", {
          d: `M${n(x)} ${n(h - 0.5)} L${n(x + barW)} ${n(h - 0.5)} L${n(x + barW)} ${n(h)} L${n(x)} ${n(h)} Z`,
          class: o.emptyClass ?? "dash-bar-empty",
        });
        return;
      }

      add(frame, "path", {
        d:
          `M${n(x)} ${n(h)} L${n(x)} ${n(yTop + r)} ` +
          `Q${n(x)} ${n(yTop)} ${n(x + r)} ${n(yTop)} ` +
          `L${n(x + barW - r)} ${n(yTop)} ` +
          `Q${n(x + barW)} ${n(yTop)} ${n(x + barW)} ${n(yTop + r)} ` +
          `L${n(x + barW)} ${n(h)} Z`,
        class: o.barClass ?? "dash-bar",
      });
    });

    parent.appendChild(frame);
    return frame;
  }

  // ── isometric 3D bars ────────────────────────────────────────────────

  // The 3D expression used by "今日流量按小时" (adr/0007). Each bar is three
  // real faces, not a faked shadow:
  //
  //        ┌───╮        top    — the lightest step
  //        │   │╲       side   — the middle step
  //   ┌────┴───┴─╲      front  — the darkest step
  //
  // Depth is a fixed shear (dx, -dy) applied to the top face, so every bar
  // shares the same vanishing direction and the row reads as one scene.
  function isoBars(parent, items, opts) {
    const o = opts ?? {};
    const w = o.w ?? 100;
    const front = o.h ?? 34;
    const list = items ?? [];
    if (!list.length) return null;

    const depth = o.depth ?? 3.2;
    const dx = depth;
    const dy = depth * 0.62;

    const values = list.map((it) => (typeof it === "number" ? it : it.value));
    const range = extent(values);
    const span = range.max - range.min || 1;
    const slot = w / list.length;
    const barW = slot * (o.gap ?? 0.55);
    // The top face pokes up by dy, so the tallest bar must leave that much
    // headroom or it clips out of the viewBox.
    const usable = front - dy;

    const frame = svg({
      viewBox: `0 0 ${w} ${front + dy}`,
      class: o.class ?? "shadcn-dash-chart shadcn-dash-iso",
    });

    const baseY = front;

    list.forEach((it, i) => {
      const value = values[i];
      if (value == null || !isFinite(value)) return;

      const ratio = (value - range.min) / span;
      const barH = Math.max(ratio * usable, o.minHeight ?? 0);
      const x = i * slot + (slot - barW) / 2;
      const yTop = baseY - barH;

      // front face
      add(frame, "path", {
        d: `M${n(x)} ${n(baseY)} L${n(x)} ${n(yTop)} L${n(x + barW)} ${n(yTop)} L${n(x + barW)} ${n(baseY)} Z`,
        class: o.frontClass ?? "dash-iso-front",
      });
      // side face (right), sheared up-right
      add(frame, "path", {
        d: `M${n(x + barW)} ${n(baseY)} L${n(x + barW)} ${n(yTop)} L${n(x + barW + dx)} ${n(yTop - dy)} L${n(x + barW + dx)} ${n(baseY - dy)} Z`,
        class: o.sideClass ?? "dash-iso-side",
      });
      // top face
      add(frame, "path", {
        d: `M${n(x)} ${n(yTop)} L${n(x + dx)} ${n(yTop - dy)} L${n(x + barW + dx)} ${n(yTop - dy)} L${n(x + barW)} ${n(yTop)} Z`,
        class: o.topClass ?? "dash-iso-top",
      });
    });

    parent.appendChild(frame);
    return frame;
  }

  // ── ring / donut ─────────────────────────────────────────────────────

  // A donut from [{ value, class? }]. Each segment is an arc path; separators
  // are gaps rather than drawn strokes, because a stroke would need a colour
  // that fights the one behind it.
  function ring(parent, items, opts) {
    const o = opts ?? {};
    const size = o.size ?? 100;
    const r = o.radius ?? size / 2 - 2;
    const thickness = o.thickness ?? Math.max(r * 0.32, 3);
    const inner = r - thickness;
    const cx = size / 2;
    const cy = size / 2;

    const list = (items ?? []).filter(
      (it) => it && isFinite(it.value) && it.value > 0,
    );
    if (!list.length) return null;

    const total = list.reduce((s, it) => s + it.value, 0);
    const gapDeg = o.gapDeg ?? 1.2;

    const frame = svg({
      viewBox: `0 0 ${size} ${size}`,
      aspect: true,
      class: o.class ?? "shadcn-dash-chart shadcn-dash-ring",
    });

    const pt = (radius, deg) => {
      const rad = ((deg - 90) * Math.PI) / 180;
      return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
    };

    let angle = 0;
    list.forEach((it, i) => {
      const sweep = (it.value / total) * 360;
      const a0 = angle + gapDeg / 2;
      const a1 = angle + sweep - gapDeg / 2;
      angle += sweep;

      // A segment smaller than the gap would invert; skip drawing it but keep
      // its share of the angle so the ring stays proportional.
      if (a1 <= a0) return;

      const large = a1 - a0 > 180 ? 1 : 0;
      const [x0, y0] = pt(r, a0);
      const [x1, y1] = pt(r, a1);
      const [x2, y2] = pt(inner, a1);
      const [x3, y3] = pt(inner, a0);

      add(frame, "path", {
        d:
          `M${n(x0)} ${n(y0)} A${n(r)} ${n(r)} 0 ${large} 1 ${n(x1)} ${n(y1)} ` +
          `L${n(x2)} ${n(y2)} A${n(inner)} ${n(inner)} 0 ${large} 0 ${n(x3)} ${n(y3)} Z`,
        class: it.class ?? o.segmentClass ?? "dash-ring-seg",
        "data-index": String(i),
      });
    });

    parent.appendChild(frame);
    return frame;
  }

  // ── radial gauge ─────────────────────────────────────────────────────

  // A 240° arc gauge for temperature. `value` is clamped into [min, max]; the
  // arc is drawn as two strokes (track + value) so the unfilled part is a
  // real guide rather than a lighter fill of the same hue.
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
      return `M${n(x0)} ${n(y0)} A${n(r)} ${n(r)} 0 ${large} 1 ${n(x1)} ${n(y1)}`;
    };

    add(frame, "path", {
      d: arc(start, start + sweepMax),
      class: o.trackClass ?? "dash-gauge-track",
    });

    if (value != null && isFinite(value)) {
      const ratio = Math.max(0, Math.min(1, (value - min) / (max - min)));
      // A hairline minimum so "just above zero" is still visible.
      const swept = Math.max(ratio * sweepMax, 0.6);
      add(frame, "path", {
        d: arc(start, start + swept),
        class: o.valueClass ?? "dash-gauge-value",
      });
    }

    parent.appendChild(frame);
    return frame;
  }

  // ── rank rows ────────────────────────────────────────────────────────

  // Horizontal bars for a "Top N" list. The caller supplies the label cell;
  // this draws only the proportional track behind it, so the list stays a
  // real table (readable by a screen reader) with a chart underneath.
  function rankBar(parent, value, max, opts) {
    const o = opts ?? {};
    const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    const frame = svg({
      viewBox: "0 0 100 4",
      class: o.class ?? "shadcn-dash-chart shadcn-dash-rank",
    });

    add(frame, "path", {
      d: "M0 0 L100 0 L100 4 L0 4 Z",
      class: o.trackClass ?? "dash-rank-track",
    });

    if (ratio > 0) {
      add(frame, "path", {
        d: `M0 0 L${n(ratio * 100)} 0 L${n(ratio * 100)} 4 L0 4 Z`,
        class: o.barClass ?? "dash-rank-bar",
      });
    }

    parent.appendChild(frame);
    return frame;
  }

  // ── heat / stacked strip ─────────────────────────────────────────────

  // A row of equal cells shaded by value — used for per-core CPU and for
  // "which hour had traffic". No gradient: each cell is one flat step picked
  // from a small ordinal scale, so the reader can count steps.
  const STEPS = ["s0", "s1", "s2", "s3", "s4"];

  function heatStrip(parent, values, opts) {
    const o = opts ?? {};
    const list = values ?? [];
    if (!list.length) return null;

    const w = o.w ?? 100;
    const h = o.h ?? 8;
    const gap = o.gap ?? 0.6;
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
      add(frame, "path", {
        d: `M${n(i * slot)} 0 L${n(i * slot + cellW)} 0 L${n(i * slot + cellW)} ${n(h)} L${n(i * slot)} ${n(h)} Z`,
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
    bars,
    isoBars,
    ring,
    gauge,
    rankBar,
    heatStrip,
    STEPS,
  };

  // The patch bundle has no module system; expose on a namespace the patch
  // can reach, and keep a local alias for same-file use.
  global.ShadcnCharts = Charts;
})(window);
