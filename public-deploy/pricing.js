/* Patch Estimator price book for 24 Hour Flood Pros.
   One sheet per estimate. Drywall and all-inclusive prices are never blended.
   Bucket prices are per patch (each), not per square foot.
   Over 100 SF uses a custom $/SF and is not inspect-locked.
*/
(function (root) {
  var SKIM_RATE_CENTS = 780;
  var PAINT_RATE_CENTS = 316;

  var BUCKETS = [
    { id: "under10", label: "Under 10 SF", matches: function (sf) { return sf < 10; } },
    { id: "10-30", label: "10–30 SF", matches: function (sf) { return sf >= 10 && sf <= 30; } },
    { id: "30-50", label: "30–50 SF", matches: function (sf) { return sf > 30 && sf <= 50; } },
    { id: "50-100", label: "50–100 SF", matches: function (sf) { return sf > 50 && sf <= 100; } }
  ];

  var SHEETS = {
    drywall: {
      id: "drywall",
      label: "Drywall only",
      baseCents: 74600,
      eachCents: { under10: 9700, "10-30": 13600, "30-50": 19000, "50-100": 26600 }
    },
    allin: {
      id: "allin",
      label: "All-inclusive",
      baseCents: 104000,
      eachCents: { under10: 14600, "10-30": 20200, "30-50": 27900, "50-100": 38500 }
    }
  };

  function formatMoney(cents) {
    var sign = cents < 0 ? "-" : "";
    var abs = Math.abs(Math.round(cents));
    var dollars = Math.floor(abs / 100);
    var rem = abs % 100;
    return sign + "$" + dollars.toLocaleString("en-US") + "." + String(rem).padStart(2, "0");
  }

  function parseAmount(raw) {
    if (raw == null) return null;
    var text = String(raw).trim().replace(/[$,]/g, "");
    if (!text) return null;
    if (!/^\d+(\.\d+)?$/.test(text)) return NaN;
    var value = Number(text);
    if (!isFinite(value)) return NaN;
    return Math.round(value * 100) / 100;
  }

  function bucketFor(sf) {
    for (var i = 0; i < BUCKETS.length; i += 1) {
      if (BUCKETS[i].matches(sf)) return BUCKETS[i];
    }
    return null;
  }

  function sheetById(id) {
    return SHEETS[id] || SHEETS.drywall;
  }

  function addon(label, raw, rateCents, errors) {
    var text = String(raw || "").trim();
    if (!text) return { sf: 0, cents: 0, rateCents: rateCents, invalid: false };
    var sf = parseAmount(text);
    if (sf == null || isNaN(sf) || sf < 0) {
      errors.push(label + " square feet must be a number.");
      return { sf: null, cents: 0, rateCents: rateCents, invalid: true };
    }
    return { sf: sf, cents: Math.round(sf * rateCents), rateCents: rateCents, invalid: false };
  }

  function priceEstimate(input) {
    var source = input || {};
    var sheet = sheetById(source.sheet);
    var errors = [];
    var patchLines = [];
    var patchesCents = 0;
    var patches = source.patches || [];

    patches.forEach(function (patch, index) {
      var location = String((patch && patch.location) || "").trim();
      var sfRaw = String((patch && patch.sf) || "").trim();
      var rateRaw = String((patch && patch.customRate) || "").trim();
      var lineNo = index + 1;
      if (!sfRaw && !location && !rateRaw) return;

      var sf = parseAmount(sfRaw);
      if (sf == null || isNaN(sf)) {
        errors.push("Patch " + lineNo + " needs a square-foot size.");
        patchLines.push({
          index: index, location: location, sf: null, invalid: true, locked: true,
          cents: 0, bucketLabel: "", detail: ""
        });
        return;
      }
      if (sf <= 0) {
        errors.push("Patch " + lineNo + " must be more than 0 SF.");
        patchLines.push({
          index: index, location: location, sf: sf, invalid: true, locked: true,
          cents: 0, bucketLabel: "", detail: ""
        });
        return;
      }
      if (sf > 100000) {
        errors.push("Patch " + lineNo + " is too large to price.");
        patchLines.push({
          index: index, location: location, sf: sf, invalid: true, locked: false,
          cents: 0, bucketLabel: "Over 100 SF", detail: ""
        });
        return;
      }

      if (sf > 100) {
        var rate = parseAmount(rateRaw);
        if (rate == null || isNaN(rate) || rate <= 0) {
          errors.push("Patch " + lineNo + " is over 100 SF. Enter a custom $ per SF.");
          patchLines.push({
            index: index, location: location, sf: sf, invalid: true, locked: false,
            cents: 0, bucketLabel: "Over 100 SF", detail: "Custom $ / SF"
          });
          return;
        }
        if (rate > 100000) {
          errors.push("Patch " + lineNo + " rate is too high.");
          patchLines.push({
            index: index, location: location, sf: sf, invalid: true, locked: false,
            cents: 0, bucketLabel: "Over 100 SF", detail: ""
          });
          return;
        }
        var rateCents = Math.round(rate * 100);
        var customCents = Math.round(sf * rateCents);
        patchesCents += customCents;
        patchLines.push({
          index: index,
          location: location,
          sf: sf,
          rate: rate,
          invalid: false,
          locked: false,
          cents: customCents,
          bucketLabel: "Over 100 SF",
          detail: formatMoney(rateCents) + " / SF"
        });
        return;
      }

      var bucket = bucketFor(sf);
      var eachCents = sheet.eachCents[bucket.id];
      patchesCents += eachCents;
      patchLines.push({
        index: index,
        location: location,
        sf: sf,
        invalid: false,
        locked: true,
        cents: eachCents,
        bucketLabel: bucket.label,
        detail: formatMoney(eachCents) + " each"
      });
    });

    var skim = addon("Skim coat", source.skimSf, SKIM_RATE_CENTS, errors);
    var paint = addon("Paint", source.paintSf, PAINT_RATE_CENTS, errors);
    var totalCents = sheet.baseCents + patchesCents + (skim.invalid ? 0 : skim.cents) + (paint.invalid ? 0 : paint.cents);

    return {
      ok: errors.length === 0,
      errors: errors,
      sheet: sheet,
      baseCents: sheet.baseCents,
      patchLines: patchLines,
      patchesCents: patchesCents,
      skim: skim,
      paint: paint,
      totalCents: totalCents
    };
  }

  function legend(sheetId) {
    var sheet = sheetById(sheetId);
    return BUCKETS.map(function (bucket) {
      return {
        id: bucket.id,
        label: bucket.label,
        eachCents: sheet.eachCents[bucket.id]
      };
    });
  }

  function estimateFilename(jobName) {
    var cleaned = String(jobName || "")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return (cleaned || "Job") + " Patch Estimate.pdf";
  }

  root.PatchPricing = {
    SHEETS: SHEETS,
    BUCKETS: BUCKETS,
    SKIM_RATE_CENTS: SKIM_RATE_CENTS,
    PAINT_RATE_CENTS: PAINT_RATE_CENTS,
    formatMoney: formatMoney,
    parseAmount: parseAmount,
    priceEstimate: priceEstimate,
    legend: legend,
    estimateFilename: estimateFilename,
    sheetById: sheetById
  };
})(this);
