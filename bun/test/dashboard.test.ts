// Regression tests over the SHIPPED dashboard scripts (root src/ui.html is what
// the live service serves; bun/src/ui.html is the variant). The real functions
// are extracted and run against a stub DOM, so these fail if the browser code
// regresses.

import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const FILES = ["../src/ui.html", "../../src/ui.html"];

function scriptOf(rel: string): string {
  const html = readFileSync(new URL(rel, import.meta.url), "utf8");
  return html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
}

/** Slice out `function name(...) { ... }` by matching braces. */
function fn(script: string, name: string): string {
  const at = script.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `function ${name} not found in shipped dashboard`);
  let depth = 0;
  const start = script.indexOf("{", at);
  let i = start;
  for (; i < script.length; i++) {
    const c = script[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) break;
  }
  return script.slice(at, i + 1);
}

function constOf(script: string, name: string): string {
  const at = script.indexOf(`const ${name} = `);
  assert.ok(at >= 0, `const ${name} not found`);
  return script.slice(at, script.indexOf("\n", at));
}

function constExpr(script: string, name: string): string {
  const head = `const ${name} = `;
  const at = script.indexOf(head);
  assert.ok(at >= 0, `const ${name} not found`);
  return script.slice(at + head.length, script.indexOf("\n", at)).replace(/;$/, "");
}

interface El {
  id: string;
  textContent: string;
  innerHTML: string;
  hidden: boolean;
  disabled: boolean;
  style: Record<string, string>;
  dataset: Record<string, string>;
  querySelectorAll: (sel: string) => El[];
}

interface Dom {
  els: Map<string, El>;
  el(id: string): El;
  document: { getElementById: (id: string) => El; querySelectorAll: () => El[] };
}

function makeDom(): Dom {
  const els = new Map<string, El>();
  const el = (id: string): El => {
    let e = els.get(id);
    if (!e) {
      e = {
        id, textContent: "", innerHTML: "", hidden: false, disabled: false,
        style: {}, dataset: {}, querySelectorAll: () => [],
      };
      els.set(id, e);
    }
    return e;
  };
  return { els, el, document: { getElementById: (id) => el(id), querySelectorAll: () => [] } };
}

/** Run `body` inside the dashboard script's scope, once per shipped copy. */
function harness(body: string, S: unknown): Dom[] {
  return FILES.map((file) => {
    const script = scriptOf(file);
    const src = `
      const document = ctx.document;
      const requestAnimationFrame = (f) => { f(); return 1; };
      let lastRender = {};
      let S = ctx.S;
      let logPage = 0;
      const $ = (id) => document.getElementById(id);
      const fmt = ${constExpr(script, "fmt")};
      const esc = ${constExpr(script, "esc")};
      ${constOf(script, "kindLabel")}
      ${constOf(script, "LOG_PER_PAGE")}
      ${fn(script, "escapeHtml")}
      ${fn(script, "md")}
      ${fn(script, "setTxt")}
      ${fn(script, "renderBurn")}
      ${fn(script, "renderDayChart")}
      ${fn(script, "renderModels")}
      ${fn(script, "renderLog")}
      ${body}
    `;
    const dom = makeDom();
    new Function("ctx", src)({ document: dom.document, S });
    return dom;
  });
}

const baseStats = {
  hourly: [], days: [], models: [], recent: [],
  status: {}, live: {}, server: {}, cache: {},
};

test("empty hourly data renders a notice, never NaN geometry", () => {
  for (const dom of harness("renderBurn();", { ...baseStats, hourly: [] })) {
    const svg = dom.el("burnChart").innerHTML;
    assert.ok(svg.length > 0);
    assert.ok(!svg.includes("NaN"), svg);
    assert.match(svg, /no usage yet/);
    assert.match(dom.el("burnSum").textContent, /^0 credits/);
  }
});

test("empty day data renders a notice, never NaN geometry", () => {
  for (const dom of harness("renderDayChart();", { ...baseStats, days: [] })) {
    const svg = dom.el("dayChart").innerHTML;
    assert.ok(!svg.includes("NaN"), svg);
    assert.match(svg, /no days recorded yet/);
  }
});

test("charts with data produce finite coordinates", () => {
  for (const dom of harness("renderBurn(); renderDayChart();", {
    ...baseStats,
    hourly: [{ ts: 1, credits: 2.5, requests: 3 }, { ts: 2, credits: 0, requests: 0 }],
    days: [{ ts: 1, credits: 10, requests: 4, pt: 1, ct: 2, errors: 0 }],
  })) {
    assert.ok(!dom.el("burnChart").innerHTML.includes("NaN"));
    assert.ok(!dom.el("dayChart").innerHTML.includes("NaN"));
  }
});

test("model list re-renders when values change but the row count does not", () => {
  const render = (credits: number) => harness("renderModels();", {
    ...baseStats,
    models: [{ model: "a", credits }, { model: "b", credits: 1 }],
  }).map((d) => d.el("modelList").innerHTML);
  const first = render(5);
  const second = render(7);
  assert.ok(first[0] !== second[0], "stale render: length-based cache key");
  assert.match(second[0], /7 cr/);
});

test("log row without a model does not throw", () => {
  for (const dom of harness("renderLog();", {
    ...baseStats,
    recent: [{ ts: Date.now(), kind: "chat", status: 0, pt: 0, ct: 0, credits: null, ms: 5, source: "chat" }],
  })) {
    const body = dom.el("logBody").innerHTML;
    assert.match(body, /chat/);
    assert.ok(!body.includes("undefined"));
  }
});

test("setTxt tolerates an element that is not in the DOM", () => {
  for (const dom of harness(`setTxt("nowhere", "x"); $("ok").textContent = "pass";`, baseStats)) {
    assert.equal(dom.el("ok").textContent, "pass");
  }
});

test("markdown output cannot break out of an href attribute", () => {
  for (const dom of harness(`$("out").innerHTML = md('[x](https://e.com/"onmouseover="alert(1))');`, baseStats)) {
    const out = dom.el("out").innerHTML;
    assert.ok(!/href="https:\/\/e\.com\/"onmouseover/.test(out), out);
    assert.match(out, /&quot;|&#39;/);
  }
});
