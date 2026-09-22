const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const app = fs.readFileSync("public-deploy/app.js", "utf8");
const html = fs.readFileSync("public-deploy/index.html", "utf8");

const context = {
  console,
  document: {
    readyState: "loading",
    addEventListener() {},
    getElementById() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  },
};
context.window = context;
vm.createContext(context);
vm.runInContext(app, context);
const PE = context.PatchEstimator;

function money(n) {
  return Math.round(n * 100) / 100;
}

const drywall = PE.calculate({
  sheet: "drywall",
  counts: { under10: 2, t10_30: 1, t30_50: 1, t50_100: 1, over100: 1 },
  over100Patches: [{ id: 1, sf: 140, customPrice: 500 }],
  customPatches: [],
  skimSf: 10,
  paintSf: 5,
});

assert.strictEqual(drywall.inspect, false);
assert.strictEqual(drywall.missingCustom, false);
assert.strictEqual(drywall.base, 746);
assert.strictEqual(drywall.skimCost, money(10 * 7.8));
assert.strictEqual(drywall.paintCost, money(5 * 3.16));
const drywallSheet = JSON.parse(JSON.stringify(PE.PRICING.drywall));
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(drywall.tierLines.map((line) => [line.label, line.count, line.unitPrice, line.subtotal]))),
  [
    [drywallSheet.tiers.under10.label, 2, 97, 194],
    [drywallSheet.tiers.t10_30.label, 1, 136, 136],
    [drywallSheet.tiers.t30_50.label, 1, 190, 190],
    [drywallSheet.tiers.t50_100.label, 1, 266, 266],
    ["Over 100 SF (custom)", 1, 500, 500],
  ]
);
assert.strictEqual(drywall.total, money(746 + 194 + 136 + 190 + 266 + 500 + 78 + 15.8));

const allin = PE.calculate({
  sheet: "inclusive",
  counts: { under10: 1, t10_30: 1, t30_50: 1, t50_100: 1, over100: 0 },
  over100Patches: [],
  customPatches: [],
  skimSf: 10,
  paintSf: 5,
});
assert.strictEqual(allin.inspect, false);
assert.strictEqual(allin.base, 1040);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(allin.tierLines.map((line) => line.unitPrice))),
  [146, 202, 279, 385]
);
assert.ok(!allin.tierLines.some((line) => [97, 136, 190, 266].includes(line.unitPrice)));
assert.strictEqual(allin.skimCost, 78);
assert.strictEqual(allin.paintCost, money(5 * 3.16));
assert.strictEqual(allin.total, money(1040 + 146 + 202 + 279 + 385 + 78 + 15.8));

const edges = [
  [9.99, "under10", 97],
  [10, "t10_30", 136],
  [30, "t10_30", 136],
  [30.01, "t30_50", 190],
  [50, "t30_50", 190],
  [50.01, "t50_100", 266],
  [100, "t50_100", 266],
];
edges.forEach(([sf, key, price]) => {
  const tier = PE.getTier("drywall", sf);
  assert.strictEqual(tier.needsCustom, false, String(sf));
  assert.strictEqual(tier.key, key, String(sf));
  assert.strictEqual(tier.price, price, String(sf));
  assert.strictEqual(tier.label, drywallSheet.tiers[key].label, String(sf));
});

const overTier = PE.getTier("inclusive", 100.01);
assert.strictEqual(overTier.needsCustom, true);
assert.strictEqual(overTier.key, "over100");

const incomplete = PE.calculate({
  sheet: "drywall",
  counts: { under10: 1, over100: 1 },
  over100Patches: [{ id: 2, sf: "", customPrice: null }],
  customPatches: [],
  skimSf: 0,
  paintSf: 0,
});
assert.strictEqual(incomplete.inspect, false);
assert.strictEqual(incomplete.missingCustom, true);
assert.strictEqual(incomplete.softNoteOver100, true);
assert.strictEqual(incomplete.base, 746);
assert.strictEqual(incomplete.total, 746 + 97);

const empty = PE.calculate({
  sheet: "drywall",
  counts: { under10: 0, t10_30: 0, t30_50: 0, t50_100: 0, over100: 0 },
  over100Patches: [],
  customPatches: [],
  skimSf: 12,
  paintSf: 4,
});
assert.strictEqual(empty.inspect, false);
assert.strictEqual(empty.base, 0);
assert.strictEqual(empty.total, 0);
assert.strictEqual(empty.patchCount, 0);

assert.strictEqual(PE.PRICING.drywall.base, 746);
assert.strictEqual(PE.PRICING.inclusive.base, 1040);
assert.strictEqual(PE.PRICING.drywall.skim, 7.8);
assert.strictEqual(PE.PRICING.drywall.paint, 3.16);
assert.strictEqual(PE.PRICING.inclusive.skim, 7.8);
assert.strictEqual(PE.PRICING.inclusive.paint, 3.16);
assert.deepStrictEqual(JSON.parse(JSON.stringify(PE.TIER_KEYS)), ["under10", "t10_30", "t30_50", "t50_100", "over100"]);

assert.ok(html.includes('data-sheet="drywall"'));
assert.ok(html.includes('data-sheet="inclusive"'));
assert.ok(html.includes('id="count-under10"'));
assert.ok(html.includes('id="count-t10_30"'));
assert.ok(html.includes('id="count-t30_50"'));
assert.ok(html.includes('id="count-t50_100"'));
assert.ok(html.includes('id="count-over100"'));
assert.ok(html.includes("$7.80 / SF"));
assert.ok(html.includes("$3.16 / SF"));
assert.ok(!/inspect-locked/i.test(html));
assert.ok(!html.includes("No inspect lock"));

assert.ok(app.includes("inspect: false"));
assert.ok(!app.includes("inspect-locked"));
assert.ok(!app.includes("No inspect lock"));
assert.ok(app.includes("const delay = opts.immediate ? 0 : 300"));
assert.ok(app.includes("scheduleJobSearch(q, { immediate: true })"));
assert.ok(app.includes('cache: "no-store"'));
assert.ok(!/localStorage|sessionStorage/.test(app));
assert.ok(app.includes("window.confirm("));
assert.ok(app.includes("jobJnid"));
assert.ok(!app.includes("create job"));

const pdfStart = app.indexOf("function buildEstimatePdf");
const pdfEnd = app.indexOf("async function downloadOrSharePdf");
const pdf = app.slice(pdfStart, pdfEnd);
assert.ok(pdfStart > 0 && pdfEnd > pdfStart);
assert.ok(pdf.includes('line("Job: " + state.jobName.trim()'));
assert.ok(!pdf.includes("addon mid"));
assert.ok(!pdf.includes("Patch counts"));
assert.ok(!/Rates from company price sheets/i.test(pdf));
assert.ok(!/inspect lock/i.test(pdf));

const savedSheet = context.PatchEstimator.getState().sheet;
const savedName = context.PatchEstimator.getState().jobName;
PE.setStateForTest({
  sheet: "drywall",
  jobName: "POR-STR 123 Main",
  counts: { under10: 1, t10_30: 0, t30_50: 0, t50_100: 0, over100: 0 },
  over100Patches: [],
  customPatches: [],
});
const filename = PE.pdfFileName();
assert.ok(filename.includes("POR-STR-123-Main"));
assert.ok(filename.endsWith(".pdf"));
PE.setStateForTest({ sheet: savedSheet, jobName: savedName });

console.log("pricing ok");
