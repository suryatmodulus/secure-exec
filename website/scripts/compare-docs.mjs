#!/usr/bin/env node
/**
 * Programmatic docs-parity check: opens the Rivet docs and the local Secure
 * Exec docs, extracts a common set of computed-style metrics from each, and
 * diffs them with per-metric tolerances. Exits non-zero on any mismatch.
 *
 *   node website/scripts/compare-docs.mjs
 *   RIVET_URL=... SE_URL=... node website/scripts/compare-docs.mjs
 *
 * Requires the `agent-browser` CLI on PATH and the local dev server running
 * (`just docs`, default http://localhost:4330).
 */
import { execFileSync } from "node:child_process";

const RIVET_URL = process.env.RIVET_URL || "https://rivet.dev/docs/actors/state";
const SE_URL = process.env.SE_URL || "http://localhost:4330/docs/features/typescript";
// A second page-pair that both contain a `note` callout, so callout styling is
// actually exercised (the main pair has none).
const RIVET_CALLOUT = process.env.RIVET_CALLOUT || "https://rivet.dev/docs/actors/actions";
const SE_CALLOUT = process.env.SE_CALLOUT || "http://localhost:4330/docs/features/child-processes";

// Probe runs in the page and maps each site's DOM to a common schema.
const PROBE = String.raw`(() => {
  const isRivet = location.hostname.includes('rivet');
  const q = (s) => { try { return document.querySelector(s); } catch(e){ return null; } };
  const px = (el) => el ? Math.round(el.getBoundingClientRect().width) : null;
  const g = (el, ...props) => { if(!el) return null; const cs=getComputedStyle(el); const o={}; props.forEach(p=>o[p]=cs[p]); return o; };
  const bgOf = (el) => { let n=el; while(n && n!==document.body){ const b=getComputedStyle(n).backgroundColor; if(b && b!=='rgba(0, 0, 0, 0)' && b!=='transparent') return b; n=n.parentElement; } return null; };
  const S = isRivet ? {
    h1:'.docs-article h1', h2:'.docs-article h2', p:'.docs-article > p',
    link:'.docs-article p a', eyebrow:'.eyebrow',
    sidebar:'aside', sidebarLink:'aside a[href^="/docs"]',
    sidebarActive:'aside a[aria-current="page"]', sectionLabel:'aside p',
    codeFrame:'[data-code-block]', codePre:'[data-code-block] pre, [data-code-block] code',
    inlineCode:'.docs-article p > code', callout:'.mdx-callout',
    tocLink:'aside a[href^="#"]:not([aria-current="page"])', header:'header', prose:'.docs-article'
  } : {
    h1:'h1#_top', h2:'.sl-markdown-content h2', p:'.content-panel .sl-markdown-content > p',
    link:'.sl-markdown-content p a', eyebrow:'.se-eyebrow',
    sidebar:'.sidebar-pane', sidebarLink:'.sidebar-content a',
    sidebarActive:'.sidebar-content a[aria-current="page"]', sectionLabel:'.sidebar-content .group-label .large',
    codeFrame:'.expressive-code .frame', codePre:'.expressive-code .ec-line',
    inlineCode:'.sl-markdown-content p > code', callout:'.starlight-aside',
    tocLink:'starlight-toc a:not([aria-current="true"])', header:'.header', prose:'.sl-markdown-content'
  };
  const o = {};
  o.bodyBg = getComputedStyle(document.body).backgroundColor;
  o.bodyFont = getComputedStyle(document.body).fontFamily.split(',')[0].replace(/["']/g,'').trim();
  o.monoFont = (g(q(S.codePre),'fontFamily')||{fontFamily:null}).fontFamily;
  if(o.monoFont) o.monoFont = o.monoFont.split(',')[0].replace(/["']/g,'').trim();
  o.h1 = g(q(S.h1),'fontSize','fontWeight','color','letterSpacing','lineHeight');
  o.h2 = g(q(S.h2),'fontSize','fontWeight','color');
  o.p = g(q(S.p),'color','fontSize','lineHeight');
  o.link = g(q(S.link),'color','fontWeight');
  o.eyebrow = g(q(S.eyebrow),'color','fontSize','fontWeight');
  o.sidebarWidth = px(q(S.sidebar));
  o.sidebarLink = g(q(S.sidebarLink),'color','fontSize','borderLeftWidth','borderLeftColor');
  o.sidebarActive = g(q(S.sidebarActive),'color','borderLeftColor','fontWeight');
  o.sectionLabel = g(q(S.sectionLabel),'color','fontWeight','fontSize');
  o.codeFrame = g(q(S.codeFrame),'borderTopLeftRadius','borderTopColor');
  o.codeBg = bgOf(q(S.codePre));
  o.codeFontSize = (g(q(S.codePre),'fontSize')||{fontSize:null}).fontSize;
  o.inlineCode = g(q(S.inlineCode),'backgroundColor','color','borderTopLeftRadius','fontSize');
  o.callout = g(q(S.callout),'backgroundColor','borderTopColor','borderTopLeftRadius');
  o.tocLink = g(q(S.tocLink),'color','fontSize');
  { const h=q(S.header); o.headerHeight = h?Math.round(h.getBoundingClientRect().height):null; }
  o.headerBg = (g(q(S.header),'backgroundColor')||{}).backgroundColor;
  o.headerBorder = (g(q(S.header),'borderBottomColor')||{}).borderBottomColor;
  o.contentWidth = px(q(S.prose));
  return JSON.stringify(o);
})()`;

