#!/usr/bin/env node
/**
 * Content-cloned fixture parity gate.
 *
 * The local route /docs/parity-fixture is an auto-generated 1:1 clone of the
 * content of https://rivet.dev/docs/actors/state (same headings, paragraphs,
 * lists, and code). Because the *content* is held identical, a per-component
 * pixel diff of the content column isolates THEME differences (type scale,
 * weight, color, measure, spacing) from content differences.
 *
 *   node website/scripts/compare-fixture.mjs
 *
 * Components are matched across the two sites by their text (not DOM index), so
 * wrapper/structure differences don't misalign them. For each matched prose
 * component we report:
 *   - box size on each site (W×H) and the size delta  (the cleanest theme
 *     signal: identical text in a matched type scale yields a matched box)
 *   - a pixel-diff % over the overlapping crop
 *
 * Caveat: code blocks render through different highlighters (Rivet Shiki vs our
 * Expressive Code), so their glyph pixels never match — code rows are reported
 * for chrome/size only and excluded from the gate. Prose text also never hits
 * 0% (sub-pixel font rendering differs between sites); the gate flags
 * components whose box size diverges (a real theme mismatch), not raw pixel %.
 *
 * Output: /tmp/docs-fixture/<idx>-<kind>-{rivet,se,diff}.png + a table.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const RIVET_URL = process.env.RIVET_URL || "https://rivet.dev/docs/actors/state";
const SE_URL = process.env.SE_URL || "http://localhost:4330/docs/parity-fixture";
const OUT = "/tmp/docs-fixture";
mkdirSync(OUT, { recursive: true });

// Size-delta tolerance (px) past which a matched prose component counts as a
// theme mismatch. Width can legitimately wiggle a few px from font metrics;
// height is the tight signal for type scale / line-height.
const TOL_W = 6;
const TOL_H = 3;

const ab = (args) => execFileSync("agent-browser", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function parseLast(out) {
  const lines = out.split("\n").map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (!raw.startsWith('"') && !raw.startsWith("{") && !raw.startsWith("[")) continue;
    try { let v = JSON.parse(raw); if (typeof v === "string") v = JSON.parse(v); return v; } catch {}
  }
  return null;
}

// Probe: list content components with their absolute box + a text key. Run at
// scrollY 0 so getBoundingClientRect().top equals the absolute document offset
// captured by the full-page screenshot.
const PROBE = (rootSel) => String.raw`(() => {
  window.scrollTo(0, 0);
  const root = document.querySelector(${JSON.stringify(rootSel)});
  if (!root) return JSON.stringify([]);
  const norm = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 60);
  const out = [];
  // Match descendant prose (Starlight wraps headings; Rivet doesn't, so a
  // direct-child query would miss our headings). Then keep only top-level prose
  // — elements whose parent is the content root — plus headings/code, so prose
  // nested inside a site's bespoke widget isn't compared against cloned
  // standard prose. Code <pre> is always nested in a frame, so keep it.
  root.querySelectorAll(':scope h2, :scope h3, :scope p, :scope ul, :scope ol, :scope pre').forEach((el) => {
    let kind = el.tagName.toLowerCase();
    if (kind === 'ol') kind = 'ul';
    const isCode = kind === 'pre';
    const isHeading = kind === 'h2' || kind === 'h3';
    if (!isCode && !isHeading && el.parentElement !== root) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    out.push({
      kind: isCode ? 'code' : kind,
      key: (isCode ? 'code' : kind) + ':' + norm(el.textContent),
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    });
  });
  return JSON.stringify(out);
})()`;

function capture(url, rootSel, tag) {
  ab(["open", url]);
  ab(["set", "viewport", "1440", "2400"]);
  ab(["wait", "2200"]);
  const path = `${OUT}/_full_${tag}.png`;
  ab(["screenshot", "--full", path]);
  const png = PNG.sync.read(readFileSync(path));
  const comps = parseLast(ab(["eval", PROBE(rootSel)])) || [];
  return { png, comps };
}

function crop(png, b) {
  const x = Math.max(0, b.x), y = Math.max(0, b.y);
  const w = Math.min(b.w, png.width - x);
  const h = Math.min(b.h, png.height - y);
  if (w < 1 || h < 1) return null;
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(png, out, x, y, w, h, 0, 0);
  return out;
}

function diffPct(a, b) {
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  const xa = new PNG({ width: w, height: h }); PNG.bitblt(a, xa, 0, 0, w, h, 0, 0);
  const xb = new PNG({ width: w, height: h }); PNG.bitblt(b, xb, 0, 0, w, h, 0, 0);
  const diff = new PNG({ width: w, height: h });
  const m = pixelmatch(xa.data, xb.data, diff.data, w, h, { threshold: 0.1 });
  return { pct: (100 * m / (w * h)), diff };
}

console.error(`Rivet:  ${RIVET_URL}`);
const rivet = capture(RIVET_URL, ".docs-article", "rivet");
console.error(`Fixture: ${SE_URL}`);
const se = capture(SE_URL, ".sl-markdown-content", "se");

// Match by text key, disambiguating duplicate-text blocks (e.g. several code
// samples that all start `import { actor }`) by their occurrence order.
const indexBy = (comps) => {
  const seen = new Map();
  const m = new Map();
  comps.forEach((c) => {
    const n = (seen.get(c.key) || 0) + 1;
    seen.set(c.key, n);
    m.set(`${c.key}#${n}`, c);
  });
  return m;
};
const rMap = indexBy(rivet.comps);
const sMap = indexBy(se.comps);

const rows = [];
let i = 0;
for (const [key, rc] of rMap) {
  const sc = sMap.get(key);
  if (!sc) {
    // Code blocks are matched by text, but Expressive Code and Rivet's Shiki
    // serialize whitespace differently, so a code key can fail to pair up. That
    // is a matcher limitation, not a theme miss — don't gate on it.
    rows.push({ kind: rc.kind, key, missing: true, ignore: rc.kind === "code" });
    continue;
  }
  const cr = crop(rivet.png, rc);
  const cs = crop(se.png, sc);
  let pct = null;
  if (cr && cs) {
    const d = diffPct(cr, cs);
    pct = d.pct;
    const idx = String(i).padStart(2, "0");
    writeFileSync(`${OUT}/${idx}-${rc.kind}-rivet.png`, PNG.sync.write(cr));
    writeFileSync(`${OUT}/${idx}-${rc.kind}-se.png`, PNG.sync.write(cs));
    writeFileSync(`${OUT}/${idx}-${rc.kind}-diff.png`, PNG.sync.write(d.diff));
  }
  rows.push({
    kind: rc.kind, key,
    rw: rc.w, rh: rc.h, sw: sc.w, sh: sc.h,
    dw: Math.abs(rc.w - sc.w), dh: Math.abs(rc.h - sc.h),
    pct,
  });
  i++;
}

// Report.
const pad = (s, n) => String(s).padEnd(n);
console.log("\n" + pad("kind", 7) + pad("text", 40) + pad("rivet", 12) + pad("fixture", 12) + pad("Δw/Δh", 10) + "pixel%");
console.log("-".repeat(92));
let fails = 0;
let proseChecked = 0;
for (const r of rows) {
  const text = r.key.split(":").slice(1).join(":").slice(0, 36);
  if (r.missing) {
    console.log(pad(r.kind, 7) + pad(text, 40) + (r.ignore ? "unmatched (code serialization) ·skip" : "MISSING in fixture"));
    if (!r.ignore) fails++;
    continue;
  }
  const isCode = r.kind === "code";
  // Headings are full-width blocks on Rivet but shrink-to-text in our theme;
  // the text is left-aligned so width is not a visual difference — gate
  // headings on height (type scale) only. Paragraphs/lists gate on both.
  const isHeading = r.kind === "h2" || r.kind === "h3";
  const sizeBad = !isCode && (r.dh > TOL_H || (!isHeading && r.dw > TOL_W));
  if (!isCode) proseChecked++;
  if (sizeBad) fails++;
  const flag = isCode ? "·code" : sizeBad ? "FAIL " : "ok   ";
  console.log(
    pad(r.kind, 7) + pad(text, 40) +
    pad(`${r.rw}x${r.rh}`, 12) + pad(`${r.sw}x${r.sh}`, 12) +
    pad(`${r.dw}/${r.dh}`, 10) + `${r.pct == null ? "-" : r.pct.toFixed(1)}%  ${flag}`
  );
}
console.log("-".repeat(92));
const matched = rows.filter((r) => !r.missing).length;
console.log(`matched ${matched}/${rMap.size} components; prose size-checked ${proseChecked}; code rows excluded from gate (highlighter differs).`);
console.log(`Δw tol ${TOL_W}px, Δh tol ${TOL_H}px. Per-component crops + diffs in ${OUT}/`);
console.log(`${fails === 0 ? "PASS" : "FAIL"}: ${fails} component(s) diverge in size or are missing.`);
process.exit(fails === 0 ? 0 : 1);
