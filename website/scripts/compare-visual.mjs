#!/usr/bin/env node
/**
 * Visual docs-parity check: screenshots matched component regions on the Rivet
 * docs and the local Secure Exec docs, writes per-region side-by-side
 * composites + pixel-diff images, and prints a % mismatch per region.
 *
 *   node website/scripts/compare-visual.mjs
 *
 * Output: /tmp/docs-visual/<region>-{rivet,se,diff,sidebyside}.png
 *
 * Note: the two sites have different page *content*, so regions containing
 * prose/code text have a content floor on their diff. The pixel diff is most
 * meaningful for chrome (frame, borders, rails, colors); the side-by-side
 * composites are for visual confirmation. The authoritative numeric parity
 * proof is compare-docs.mjs.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const RIVET_URL = process.env.RIVET_URL || "https://rivet.dev/docs/actors/state";
const SE_URL = process.env.SE_URL || "http://localhost:4330/docs/features/typescript";
const RIVET_CALLOUT = process.env.RIVET_CALLOUT || "https://rivet.dev/docs/actors/actions";
const SE_CALLOUT = process.env.SE_CALLOUT || "http://localhost:4330/docs/features/child-processes";
const OUT = "/tmp/docs-visual";
mkdirSync(OUT, { recursive: true });

// `pair` selects which page-pair the region is captured from.
const REGIONS = [
  { name: "header", rivet: "header", se: ".header", pair: "main" },
  { name: "sidebar", rivet: "aside", se: ".sidebar-pane", pair: "main" },
  { name: "code", rivet: "[data-code-block]", se: ".expressive-code", pair: "main" },
  { name: "toc", rivet: "aside:has(a[href^='#'])", se: "starlight-toc", pair: "main" },
  { name: "callout", rivet: ".mdx-callout", se: ".starlight-aside", pair: "callout" },
];

const ab = (args) => execFileSync("agent-browser", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function parseLast(out) {
  const lines = out.split("\n").map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (!raw.startsWith('"') && !raw.startsWith("{")) continue;
    try { let v = JSON.parse(raw); if (typeof v === "string") v = JSON.parse(v); return v; } catch {}
  }
  return null;
}

function boxOf(sel) {
  const js = `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'null';const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)});})()`;
  const v = parseLast(ab(["eval", js]));
  return v && v.w ? v : null;
}

// Load a page, screenshot it full, and read the boxes for the requested
// regions from the live (currently loaded) DOM.
function capture(url, tag, regions, side) {
  ab(["open", url]);
  ab(["set", "viewport", "1440", "2400"]);
  ab(["wait", "1800"]);
  const path = `${OUT}/_full_${tag}.png`;
  ab(["screenshot", "--full", path]);
  const png = PNG.sync.read(readFileSync(path));
  const boxes = {};
  for (const r of regions) boxes[r.name] = boxOf(r[side]);
  return { png, boxes };
}

function crop(png, b) {
  const w = Math.min(b.w, png.width - b.x);
  const h = Math.min(b.h, png.height - b.y);
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(png, out, b.x, b.y, w, h, 0, 0);
  return out;
}

function sideBySide(a, b, gap = 16) {
  const w = a.width + b.width + gap;
  const h = Math.max(a.height, b.height);
  const out = new PNG({ width: w, height: h });
  for (let i = 0; i < out.data.length; i += 4) { out.data[i] = 204; out.data[i+1] = 204; out.data[i+2] = 204; out.data[i+3] = 255; }
  PNG.bitblt(a, out, 0, 0, a.width, a.height, 0, 0);
  PNG.bitblt(b, out, 0, 0, b.width, b.height, a.width + gap, 0);
  return out;
}

const mainR = REGIONS.filter((r) => r.pair === "main");
const calloutR = REGIONS.filter((r) => r.pair === "callout");
console.error(`Rivet: ${RIVET_URL}`);
const rivetMain = capture(RIVET_URL, "rivet", mainR, "rivet");
console.error(`Secure Exec: ${SE_URL}`);
const seMain = capture(SE_URL, "se", mainR, "se");
console.error(`Rivet (callout): ${RIVET_CALLOUT}`);
const rivetCo = capture(RIVET_CALLOUT, "rivet-callout", calloutR, "rivet");
console.error(`Secure Exec (callout): ${SE_CALLOUT}`);
const seCo = capture(SE_CALLOUT, "se-callout", calloutR, "se");

const pngFor = (r, which) =>
  r.pair === "callout" ? (which === "r" ? rivetCo : seCo) : which === "r" ? rivetMain : seMain;

const results = [];
for (const r of REGIONS) {
  const rivetCap = pngFor(r, "r");
  const seCap = pngFor(r, "s");
  const br = rivetCap.boxes[r.name];
  const bs = seCap.boxes[r.name];
  if (!br || !bs) { results.push([r.name, br ? "" : "rivet:absent", bs ? "" : "se:absent"]); continue; }
  const cr = crop(rivetCap.png, br);
  const cs = crop(seCap.png, bs);
  writeFileSync(`${OUT}/${r.name}-rivet.png`, PNG.sync.write(cr));
  writeFileSync(`${OUT}/${r.name}-se.png`, PNG.sync.write(cs));
  writeFileSync(`${OUT}/${r.name}-sidebyside.png`, PNG.sync.write(sideBySide(cr, cs)));
  // pixel diff on the shared top-left rectangle
  const w = Math.min(cr.width, cs.width);
  const h = Math.min(cr.height, cs.height);
  const a = new PNG({ width: w, height: h }); PNG.bitblt(cr, a, 0, 0, w, h, 0, 0);
  const b = new PNG({ width: w, height: h }); PNG.bitblt(cs, b, 0, 0, w, h, 0, 0);
  const diff = new PNG({ width: w, height: h });
  const mismatched = pixelmatch(a.data, b.data, diff.data, w, h, { threshold: 0.1 });
  writeFileSync(`${OUT}/${r.name}-diff.png`, PNG.sync.write(diff));
  const pct = (100 * mismatched / (w * h)).toFixed(2);
  results.push([r.name, `${br.w}x${br.h} / ${bs.w}x${bs.h}`, `${pct}%`]);
}

// This script is NOT a gate — the two sites have different page *content*, so a
// region pixel-diff always carries a content floor. It exists to generate the
// side-by-side composites used for human/vision review. The authoritative
// pixel gate is compare-fixture.mjs (content held identical); the numeric token
// gate is compare-docs.mjs.
console.log(`\n  region     rivet/se size            full-region diff`);
console.log("  " + "-".repeat(52));
for (const [name, size, pct] of results) {
  console.log(`  ${name.padEnd(10)} ${String(size).padEnd(24)} ${pct}`);
}
console.log("  " + "-".repeat(52));
console.log("  Composites for vision review written to " + OUT + "/.");
console.log("  (Not a gate — region % includes differing page text.)");