function ab(args) {
  return execFileSync("agent-browser", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function probe(url) {
  ab(["open", url]);
  ab(["set", "viewport", "1440", "1200"]);
  ab(["wait", "1500"]);
  const out = ab(["eval", PROBE]);
  const lines = out.split("\n").map((s) => s.trim()).filter(Boolean);
  // The eval result is printed (last line). It may be a JSON-encoded string.
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (!raw.startsWith('"') && !raw.startsWith("{")) continue;
    try {
      let v = JSON.parse(raw);
      if (typeof v === "string") v = JSON.parse(v);
      if (v && typeof v === "object") return v;
    } catch {}
  }
  throw new Error(`Could not parse probe output for ${url}:\n${out}`);
}

// --- comparison helpers ---------------------------------------------------
const norm = (c) => (c == null ? c : String(c).replace(/\s+/g, ""));
const num = (v) => (v == null ? NaN : parseFloat(v));
const cmp = {
  color: (a, b) => norm(a) === norm(b),
  exact: (a, b) => String(a) === String(b),
  px: (tol) => (a, b) => Math.abs(num(a) - num(b)) <= tol,
};

// metric path -> comparator. Nested paths use dots.
const SPEC = [
  ["bodyBg", cmp.color],
  ["bodyFont", cmp.exact],
  ["monoFont", cmp.exact],
  ["h1.fontSize", cmp.px(1)],
  ["h1.fontWeight", cmp.exact],
  ["h1.color", cmp.color],
  ["h1.letterSpacing", cmp.px(0.5)],
  ["h1.lineHeight", cmp.px(2)],
  ["h2.fontSize", cmp.px(1)],
  ["h2.fontWeight", cmp.exact],
  ["h2.color", cmp.color],
  ["p.color", cmp.color],
  ["p.fontSize", cmp.px(1)],
  ["p.lineHeight", cmp.px(2)],
  ["link.color", cmp.color],
  ["link.fontWeight", cmp.exact],
  ["eyebrow.color", cmp.color],
  ["eyebrow.fontSize", cmp.px(1)],
  ["eyebrow.fontWeight", cmp.exact],
  ["sidebarWidth", cmp.px(1)],
  ["sidebarLink.color", cmp.color],
  ["sidebarLink.fontSize", cmp.px(1)],
  ["sidebarLink.borderLeftWidth", cmp.px(1)],
  ["sidebarLink.borderLeftColor", cmp.color],
  ["sidebarActive.color", cmp.color],
  ["sidebarActive.borderLeftColor", cmp.color],
  ["sidebarActive.fontWeight", cmp.exact],
  ["sectionLabel.color", cmp.color],
  ["sectionLabel.fontWeight", cmp.exact],
  ["sectionLabel.fontSize", cmp.px(1)],
  ["codeFrame.borderTopLeftRadius", cmp.px(1)],
  ["codeFrame.borderTopColor", cmp.color],
  ["codeBg", cmp.color],
  ["codeFontSize", cmp.px(1)],
  ["inlineCode.backgroundColor", cmp.color],
  ["inlineCode.color", cmp.color],
  ["inlineCode.borderTopLeftRadius", cmp.px(1)],
  ["inlineCode.fontSize", cmp.px(1)],
  ["tocLink.color", cmp.color],
  ["tocLink.fontSize", cmp.px(1)],
  ["callout.backgroundColor", cmp.color, "callout"],
  ["callout.borderTopColor", cmp.color, "callout"],
  ["callout.borderTopLeftRadius", cmp.px(1), "callout"],
  ["headerBg", cmp.color],
  ["headerBorder", cmp.color],
  ["contentWidth", cmp.px(2)],
  // headerHeight intentionally NOT compared: Secure Exec uses a single-row
  // header (no product-section tab row), so it is ~64px vs Rivet's two-row
  // 129px by design.
];

const get = (o, path) => path.split(".").reduce((v, k) => (v == null ? v : v[k]), o);

console.error(`Rivet: ${RIVET_URL}`);
const rivet = probe(RIVET_URL);
console.error(`Secure Exec: ${SE_URL}`);
const se = probe(SE_URL);
console.error(`Rivet (callout): ${RIVET_CALLOUT}`);
const rivetC = probe(RIVET_CALLOUT);
console.error(`Secure Exec (callout): ${SE_CALLOUT}`);
const seC = probe(SE_CALLOUT);
const src = { main: [rivet, se], callout: [rivetC, seC] };

let fails = 0;
const rows = [];
for (const [path, comparator, source = "main"] of SPEC) {
  const [ra, rb] = src[source];
  const a = get(ra, path);
  const b = get(rb, path);
  const ok = a == null && b == null ? true : comparator(a, b);
  if (!ok) fails++;
  rows.push([ok ? "OK " : "FAIL", path, String(a), String(b)]);
}

const w = (s, n) => String(s).padEnd(n);
console.log("\n" + w("", 4) + " " + w("metric", 32) + " " + w("rivet", 26) + " secure-exec");
console.log("-".repeat(100));
for (const [st, path, a, b] of rows) {
  console.log(`${st === "OK " ? "  OK" : "FAIL"} ${w(path, 32)} ${w(a, 26)} ${b}`);
}
console.log("-".repeat(100));
console.log(`${fails === 0 ? "PASS" : "FAIL"}: ${SPEC.length - fails}/${SPEC.length} metrics match (${fails} mismatch${fails === 1 ? "" : "es"})`);
process.exit(fails === 0 ? 0 : 1);
