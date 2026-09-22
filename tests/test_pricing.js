const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const context = {};
vm.createContext(context);
vm.runInContext(fs.readFileSync("public-deploy/pricing.js", "utf8"), context);
const P = context.PatchPricing;

function cents(estimate) {
  assert.strictEqual(estimate.ok, true, estimate.errors.join("; "));
  return estimate.totalCents;
}

const drywallPatches = [
  { sf: "8", location: "Hall" },
  { sf: "12", location: "Kitchen" },
  { sf: "40", location: "Bedroom" },
  { sf: "80", location: "Stair" },
  { sf: "120", customRate: "4" }
];

const drywall = P.priceEstimate({
  sheet: "drywall",
  patches: drywallPatches,
  skimSf: "10",
  paintSf: "5"
});
assert.strictEqual(drywall.baseCents, 74600);
assert.deepStrictEqual(Array.from(drywall.patchLines, (line) => line.cents), [9700, 13600, 19000, 26600, 48000]);
assert.strictEqual(drywall.patchLines[4].locked, false);
assert.strictEqual(drywall.patchLines[0].locked, true);
assert.strictEqual(drywall.skim.cents, 7800);
assert.strictEqual(drywall.paint.cents, 1580);
assert.strictEqual(cents(drywall), 200880);

const allin = P.priceEstimate({
  sheet: "allin",
  patches: drywallPatches,
  skimSf: "10",
  paintSf: "5"
});
assert.strictEqual(allin.baseCents, 104000);
assert.deepStrictEqual(Array.from(allin.patchLines, (line) => line.cents), [14600, 20200, 27900, 38500, 48000]);
assert.strictEqual(cents(allin), 262580);
allin.patchLines.slice(0, 4).forEach((line) => {
  assert.ok(![9700, 13600, 19000, 26600].includes(line.cents));
});

const edges = [
  ["9.99", "under10", 9700],
  ["10", "10-30", 13600],
  ["30", "10-30", 13600],
  ["30.01", "30-50", 19000],
  ["50", "30-50", 19000],
  ["50.01", "50-100", 26600],
  ["100", "50-100", 26600]
];
edges.forEach(([sf, bucket, eachCents]) => {
  const priced = P.priceEstimate({ sheet: "drywall", patches: [{ sf }] });
  assert.strictEqual(priced.ok, true, sf);
  assert.strictEqual(priced.patchLines[0].bucketLabel.includes(bucket === "under10" ? "Under 10" : bucket === "10-30" ? "10" : bucket === "30-50" ? "30" : "50"), true, sf);
  assert.strictEqual(priced.patchLines[0].cents, eachCents, sf);
  assert.strictEqual(priced.patchLines[0].locked, true, sf);
});

const over = P.priceEstimate({ sheet: "drywall", patches: [{ sf: "100.01" }] });
assert.strictEqual(over.ok, false);
assert.strictEqual(over.patchLines[0].locked, false);
assert.ok(/custom/i.test(over.errors[0]));

const custom = P.priceEstimate({ sheet: "allin", patches: [{ sf: "100.01", customRate: "2.5" }] });
assert.strictEqual(custom.ok, true);
assert.strictEqual(custom.patchLines[0].cents, Math.round(100.01 * 250));
assert.strictEqual(custom.patchLines[0].locked, false);

const blank = P.priceEstimate({ sheet: "drywall", patches: [{ location: "", sf: "", customRate: "" }] });
assert.strictEqual(blank.ok, true);
assert.strictEqual(blank.totalCents, 74600);
assert.strictEqual(blank.patchLines.length, 0);

const perPatch = P.priceEstimate({ sheet: "drywall", patches: [{ sf: "12" }] });
assert.strictEqual(perPatch.patchLines[0].cents, 13600);

const name = "POR-STR 123 Main";
const filename = P.estimateFilename(name);
assert.ok(filename.includes(name));
assert.ok(filename.endsWith(".pdf"));

const app = fs.readFileSync("public-deploy/app.js", "utf8");
assert.ok(app.includes("DEBOUNCE_MS = 300"));
assert.ok(app.includes("jobJnid"));
assert.ok(app.includes("confirmSend"));

console.log("pricing ok");
