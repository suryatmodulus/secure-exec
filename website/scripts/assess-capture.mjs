#!/usr/bin/env node
/**
 * Capture pass for the component-parity assessment workflow.
 *
 * agent-browser is a single shared browser, so the workflow that assesses each
 * Starlight component vs Rivet can't have many agents drive it concurrently.
 * This script does the browser work ONCE, sequentially: for every component it
 * records the computed styles of a representative element on BOTH the local
 * Secure Exec docs and the live Rivet docs, plus a cropped screenshot of each.
 * The workflow then fans out file-based analysis agents (no browser) that read
 * these JSON + PNG artifacts and judge the 1:1 match.
 *
 *   node website/scripts/assess-capture.mjs
 *
 * Output: /tmp/parity-assess/<component>.json  (both sites' metrics)
 *         /tmp/parity-assess/<component>-{se,rivet}.png  (crops)
 *         /tmp/parity-assess/index.json  (component list)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";

const SE = process.env.SE_BASE || "http://localhost:4322";
const RV = "https://rivet.dev";
const OUT = "/tmp/parity-assess";
mkdirSync(OUT, { recursive: true });

// Representative pages on each site.
const SE_PROSE = `${SE}/docs/features/typescript/`;
const SE_QUICK = `${SE}/docs/quickstart/`;
const SE_OVERVIEW = `${SE}/docs/`;
const SE_CALLOUT = `${SE}/docs/features/child-processes/`;
const RV_PROSE = `${RV}/docs/actors/state`;
const RV_QUICK = `${RV}/docs/actors/quickstart/backend`;
const RV_OVERVIEW = `${RV}/docs`;
const RV_CALLOUT = `${RV}/docs/actors/actions`;

const PROPS = [
  "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "color",
  "backgroundColor", "borderTopWidth", "borderTopColor", "borderBottomColor",
  "borderTopLeftRadius", "paddingTop", "paddingLeft", "marginTop", "marginBottom",
  "display", "textDecorationLine", "boxShadow", "gap",
];

// Each component: a selector on each site + the page it lives on. `crop` widens
// the screenshot box (px) around the element so context (e.g. a tab row above a
// code block) is visible.
const COMPONENTS = [
  { name: "header-bar", se: { url: SE_PROSE, sel: ".header" }, rivet: { url: RV_PROSE, sel: "header" }, crop: [0, 0, 0, 0] },
  { name: "header-wordmark", se: { url: SE_PROSE, sel: ".se-logo-se" }, rivet: { url: RV_PROSE, sel: "header a[href='/'], header a[aria-label*=Rivet]" } },
  { name: "header-search", se: { url: SE_PROSE, sel: ".se-search button" }, rivet: { url: RV_PROSE, sel: "header [type='search'], header input, header button[aria-label*=Search]" } },
  { name: "header-tabs", se: { url: SE_PROSE, sel: ".se-tabs" }, rivet: { url: RV_PROSE, sel: "header nav:last-of-type, [class*=tab]" }, crop: [20, 10, 20, 10] },
  { name: "sidebar-link", se: { url: SE_PROSE, sel: ".sidebar-content a[aria-current='page']" }, rivet: { url: RV_PROSE, sel: "aside a[aria-current='page']" } },
  { name: "sidebar-group-label", se: { url: SE_PROSE, sel: ".sidebar-content .group-label .large" }, rivet: { url: RV_PROSE, sel: "aside p, aside [class*=group]" } },
  { name: "sidebar", se: { url: SE_PROSE, sel: ".sidebar-pane" }, rivet: { url: RV_PROSE, sel: "aside" } },
  { name: "toc", se: { url: SE_PROSE, sel: "starlight-toc" }, rivet: { url: RV_PROSE, sel: "aside:last-of-type" }, crop: [10, 10, 10, 200] },
  { name: "toc-link", se: { url: SE_PROSE, sel: "starlight-toc a" }, rivet: { url: RV_PROSE, sel: "aside:last-of-type a[href^='#']" } },
  { name: "h1", se: { url: SE_PROSE, sel: "h1#_top" }, rivet: { url: RV_PROSE, sel: ".docs-article h1" } },
  { name: "h2", se: { url: SE_PROSE, sel: ".sl-markdown-content h2" }, rivet: { url: RV_PROSE, sel: ".docs-article h2" } },
  { name: "h3", se: { url: SE_PROSE, sel: ".sl-markdown-content h3" }, rivet: { url: RV_PROSE, sel: ".docs-article h3" } },
  { name: "paragraph", se: { url: SE_PROSE, sel: ".sl-markdown-content > p" }, rivet: { url: RV_PROSE, sel: ".docs-article > p" } },
  { name: "inline-code", se: { url: SE_PROSE, sel: ".sl-markdown-content p code" }, rivet: { url: RV_PROSE, sel: ".docs-article p code" } },
  { name: "link", se: { url: SE_PROSE, sel: ".sl-markdown-content p a" }, rivet: { url: RV_PROSE, sel: ".docs-article p a" } },
  { name: "code-frame", se: { url: SE_PROSE, sel: ".expressive-code .frame" }, rivet: { url: RV_PROSE, sel: "[data-code-block]" }, crop: [10, 10, 10, 10] },
  { name: "copy-button", se: { url: SE_PROSE, sel: ".expressive-code .copy button" }, rivet: { url: RV_PROSE, sel: "[data-code-block] button" } },
  { name: "code-group-tabs", se: { url: SE_QUICK, sel: ".sl-markdown-content [role='tablist']" }, rivet: { url: RV_QUICK, sel: "[role='tablist'], [class*=tab]" }, crop: [20, 10, 20, 60] },
  { name: "steps", se: { url: SE_QUICK, sel: ".sl-steps" }, rivet: { url: RV_QUICK, sel: ".docs-article ol:has(li), .step" }, crop: [40, 10, 10, 40] },
  { name: "callout", se: { url: SE_CALLOUT, sel: ".starlight-aside" }, rivet: { url: RV_CALLOUT, sel: ".mdx-callout" }, crop: [10, 10, 10, 10] },
  { name: "card", se: { url: SE_OVERVIEW, sel: ".dl-card, .card, .sl-link-card" }, rivet: { url: RV_OVERVIEW, sel: "a[class*=rounded], [class*=card]" }, crop: [10, 10, 10, 10] },
  { name: "pagination", se: { url: SE_PROSE, sel: ".pagination-links a" }, rivet: { url: RV_PROSE, sel: "a[href][class*=border]:has(svg)" }, crop: [10, 10, 10, 10] },
];

const ab = (args) => { try { return execFileSync("agent-browser", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); } catch (e) { return e.stdout || ""; } };
function parseLast(out) {
  const lines = out.split("\n").map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = lines[i];
    if (!r.startsWith("{") && !r.startsWith("[") && !r.startsWith('"')) continue;
    try { let v = JSON.parse(r); if (typeof v === "string") v = JSON.parse(v); return v; } catch {}
  }
  return null;
}

const PROBE = (sel, props) => String.raw`(() => {
  const q = (s) => { for (const one of s.split(',')) { try { const e = document.querySelector(one.trim()); if (e) return e; } catch(_){} } return null; };
  const el = q(${JSON.stringify(sel)});
  if (!el) return JSON.stringify({ found: false });
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const o = { found: true, box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, styles: {} };
  ${JSON.stringify(props)}.forEach((p) => { o.styles[p] = cs[p]; });
  o.text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50);
  return JSON.stringify(o);
})()`;

// Capture all components for one (site,url) in a single navigation.
function captureSite(url, comps, side) {
  ab(["open", url]);
  ab(["set", "viewport", "1440", "2600"]);
  ab(["wait", "2600"]);
  ab(["eval", "window.scrollTo(0,0)"]);
  const shot = `${OUT}/_full_${side}_${comps[0].name}.png`;
  ab(["screenshot", "--full", shot]);
  let png = null;
  try { png = PNG.sync.read(readFileSync(shot)); } catch {}
  const results = {};
  for (const c of comps) {
    const probe = parseLast(ab(["eval", PROBE(c[side].sel, PROPS)])) || { found: false };
    results[c.name] = probe;
    if (png && probe.found && probe.box.w > 1) {
      const [l, t, rr, b] = c.crop || [6, 6, 6, 6];
      const bx = Math.max(0, probe.box.x - l), by = Math.max(0, probe.box.y - t);
      const bw = Math.min(probe.box.w + l + rr, png.width - bx), bh = Math.min(probe.box.h + t + b, png.height - by);
      if (bw > 1 && bh > 1) {
        const o = new PNG({ width: bw, height: bh });
        PNG.bitblt(png, o, bx, by, bw, bh, 0, 0);
        writeFileSync(`${OUT}/${c.name}-${side}.png`, PNG.sync.write(o));
      }
    }
  }
  return results;
}

// Group components by (side,url) to minimize navigations.
function group(side) {
  const byUrl = new Map();
  for (const c of COMPONENTS) {
    const u = c[side].url;
    if (!byUrl.has(u)) byUrl.set(u, []);
    byUrl.get(u).push(c);
  }
  const out = {};
  for (const [u, comps] of byUrl) {
    console.error(`[${side}] ${u}  (${comps.map((c) => c.name).join(", ")})`);
    Object.assign(out, captureSite(u, comps, side));
  }
  return out;
}

const seData = group("se");
const rvData = group("rivet");

const index = [];
for (const c of COMPONENTS) {
  const rec = {
    name: c.name,
    se: { selector: c.se.sel, url: c.se.url, ...seData[c.name] },
    rivet: { selector: c.rivet.sel, url: c.rivet.url, ...rvData[c.name] },
    seCrop: `${OUT}/${c.name}-se.png`,
    rivetCrop: `${OUT}/${c.name}-rivet.png`,
  };
  writeFileSync(`${OUT}/${c.name}.json`, JSON.stringify(rec, null, 2));
  index.push({ name: c.name, json: `${OUT}/${c.name}.json`, seCrop: rec.seCrop, rivetCrop: rec.rivetCrop, seFound: !!seData[c.name]?.found, rivetFound: !!rvData[c.name]?.found });
}
writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 2));
console.log(`\nCaptured ${COMPONENTS.length} components → ${OUT}/`);
console.log("found (se/rivet):");
for (const i of index) console.log(`  ${i.name.padEnd(20)} ${i.seFound ? "se✓" : "se✗"} ${i.rivetFound ? "rv✓" : "rv✗"}`);
