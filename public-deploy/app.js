(function () {
  "use strict";


  /** Midpoint / representative SF used only for skim/paint area (editable via override). */
  const ADDON_SF_EACH = {
    under10: 5,
    t10_30: 20,
    t30_50: 40,
    t50_100: 75,
  };

  const TIER_KEYS = ["under10", "t10_30", "t30_50", "t50_100", "over100"];

  const TIER_LABELS = {
    under10: "Under 10 SF",
    t10_30: "10 SF – 30 SF",
    t30_50: "30 SF – 50 SF",
    t50_100: "50 SF – 100 SF",
    over100: "Over 100 SF",
  };

  const PRICING = {
    drywall: {
      label: "Drywall only",
      base: 746,
      tiers: {
        under10: { price: 97, label: "Under 10 SF" },
        t10_30: { price: 136, label: "10 SF – 30 SF" },
        t30_50: { price: 190, label: "30 SF – 50 SF" },
        t50_100: { price: 266, label: "50 SF – 100 SF" },
      },
      skim: 7.8,
      paint: 3.16,
      showPaint: true,
    },
    inclusive: {
      label: "All-inclusive",
      base: 1040,
      tiers: {
        under10: { price: 146, label: "Under 10 SF" },
        t10_30: { price: 202, label: "10 SF – 30 SF" },
        t30_50: { price: 279, label: "30 SF – 50 SF" },
        t50_100: { price: 385, label: "50 SF – 100 SF" },
      },
      skim: 7.8,
      paint: 3.16,
      showPaint: false,
    },
  };

  const state = {
    sheet: "drywall",
    counts: { under10: 0, t10_30: 0, t30_50: 0, t50_100: 0, over100: 0 },
    /** One entry per Over 100 SF patch: { id, sf, customPrice } */
    over100Patches: [],
    /** Optional one-offs: { id, sf, customPrice } */
    customPatches: [],
    skimSf: 0,
    paintSf: 0,
    notes: "",
    jobName: "",
    /** JN job jnid when user picks from autocomplete; cleared if they edit the name */
    selectedJobJnid: null,
    nextId: 1,
  };

  let jobSearchTimer = null;
  let jobSearchSeq = 0;
  let jobAcHighlight = -1;
  let jobAcResults = [];

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  function formatMoney(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return (
      "$" +
      n.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }

  function formatSF(n) {
    return Number(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  /**
   * Tier for a single patch SF (used by optional "Add patch by SF").
   * SF > 100 → needsCustom: true.
   */
  function getTier(sheetKey, sf) {
    const sheet = PRICING[sheetKey];
    const n = Number(sf);
    if (!(n > 0) || Number.isNaN(n)) {
      return { needsCustom: false, price: 0, label: "—", key: null };
    }
    if (n < 10) {
      return { needsCustom: false, price: sheet.tiers.under10.price, label: sheet.tiers.under10.label, key: "under10" };
    }
    if (n <= 30) {
      return { needsCustom: false, price: sheet.tiers.t10_30.price, label: sheet.tiers.t10_30.label, key: "t10_30" };
    }
    if (n <= 50) {
      return { needsCustom: false, price: sheet.tiers.t30_50.price, label: sheet.tiers.t30_50.label, key: "t30_50" };
    }
    if (n <= 100) {
      return { needsCustom: false, price: sheet.tiers.t50_100.price, label: sheet.tiers.t50_100.label, key: "t50_100" };
    }
    return { needsCustom: true, price: 0, label: "Over 100 SF (custom)", key: "over100" };
  }

  function syncOver100ListToCount() {
    const n = state.counts.over100 || 0;
    while (state.over100Patches.length < n) {
      state.over100Patches.push({
        id: state.nextId++,
        sf: "",
        customPrice: null,
      });
    }
    while (state.over100Patches.length > n) {
      state.over100Patches.pop();
    }
  }

  /** Representative SF for skim/paint from counters + over100 entries + custom patches. */
  function computeAddonSF(opts) {
    const c = opts.counts || {};
    let sf = 0;
    sf += (c.under10 || 0) * ADDON_SF_EACH.under10;
    sf += (c.t10_30 || 0) * ADDON_SF_EACH.t10_30;
    sf += (c.t30_50 || 0) * ADDON_SF_EACH.t30_50;
    sf += (c.t50_100 || 0) * ADDON_SF_EACH.t50_100;

    const overs = opts.over100Patches || [];
    for (const p of overs) {
      const n = Number(p.sf);
      if (n > 0 && !Number.isNaN(n)) sf += n;
    }

    const customs = opts.customPatches || [];
    for (const cp of customs) {
      const n = Number(cp.sf);
      if (n > 0 && !Number.isNaN(n)) sf += n;
    }

    return round2(sf);
  }


  /**
   * Per-patch pricing from tier counts + over100 + custom.
   * Never returns inspect lock — dollar total always works.
   */
  function calculate(opts) {
    const sheetKey = opts.sheet;
    const sheet = PRICING[sheetKey];
    const c = opts.counts || {};
    const bandCounts = {};
    let patchSubtotal = 0;
    let missingCustom = false;
    let patchCount = 0;
    let softNoteOver100 = false;

    function addBand(label, unitPrice, needsCustom) {
      if (!bandCounts[label]) {
        bandCounts[label] = { count: 0, unitPrice, subtotal: 0, needsCustom: !!needsCustom };
      }
      bandCounts[label].count += 1;
      bandCounts[label].subtotal = round2(bandCounts[label].subtotal + unitPrice);
      bandCounts[label].unitPrice = unitPrice;
      patchSubtotal = round2(patchSubtotal + unitPrice);
      patchCount += 1;
    }

    // Fixed sheet tiers (priced each)
    ["under10", "t10_30", "t30_50", "t50_100"].forEach((key) => {
      const count = c[key] || 0;
      const tier = sheet.tiers[key];
      for (let i = 0; i < count; i++) {
        addBand(tier.label, tier.price, false);
      }
    });

    // Over 100 — each needs SF + custom $
    const overs = opts.over100Patches || [];
    for (const p of overs) {
      softNoteOver100 = true;
      const sf = Number(p.sf);
      const cp = p.customPrice;
      const hasSf = sf > 0 && !Number.isNaN(sf);
      const hasPrice = cp != null && cp !== "" && !Number.isNaN(Number(cp));
      if (!hasSf || !hasPrice) {
        missingCustom = true;
        addBand("Over 100 SF (enter SF & $)", 0, true);
      } else {
        addBand("Over 100 SF (custom)", Number(cp), true);
      }
    }

    // Optional add-by-SF patches
    const customs = opts.customPatches || [];
    for (const cp of customs) {
      const sf = Number(cp.sf);
      if (!(sf > 0) || Number.isNaN(sf)) continue;
      const tier = getTier(sheetKey, sf);
      if (tier.needsCustom) {
        softNoteOver100 = true;
        const price = cp.customPrice;
        if (price == null || price === "" || Number.isNaN(Number(price))) {
          missingCustom = true;
          addBand("Over 100 SF (enter price)", 0, true);
        } else {
          addBand("Over 100 SF (custom)", Number(price), true);
        }
      } else {
        addBand(tier.label, tier.price, false);
      }
    }

    const computedSf = computeAddonSF(opts);
    const skimSf = Math.max(0, Number(opts.skimSf) || 0);
    const paintSf = Math.max(0, Number(opts.paintSf) || 0);

    // Independent typed SF: skim always available; paint on drywall, or optional extra on all-inclusive
    const skimOn = skimSf > 0;
    const paintAllowed = true; // both sheets: paint SF is typed; all-inclusive treats as optional extra
    const paintOn = paintAllowed && paintSf > 0;
    const skimCost = skimOn ? round2(skimSf * sheet.skim) : 0;
    const paintCost = paintOn ? round2(paintSf * sheet.paint) : 0;
    const sf = round2(skimSf + paintSf); // display helper only

    const hasPatches = patchCount > 0;
    const base = hasPatches ? sheet.base : 0;
    const total = hasPatches
      ? round2(base + patchSubtotal + skimCost + paintCost)
      : 0;

    // Stable display order matching sheet
    const order = [
      sheet.tiers.under10.label,
      sheet.tiers.t10_30.label,
      sheet.tiers.t30_50.label,
      sheet.tiers.t50_100.label,
      "Over 100 SF (custom)",
      "Over 100 SF (enter SF & $)",
      "Over 100 SF (enter price)",
    ];
    const tierLines = [];
    const seen = new Set();
    order.forEach((label) => {
      if (bandCounts[label]) {
        const b = bandCounts[label];
        tierLines.push({
          label,
          count: b.count,
          unitPrice: b.unitPrice,
          subtotal: b.subtotal,
          needsCustom: b.needsCustom,
          display: b.count + " × " + label + " @ " + formatMoney(b.unitPrice),
        });
        seen.add(label);
      }
    });
    Object.keys(bandCounts).forEach((label) => {
      if (seen.has(label)) return;
      const b = bandCounts[label];
      tierLines.push({
        label,
        count: b.count,
        unitPrice: b.unitPrice,
        subtotal: b.subtotal,
        needsCustom: b.needsCustom,
        display: b.count + " × " + label + " @ " + formatMoney(b.unitPrice),
      });
    });

    return {
      sf,
      computedSf,
      inspect: false,
      missingCustom,
      base,
      patchSubtotal,
      tierLines,
      patchCount,
      skimCost,
      paintCost,
      skimOn,
      paintOn,
      skimSf,
      paintSf,
      total,
      sheetLabel: sheet.label,
      softNoteOver100,
    };
  }

  // --- DOM ---
  const $ = (id) => document.getElementById(id);

  function syncCountInputs() {
    TIER_KEYS.forEach((key) => {
      const el = $("count-" + key);
      if (el) el.value = state.counts[key] || 0;
    });
  }

  function updatePriceHints() {
    const sheet = PRICING[state.sheet];
    $("price-hint-under10").textContent = formatMoney(sheet.tiers.under10.price) + " each";
    $("price-hint-t10_30").textContent = formatMoney(sheet.tiers.t10_30.price) + " each";
    $("price-hint-t30_50").textContent = formatMoney(sheet.tiers.t30_50.price) + " each";
    $("price-hint-t50_100").textContent = formatMoney(sheet.tiers.t50_100.price) + " each";
  }

  function updateSheetUI() {
    const sheet = PRICING[state.sheet];
    document.querySelectorAll(".seg-btn").forEach((btn) => {
      const active = btn.dataset.sheet === state.sheet;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-checked", active ? "true" : "false");
    });
    $("sheet-hint").textContent = sheet.showPaint
      ? "Base $" + sheet.base + " · per patch · paint add-on available"
      : "Base $" + sheet.base + " · per patch · paint included on tiers (extra paint SF optional)";
    const paintNote = $("paint-extra-note");
    const paintLabel = $("paint-sf-label");
    if (sheet.showPaint) {
      paintNote.classList.add("hidden");
      paintLabel.innerHTML = 'Paint — SF <small class="rate-tag">$3.16 / SF</small>';
    } else {
      paintNote.classList.remove("hidden");
      paintLabel.innerHTML = 'Extra paint — SF <small class="rate-tag">$3.16 / SF</small>';
    }
    updatePriceHints();
  }

  function renderOver100List() {
    const wrap = $("over100-list-wrap");
    const list = $("over100-list");
    syncOver100ListToCount();
    if (!state.over100Patches.length) {
      wrap.classList.add("hidden");
      list.innerHTML = "";
      return;
    }
    wrap.classList.remove("hidden");
    list.innerHTML = "";
    state.over100Patches.forEach((cp, idx) => {
      const row = document.createElement("div");
      row.className = "custom-patch-row over100-row";
      row.dataset.id = String(cp.id);

      const label = document.createElement("span");
      label.className = "over100-index";
      label.textContent = "#" + (idx + 1);

      const sfField = document.createElement("label");
      sfField.className = "field field-inline";
      sfField.innerHTML = "<span>SF</span>";
      const sfInput = document.createElement("input");
      sfInput.type = "number";
      sfInput.inputMode = "decimal";
      sfInput.step = "0.01";
      sfInput.min = "0";
      sfInput.placeholder = ">100";
      sfInput.value = cp.sf === "" || cp.sf == null ? "" : cp.sf;
      sfInput.setAttribute("aria-label", "Over 100 patch " + (idx + 1) + " SF");
      sfInput.addEventListener("input", (e) => {
        const n = parseFloat(e.target.value);
        cp.sf = e.target.value.trim() === "" || Number.isNaN(n) ? "" : n;
        render();
      });
      sfField.appendChild(sfInput);

      const priceField = document.createElement("label");
      priceField.className = "field field-inline";
      priceField.innerHTML = "<span>Price $</span>";
      const priceInput = document.createElement("input");
      priceInput.type = "number";
      priceInput.inputMode = "decimal";
      priceInput.step = "0.01";
      priceInput.min = "0";
      priceInput.placeholder = "Custom $";
      priceInput.value =
        cp.customPrice == null || cp.customPrice === "" ? "" : cp.customPrice;
      priceInput.setAttribute("aria-label", "Over 100 patch " + (idx + 1) + " custom price");
      priceInput.addEventListener("input", (e) => {
        const n = parseFloat(e.target.value);
        cp.customPrice = e.target.value.trim() === "" || Number.isNaN(n) ? null : n;
        render();
      });
      priceField.appendChild(priceInput);

      row.appendChild(label);
      row.appendChild(sfField);
      row.appendChild(priceField);
      list.appendChild(row);
    });
  }

  function renderCustomList() {
    const list = $("custom-patch-list");
    if (!list) return;
    list.innerHTML = "";
    if (!state.customPatches.length) {
      list.classList.add("empty");
      return;
    }
    list.classList.remove("empty");
    state.customPatches.forEach((cp) => {
      const sf = Number(cp.sf) || 0;
      const needsCustom = sf > 100;
      const row = document.createElement("div");
      row.className = "custom-patch-row";
      row.dataset.id = String(cp.id);

      const sfField = document.createElement("label");
      sfField.className = "field field-inline";
      sfField.innerHTML = "<span>SF</span>";
      const sfInput = document.createElement("input");
      sfInput.type = "number";
      sfInput.inputMode = "decimal";
      sfInput.step = "0.01";
      sfInput.min = "0";
      sfInput.value = cp.sf === "" || cp.sf == null ? "" : cp.sf;
      sfInput.setAttribute("aria-label", "Custom patch SF");
      sfInput.addEventListener("input", (e) => {
        const n = parseFloat(e.target.value);
        cp.sf = e.target.value.trim() === "" || Number.isNaN(n) ? "" : n;
        if (!(Number(cp.sf) > 100)) cp.customPrice = null;
        render();
      });
      sfField.appendChild(sfInput);

      const priceField = document.createElement("label");
      priceField.className = "field field-inline" + (needsCustom ? "" : " hidden");
      priceField.innerHTML = "<span>Price $</span>";
      const priceInput = document.createElement("input");
      priceInput.type = "number";
      priceInput.inputMode = "decimal";
      priceInput.step = "0.01";
      priceInput.min = "0";
      priceInput.placeholder = "Required >100 SF";
      priceInput.value =
        cp.customPrice == null || cp.customPrice === "" ? "" : cp.customPrice;
      priceInput.setAttribute("aria-label", "Custom patch price over 100 SF");
      priceInput.addEventListener("input", (e) => {
        const n = parseFloat(e.target.value);
        cp.customPrice = e.target.value.trim() === "" || Number.isNaN(n) ? null : n;
        render();
      });
      priceField.appendChild(priceInput);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn-icon";
      removeBtn.setAttribute("aria-label", "Remove patch");
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => {
        state.customPatches = state.customPatches.filter((p) => p.id !== cp.id);
        render();
      });

      row.appendChild(sfField);
      row.appendChild(priceField);
      row.appendChild(removeBtn);
      list.appendChild(row);
    });
  }

  function render() {
    const result = calculate(state);

    $("line-base").textContent = formatMoney(result.base);

    const tierContainer = $("tier-lines");
    tierContainer.innerHTML = "";
    if (result.tierLines.length === 0) {
      const li = document.createElement("li");
      li.innerHTML = "<span>Patches</span><span>$0.00</span>";
      tierContainer.appendChild(li);
    } else {
      result.tierLines.forEach((line) => {
        const li = document.createElement("li");
        const left = document.createElement("span");
        left.textContent = line.display;
        const right = document.createElement("span");
        right.textContent = formatMoney(line.subtotal);
        li.appendChild(left);
        li.appendChild(right);
        tierContainer.appendChild(li);
      });
    }

    const skimRow = $("line-skim-row");
    const paintRow = $("line-paint-row");
    if (result.skimOn) {
      skimRow.classList.remove("hidden");
      $("line-skim").textContent = formatMoney(result.skimCost);
      $("line-skim-label").textContent =
        "Skim & retexture (" + formatSF(result.skimSf) + " SF × $7.80)";
    } else {
      skimRow.classList.add("hidden");
    }
    if (result.paintOn) {
      paintRow.classList.remove("hidden");
      $("line-paint").textContent = formatMoney(result.paintCost);
      $("line-paint-label").textContent =
        (PRICING[state.sheet].showPaint ? "Paint (" : "Extra paint (") +
        formatSF(result.paintSf) + " SF × $3.16)";
    } else {
      paintRow.classList.add("hidden");
    }

    const wrap = $("grand-total-wrap");
    const softNote = $("soft-note");
    const missingMsg = $("missing-custom-msg");
    const totalCard = document.querySelector(".total-card");

    wrap.classList.remove("hidden");
    totalCard.classList.remove("inspect");
    $("grand-total").textContent = formatMoney(result.total);

    if (result.softNoteOver100) {
      softNote.classList.remove("hidden");
    } else {
      softNote.classList.add("hidden");
    }

    if (result.missingCustom) {
      missingMsg.classList.remove("hidden");
    } else {
      missingMsg.classList.add("hidden");
    }

    renderOver100List();
    renderCustomList();
  }

  function buildQuoteText() {
    const result = calculate(state);
    const parts = [];
    TIER_KEYS.forEach((key) => {
      const n = state.counts[key] || 0;
      if (n) parts.push(n + " × " + TIER_LABELS[key]);
    });
    if (state.customPatches.length) {
      parts.push(state.customPatches.length + " by-SF");
    }
    const countsStr = parts.length ? parts.join(", ") : "No patches";
    const sheetLabel = PRICING[state.sheet].label;
    const sfStr = formatSF(result.sf) + " SF";
    const priceStr = formatMoney(result.total);

    const breakdownParts = [];
    breakdownParts.push("Base " + formatMoney(result.base));
    result.tierLines.forEach((l) => {
      breakdownParts.push(l.display + " = " + formatMoney(l.subtotal));
    });
    if (result.skimOn) breakdownParts.push("Skim " + formatMoney(result.skimCost));
    if (result.paintOn) breakdownParts.push("Paint " + formatMoney(result.paintCost));

    let extras = [];
    if (state.skimSf > 0) extras.push("skim " + formatSF(state.skimSf) + " SF");
    if (state.paintSf > 0) extras.push("paint " + formatSF(state.paintSf) + " SF");

    let line =
      countsStr +
      " | " +
      sheetLabel +
      " | " +
      result.patchCount +
      " patches | " +
      sfStr +
      " | " +
      priceStr;
    if (extras.length) line += " (" + extras.join(" + ") + ")";
    line += "\n" + breakdownParts.join("; ");
    if (result.missingCustom) {
      line += "\nNote: enter SF & custom $ for patch(es) over 100 SF";
    }
    if (state.jobName.trim()) line += "\nJob: " + state.jobName.trim();
    if (state.notes.trim()) line += "\nNotes: " + state.notes.trim();
    return line;
  }

  function showToast(msg, isError, ms) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.toggle("error", !!isError);
    t.classList.remove("hidden");
    clearTimeout(showToast._timer);
    const dur = ms != null ? ms : (isError ? 4500 : 2800);
    showToast._timer = setTimeout(() => t.classList.add("hidden"), dur);
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const s = String(reader.result || "");
        const i = s.indexOf(",");
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      reader.onerror = () => reject(new Error("Could not read PDF"));
      reader.readAsDataURL(blob);
    });
  }

  async function sendToJobNimbus() {
    const jobName = (state.jobName || "").trim();
    const jobJnid = state.selectedJobJnid || null;
    if (!jobName && !jobJnid) {
      showToast("Pick a POR-STR or POR-MIT JobNimbus job (type to search)", true);
      const el = $("job-name");
      if (el) el.focus();
      return;
    }
    const confirmLabel = jobName || ("job " + jobJnid);
    if (!window.confirm("Attach this patch estimate PDF to JobNimbus job:\n\n" + confirmLabel + "?")) {
      return;
    }

    const btn = $("btn-jn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Sending to JobNimbus…";
    }
    try {
      const JsPDF = await loadJsPdf();
      const doc = buildEstimatePdf(JsPDF);
      const filename = pdfFileName();
      const blob = doc.output("blob");
      const pdfBase64 = await blobToBase64(blob);

      const body = { jobName: jobName, filename: filename, pdfBase64: pdfBase64 };
      if (jobJnid) body.jobJnid = jobJnid;

      const resp = await fetch("/api/jobnimbus/send", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      let data = null;
      try {
        data = await resp.json();
      } catch (_) {
        data = null;
      }

      if (!data) {
        showToast("Network or server error talking to JobNimbus", true, 5000);
        return;
      }

      if (data.ok) {
        const j = data.job || {};
        const label = (j.name || jobName) + (j.number ? " (#" + j.number + ")" : "");
        showToast("Attached to JobNimbus: " + label, false, 4500);
        return;
      }

      const human = data.message || null;

      if (data.error === "not_found") {
        showToast(human || "No POR-STR / POR-MIT JobNimbus job found for that name. Pick one from the list — jobs are not created automatically.", true, 6000);
        return;
      }

      if (data.error === "multiple_jobs") {
        const jobs = Array.isArray(data.jobs) ? data.jobs : [];
        let detail = human || "Multiple POR-STR / POR-MIT jobs match. Pick one from the autocomplete list.";
        if (jobs.length && jobs.length <= 5) {
          detail += "\n" + jobs.map((j) => "• " + (j.name || "?") + (j.number ? " (#" + j.number + ")" : "")).join("\n");
        } else if (jobs.length > 5) {
          detail += " (" + jobs.length + " matches)";
        }
        showToast(detail, true, 8000);
        return;
      }

      if (data.error === "not_por_str") {
        showToast(human || "Only POR-STR or POR-MIT jobs are allowed. Pick a job whose name includes POR-STR or POR-MIT.", true, 6000);
        return;
      }

      if (data.error === "missing_job_name" || data.error === "missing_job") {
        showToast(human || "Pick a POR-STR or POR-MIT JobNimbus job from the list", true);
        return;
      }

      const msg = human || data.error || ("HTTP " + resp.status);
      showToast("JobNimbus error: " + msg, true, 6000);
    } catch (err) {
      console.error(err);
      showToast("Could not send to JobNimbus (network?)", true, 5000);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Send to JobNimbus";
      }
    }
  }

  // --- PDF export ---
  let jsPdfLoadPromise = null;

  function loadJsPdf() {
    if (window.jspdf && window.jspdf.jsPDF) {
      return Promise.resolve(window.jspdf.jsPDF);
    }
    if (jsPdfLoadPromise) return jsPdfLoadPromise;
    jsPdfLoadPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector("script[data-jspdf]");
      if (existing) {
        existing.addEventListener("load", () => {
          if (window.jspdf && window.jspdf.jsPDF) resolve(window.jspdf.jsPDF);
          else reject(new Error("jsPDF failed to load"));
        });
        existing.addEventListener("error", () => reject(new Error("jsPDF script error")));
        return;
      }
      const s = document.createElement("script");
      s.src = "vendor/jspdf.umd.min.js";
      s.async = true;
      s.dataset.jspdf = "1";
      s.onload = () => {
        if (window.jspdf && window.jspdf.jsPDF) resolve(window.jspdf.jsPDF);
        else reject(new Error("jsPDF failed to load"));
      };
      s.onerror = () => {
        jsPdfLoadPromise = null;
        reject(new Error("Could not load PDF library"));
      };
      document.head.appendChild(s);
    });
    return jsPdfLoadPromise;
  }

  function pdfFileName() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    let job = (state.jobName || "").trim();
    if (job) {
      job = job.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    }
    return job
      ? "Patch-Estimate-" + job + "-" + yyyy + "-" + mm + "-" + dd + ".pdf"
      : "Patch-Estimate-" + yyyy + "-" + mm + "-" + dd + ".pdf";
  }

  function formatDateTime(d) {
    try {
      return d.toLocaleString("en-US", {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch (_) {
      return d.toISOString();
    }
  }

  function summarizeCounts() {
    const parts = [];
    ["under10", "t10_30", "t30_50", "t50_100"].forEach((key) => {
      const n = state.counts[key] || 0;
      if (!n) return;
      parts.push({
        label: TIER_LABELS[key],
        count: n,
        sfEach: ADDON_SF_EACH[key],
        sfTotal: round2(n * ADDON_SF_EACH[key]),
        note: "addon mid " + ADDON_SF_EACH[key] + " SF",
      });
    });
    state.over100Patches.forEach((cp, idx) => {
      const sf = Number(cp.sf);
      parts.push({
        label: "Over 100 SF #" + (idx + 1),
        count: 1,
        sfEach: sf > 0 ? sf : 0,
        sfTotal: sf > 0 ? sf : 0,
        note: "custom $",
      });
    });
    state.customPatches.forEach((cp, idx) => {
      const sf = Number(cp.sf);
      if (!(sf > 0) || Number.isNaN(sf)) return;
      parts.push({
        label: "By SF #" + (idx + 1),
        count: 1,
        sfEach: sf,
        sfTotal: sf,
        note: "",
      });
    });
    return parts;
  }

  function buildEstimatePdf(JsPDF) {
    const result = calculate(state);
    const doc = new JsPDF({ unit: "pt", format: "letter" });
    const margin = 48;
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const maxW = pageW - margin * 2;
    let y = margin;

    function ensureSpace(needed) {
      if (y + needed > pageH - margin) {
        doc.addPage();
        y = margin;
      }
    }

    function line(text, opts) {
      opts = opts || {};
      const size = opts.size || 10;
      const style = opts.style || "normal";
      const color = opts.color || [18, 38, 58];
      doc.setFont("helvetica", style);
      doc.setFontSize(size);
      doc.setTextColor(color[0], color[1], color[2]);
      const lines = doc.splitTextToSize(String(text), opts.width || maxW);
      const lineH = size * 1.35;
      ensureSpace(lines.length * lineH + (opts.gapAfter || 0));
      doc.text(lines, opts.x || margin, y);
      y += lines.length * lineH + (opts.gapAfter || 4);
    }

    function row(left, right, opts) {
      opts = opts || {};
      const size = opts.size || 10;
      const style = opts.style || "normal";
      doc.setFont("helvetica", style);
      doc.setFontSize(size);
      doc.setTextColor(18, 38, 58);
      ensureSpace(size * 1.5 + (opts.gapAfter || 0));
      doc.text(String(left), margin, y);
      doc.text(String(right), pageW - margin, y, { align: "right" });
      y += size * 1.45 + (opts.gapAfter || 2);
    }

    function rule() {
      ensureSpace(12);
      doc.setDrawColor(213, 222, 232);
      doc.setLineWidth(0.8);
      doc.line(margin, y, pageW - margin, y);
      y += 10;
    }

    line("24 Hour Flood Pros of Portland", {
      size: 16,
      style: "bold",
      color: [11, 61, 92],
      gapAfter: 2,
    });
    line("Patch Estimate", {
      size: 13,
      style: "bold",
      color: [20, 116, 168],
      gapAfter: 8,
    });
    rule();

    line("Date: " + formatDateTime(new Date()), { size: 10, gapAfter: 2 });
    line("Price sheet: " + result.sheetLabel, { size: 10, gapAfter: 2 });
    if (state.jobName && state.jobName.trim()) {
      line("Job: " + state.jobName.trim(), { size: 11, style: "bold", gapAfter: 2 });
    }
    line(
      result.patchCount +
        " patch" +
        (result.patchCount === 1 ? "" : "es"),
      { size: 10, gapAfter: 6 }
    );

    if (state.notes && state.notes.trim()) {
      line("Job notes", { size: 10, style: "bold", gapAfter: 2 });
      line(state.notes.trim(), { size: 10, gapAfter: 8 });
    }

    if (result.tierLines.length) {
      line("Per-patch pricing", { size: 11, style: "bold", gapAfter: 4 });
      result.tierLines.forEach((tl) => {
        row(tl.display, formatMoney(tl.subtotal), { size: 10 });
      });
      y += 4;
    }

    rule();
    line("Itemized breakdown", { size: 11, style: "bold", gapAfter: 4 });
    row("Base", formatMoney(result.base), { size: 10 });
    result.tierLines.forEach((tl) => {
      row(tl.display, formatMoney(tl.subtotal), { size: 10 });
    });
    if (result.skimOn) {
      row(
        "Skim & retexture (" + formatSF(result.skimSf) + " SF × $7.80)",
        formatMoney(result.skimCost),
        { size: 10 }
      );
    }
    if (result.paintOn) {
      row(
        (PRICING[state.sheet].showPaint ? "Paint (" : "Extra paint (") +
          formatSF(result.paintSf) +
          " SF × $3.16)",
        formatMoney(result.paintCost),
        { size: 10 }
      );
    }
    y += 4;
    rule();
    row("Total", formatMoney(result.total), { size: 14, style: "bold", gapAfter: 10 });

    if (result.missingCustom) {
      line(
        "Note: Enter SF and custom $ for each patch over 100 SF to complete the quote.",
        { size: 9, color: [180, 35, 24], gapAfter: 6 }
      );
    }

    if (result.softNoteOver100) {
      rule();
      line(
        "One or more patches exceed 100 SF and used a custom patch price (printed sheet mentions site inspection for >100 SF).",
        { size: 8, color: [90, 106, 122], gapAfter: 4 }
      );
    }

    return doc;
  }

  /**
   * Prefer download/save (.pdf for JobNimbus). On iOS (download attr is weak),
   * fall back to the native share sheet so Save to Files / share still works.
   */
  async function downloadOrSharePdf(blob, filename) {
    const file = new File([blob], filename, { type: "application/pdf" });
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent || "") ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

    if (isIOS && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: "Patch Estimate",
          text: filename,
        });
        showToast("PDF ready — " + filename);
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
        // fall through to download
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast("PDF downloaded — " + filename);
  }

  async function createPdf() {
    const btn = $("btn-pdf");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Downloading PDF…";
    }
    try {
      const JsPDF = await loadJsPdf();
      const doc = buildEstimatePdf(JsPDF);
      const filename = pdfFileName();
      const blob = doc.output("blob");
      await downloadOrSharePdf(blob, filename);
    } catch (err) {
      console.error(err);
      showToast("Could not create PDF", true);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Download PDF";
      }
    }
  }

  async function shareQuote() {
    const text = buildQuoteText();
    try {
      if (navigator.share) {
        await navigator.share({ title: "Patch Quote", text });
        showToast("Shared");
        return;
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast("Quote copied");
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        showToast("Quote copied");
      } catch (__) {
        showToast("Could not copy", true);
      }
      document.body.removeChild(ta);
    }
  }

  function resetJob() {
    state.counts = { under10: 0, t10_30: 0, t30_50: 0, t50_100: 0, over100: 0 };
    state.over100Patches = [];
    state.customPatches = [];
    state.skimSf = 0;
    state.paintSf = 0;
    state.notes = "";
    state.jobName = "";
    state.selectedJobJnid = null;
    $("skim-sf").value = "";
    $("paint-sf").value = "";
    $("job-name").value = "";
    $("job-notes").value = "";
    clearJobSelectionHighlight();
    hideJobAcList();
    syncCountInputs();
    render();
    showToast("Job reset");
  }

  function addCustomPatch() {
    state.customPatches.push({
      id: state.nextId++,
      sf: "",
      customPrice: null,
    });
    render();
  }

  function setCount(key, v) {
    state.counts[key] = v;
    if (key === "over100") syncOver100ListToCount();
    syncCountInputs();
    render();
  }

  function bind() {
    document.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.sheet = btn.dataset.sheet;
        updateSheetUI();
        render();
      });
    });

    document.querySelectorAll(".step-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.key;
        const action = btn.dataset.action;
        let v = state.counts[key] || 0;
        if (action === "inc") v += 1;
        else v = Math.max(0, v - 1);
        setCount(key, v);
      });
    });

    TIER_KEYS.forEach((key) => {
      const el = $("count-" + key);
      if (!el) return;
      el.addEventListener("input", (e) => {
        let v = parseInt(e.target.value, 10);
        if (Number.isNaN(v) || v < 0) v = 0;
        setCount(key, v);
      });
      el.addEventListener("blur", (e) => {
        e.target.value = state.counts[key];
      });
    });

    function parseSfInput(raw) {
      const n = parseFloat(String(raw).trim());
      if (raw === "" || raw == null || Number.isNaN(n) || n < 0) return 0;
      return n;
    }

    $("skim-sf").addEventListener("input", (e) => {
      state.skimSf = parseSfInput(e.target.value);
      render();
    });
    $("paint-sf").addEventListener("input", (e) => {
      state.paintSf = parseSfInput(e.target.value);
      render();
    });

    $("job-notes").addEventListener("input", (e) => {
      state.notes = e.target.value;
    });

    bindJobAutocomplete();

    $("btn-pdf").addEventListener("click", createPdf);
    const btnJn = $("btn-jn");
    if (btnJn) btnJn.addEventListener("click", sendToJobNimbus);
    $("btn-share").addEventListener("click", shareQuote);
    $("btn-reset").addEventListener("click", resetJob);
  }

  function clearJobSelectionHighlight() {
    const input = $("job-name");
    if (input) input.classList.remove("job-selected");
  }

  function setJobSelectedUI(selected) {
    const input = $("job-name");
    if (!input) return;
    input.classList.toggle("job-selected", !!selected);
  }

  function hideJobAcList() {
    const list = $("job-ac-list");
    const input = $("job-name");
    if (list) {
      list.classList.add("hidden");
      list.innerHTML = "";
    }
    if (input) input.setAttribute("aria-expanded", "false");
    jobAcHighlight = -1;
    jobAcResults = [];
  }

  function setJobAcStatus(text) {
    const el = $("job-ac-status");
    if (!el) return;
    if (!text) {
      el.textContent = "";
      el.classList.add("hidden");
      return;
    }
    el.textContent = text;
    el.classList.remove("hidden");
  }

  function renderJobAcList(jobs) {
    const list = $("job-ac-list");
    const input = $("job-name");
    if (!list || !input) return;
    jobAcResults = jobs || [];
    jobAcHighlight = -1;
    list.innerHTML = "";
    if (!jobAcResults.length) {
      const li = document.createElement("li");
      li.className = "job-ac-empty";
      li.textContent = "No POR-STR / POR-MIT jobs match";
      list.appendChild(li);
      list.classList.remove("hidden");
      input.setAttribute("aria-expanded", "true");
      return;
    }
    jobAcResults.forEach((job, idx) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.id = "job-ac-opt-" + idx;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "job-ac-item";
      btn.setAttribute("aria-selected", "false");
      const nameEl = document.createElement("span");
      nameEl.className = "job-ac-item-name";
      nameEl.textContent = job.name || "(unnamed)";
      const metaEl = document.createElement("span");
      metaEl.className = "job-ac-item-meta";
      const bits = [];
      if (job.number) bits.push("#" + job.number);
      if (job.status_name) bits.push(job.status_name);
      if (job.address_line1) bits.push(job.address_line1);
      metaEl.textContent = bits.join(" · ");
      btn.appendChild(nameEl);
      if (bits.length) btn.appendChild(metaEl);
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep focus; avoid blur-before-click
        pickJobAc(job);
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
    list.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
  }

  function highlightJobAc(idx) {
    const list = $("job-ac-list");
    if (!list) return;
    const items = list.querySelectorAll(".job-ac-item");
    items.forEach((el, i) => {
      el.setAttribute("aria-selected", i === idx ? "true" : "false");
    });
    jobAcHighlight = idx;
    if (idx >= 0 && items[idx]) {
      items[idx].scrollIntoView({ block: "nearest" });
    }
  }

  function pickJobAc(job) {
    if (!job || !job.jnid) return;
    state.selectedJobJnid = String(job.jnid);
    state.jobName = job.name || "";
    const input = $("job-name");
    if (input) input.value = state.jobName;
    setJobSelectedUI(true);
    hideJobAcList();
    setJobAcStatus("Selected");
    setTimeout(() => setJobAcStatus(""), 1200);
  }

  async function searchJobNimbusJobs(q) {
    const seq = ++jobSearchSeq;
    setJobAcStatus("Searching…");
    try {
      // Always hit JN live — no browser/SW/app job catalog. Bust caches + no-store.
      const url =
        "/api/jobnimbus/jobs?q=" +
        encodeURIComponent(q) +
        "&_=" +
        Date.now();
      const resp = await fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
      });
      let data = null;
      try {
        data = await resp.json();
      } catch (_) {
        data = null;
      }
      if (seq !== jobSearchSeq) return; // stale
      if (!data || !data.ok) {
        setJobAcStatus("");
        const msg = (data && data.message) || "Search failed";
        renderJobAcList([]);
        const list = $("job-ac-list");
        if (list) {
          list.innerHTML = "";
          const li = document.createElement("li");
          li.className = "job-ac-empty";
          li.textContent = msg;
          list.appendChild(li);
          list.classList.remove("hidden");
        }
        return;
      }
      setJobAcStatus(data.jobs && data.jobs.length ? data.jobs.length + " found" : "No matches");
      renderJobAcList(data.jobs || []);
      setTimeout(() => {
        if (seq === jobSearchSeq) setJobAcStatus("");
      }, 800);
    } catch (err) {
      if (seq !== jobSearchSeq) return;
      console.error(err);
      setJobAcStatus("");
      renderJobAcList([]);
      const list = $("job-ac-list");
      if (list) {
        list.innerHTML = "";
        const li = document.createElement("li");
        li.className = "job-ac-empty";
        li.textContent = "Network error searching jobs";
        list.appendChild(li);
        list.classList.remove("hidden");
      }
    }
  }

  function scheduleJobSearch(q, opts) {
    opts = opts || {};
    clearTimeout(jobSearchTimer);
    const trimmed = (q || "").trim();
    if (trimmed.length < 2) {
      hideJobAcList();
      setJobAcStatus("");
      return;
    }
    // Debounce typing (~300ms); focus / explicit refresh queries immediately.
    const delay = opts.immediate ? 0 : 300;
    jobSearchTimer = setTimeout(() => searchJobNimbusJobs(trimmed), delay);
  }

  function bindJobAutocomplete() {
    const input = $("job-name");
    if (!input) return;

    input.addEventListener("input", (e) => {
      const val = e.target.value;
      state.jobName = val;
      // Clear jnid if user edits after selection
      if (state.selectedJobJnid) {
        state.selectedJobJnid = null;
        clearJobSelectionHighlight();
      }
      scheduleJobSearch(val);
    });

    input.addEventListener("keydown", (e) => {
      const list = $("job-ac-list");
      const open = list && !list.classList.contains("hidden") && jobAcResults.length;
      if (e.key === "ArrowDown" && open) {
        e.preventDefault();
        const next = jobAcHighlight < jobAcResults.length - 1 ? jobAcHighlight + 1 : 0;
        highlightJobAc(next);
      } else if (e.key === "ArrowUp" && open) {
        e.preventDefault();
        const next = jobAcHighlight > 0 ? jobAcHighlight - 1 : jobAcResults.length - 1;
        highlightJobAc(next);
      } else if (e.key === "Enter" && open && jobAcHighlight >= 0) {
        e.preventDefault();
        pickJobAc(jobAcResults[jobAcHighlight]);
      } else if (e.key === "Escape") {
        hideJobAcList();
      }
    });

    input.addEventListener("blur", () => {
      // Delay so mousedown on item can fire first
      setTimeout(() => hideJobAcList(), 180);
    });

    input.addEventListener("focus", () => {
      // Always re-query live on focus so newly created POR-STR / POR-MIT jobs appear.
      const q = (input.value || "").trim();
      if (q.length >= 2) scheduleJobSearch(q, { immediate: true });
    });
  }

  window.PatchEstimator = {
    calculate,
    getTier,
    computeAddonSF,
    PRICING,
    ADDON_SF_EACH,
    TIER_KEYS,
    TIER_LABELS,
    round2,
    formatMoney,
    loadJsPdf,
    buildEstimatePdf,
    pdfFileName,
    createPdf,
    sendToJobNimbus,
    getState: () => state,
    setStateForTest(partial) {
      Object.assign(state, partial);
      if (partial.counts) state.counts = { ...state.counts, ...partial.counts };
      if (partial.over100Patches) state.over100Patches = partial.over100Patches;
      if (partial.customPatches) state.customPatches = partial.customPatches;
      syncOver100ListToCount();
    },
  };

  function init() {
    syncCountInputs();
    updateSheetUI();
    bind();
    render();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
