(function () {
  var P = window.PatchPricing;
  var STORAGE = "patch-estimator-draft-v1";
  var DEBOUNCE_MS = 300;

  var jobInput = document.getElementById("job-search");
  var jobMenu = document.getElementById("job-menu");
  var jobClear = document.getElementById("job-clear");
  var jobSelected = document.getElementById("job-selected");
  var patchList = document.getElementById("patch-list");
  var skimInput = document.getElementById("skim-sf");
  var paintInput = document.getElementById("paint-sf");
  var notesInput = document.getElementById("notes");
  var totalsEl = document.getElementById("totals");
  var errorsEl = document.getElementById("form-errors");
  var statusEl = document.getElementById("status");
  var grandEl = document.getElementById("grand-total");
  var legendEl = document.getElementById("rate-legend");

  var state = loadDraft() || blankState();
  var searchTimer = null;
  var searchAbort = null;
  var searchSeq = 0;

  function blankPatch() {
    return { id: "p" + Math.random().toString(36).slice(2, 10), location: "", sf: "", customRate: "" };
  }

  function blankState() {
    return {
      sheet: "drywall",
      patches: [blankPatch()],
      skimSf: "",
      paintSf: "",
      notes: "",
      jobName: "",
      selected: null
    };
  }

  function loadDraft() {
    try {
      var raw = localStorage.getItem(STORAGE);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.patches)) return null;
      data.sheet = data.sheet === "allin" ? "allin" : "drywall";
      data.jobName = String(data.jobName || "");
      if (data.selected && data.selected.name !== data.jobName) data.selected = null;
      if (!data.patches.length) data.patches = [blankPatch()];
      data.patches = data.patches.map(function (patch) {
        var id = String((patch && patch.id) || "");
        if (!/^p[a-z0-9]+$/.test(id)) id = "p" + Math.random().toString(36).slice(2, 10);
        return {
          id: id,
          location: String((patch && patch.location) || ""),
          sf: String((patch && patch.sf) || ""),
          customRate: String((patch && patch.customRate) || "")
        };
      });
      return data;
    } catch (err) {
      return null;
    }
  }

  function saveDraft() {
    try {
      localStorage.setItem(STORAGE, JSON.stringify({
        sheet: state.sheet,
        patches: state.patches,
        skimSf: state.skimSf,
        paintSf: state.paintSf,
        notes: state.notes,
        jobName: state.jobName,
        selected: state.selected
      }));
    } catch (err) {
      /* Private mode can block storage. The estimate still works. */
    }
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function pdfSafe(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[^\x20-\x7E\n]/g, "?")
      .trim();
  }

  function setStatus(message, isError) {
    statusEl.textContent = message || "";
    statusEl.style.color = isError ? "var(--danger)" : "var(--good)";
  }

  function readPatchesFromDom() {
    return Array.prototype.map.call(patchList.querySelectorAll(".patch"), function (row) {
      var rate = row.querySelector(".patch-rate");
      return {
        id: row.dataset.id,
        location: row.querySelector(".patch-location").value,
        sf: row.querySelector(".patch-sf").value,
        customRate: rate ? rate.value : ""
      };
    });
  }

  function syncFromDom() {
    if (patchList.querySelector(".patch")) state.patches = readPatchesFromDom();
    state.skimSf = skimInput.value;
    state.paintSf = paintInput.value;
    state.notes = notesInput.value;
    state.jobName = jobInput.value.trim();
    if (state.selected && state.selected.name !== jobInput.value) state.selected = null;
  }

  function renderPatches() {
    patchList.innerHTML = state.patches.map(function (patch, index) {
      var sf = P.parseAmount(patch.sf);
      var custom = sf != null && !isNaN(sf) && sf > 100;
      var rateBlock = custom
        ? '<label>Custom $ / SF<input class="patch-rate" inputmode="decimal" autocomplete="off" value="' + escapeHtml(patch.customRate) + '"></label>'
        : "";
      return (
        '<article class="patch" data-id="' + escapeHtml(patch.id) + '" data-custom="' + (custom ? "1" : "0") + '">' +
          '<div class="patch-top"><strong>Patch ' + (index + 1) + '</strong>' +
          '<button type="button" class="text-button patch-remove">Remove</button></div>' +
          '<label>Location<input class="patch-location" autocomplete="off" value="' + escapeHtml(patch.location) + '" placeholder="Room or wall"></label>' +
          '<div class="patch-grid">' +
            '<label>Square feet<input class="patch-sf" inputmode="decimal" autocomplete="off" value="' + escapeHtml(patch.sf) + '" placeholder="0"></label>' +
            rateBlock +
          "</div>" +
          '<div class="line-price"></div>' +
        "</article>"
      );
    }).join("");
  }

  function paintSelected() {
    var job = state.selected;
    jobClear.hidden = !jobInput.value;
    if (!job || job.name !== jobInput.value) {
      jobSelected.hidden = true;
      jobSelected.textContent = "";
      return;
    }
    var bits = [job.workflowName, job.className, job.number ? "#" + job.number : "", job.address].filter(Boolean);
    jobSelected.hidden = false;
    jobSelected.textContent = bits.join(" · ");
  }

  function refreshPrices() {
    syncFromDom();
    var result = P.priceEstimate(state);
    legendEl.innerHTML = P.legend(state.sheet).map(function (row) {
      return "<li>" + escapeHtml(row.label) + "<strong>" + P.formatMoney(row.eachCents) + " each</strong></li>";
    }).join("");
    document.getElementById("sheet-drywall").setAttribute("aria-pressed", state.sheet === "drywall" ? "true" : "false");
    document.getElementById("sheet-allin").setAttribute("aria-pressed", state.sheet === "allin" ? "true" : "false");

    Array.prototype.forEach.call(patchList.querySelectorAll(".patch"), function (row, index) {
      var line = null;
      result.patchLines.forEach(function (candidate) {
        if (candidate.index === index) line = candidate;
      });
      var host = row.querySelector(".line-price");
      if (!line) {
        host.innerHTML = "";
        return;
      }
      if (line.locked) {
        host.innerHTML = '<p class="price-lock"><span class="badge lock">Inspect lock</span></p>' +
          '<p class="amount">' + (line.invalid ? "—" : P.formatMoney(line.cents)) + "</p>" +
          '<p class="muted">' + escapeHtml(line.bucketLabel + (line.detail ? " · " + line.detail : "")) + "</p>";
      } else {
        host.innerHTML = '<p class="price-custom"><span class="badge open">No inspect lock</span></p>' +
          '<p class="amount">' + (line.invalid || !line.cents ? "—" : P.formatMoney(line.cents)) + "</p>" +
          '<p class="muted">' + escapeHtml(line.detail || "Custom $ / SF") + "</p>";
      }
    });

    document.getElementById("skim-amount").textContent = result.skim.invalid ? "—" : P.formatMoney(result.skim.cents);
    document.getElementById("paint-amount").textContent = result.paint.invalid ? "—" : P.formatMoney(result.paint.cents);

    var rows = [
      ["Base · " + result.sheet.label, result.baseCents],
      ["Patches", result.patchesCents],
      ["Skim coat", result.skim.invalid ? 0 : result.skim.cents],
      ["Paint", result.paint.invalid ? 0 : result.paint.cents]
    ];
    totalsEl.innerHTML = rows.map(function (row) {
      return "<div><span>" + escapeHtml(row[0]) + "</span><strong>" + P.formatMoney(row[1]) + "</strong></div>";
    }).join("") + '<div class="total"><span>Total</span><strong>' +
      (result.ok ? P.formatMoney(result.totalCents) : "—") + "</strong></div>";

    errorsEl.textContent = result.errors.join(" ");
    if (result.ok) {
      grandEl.textContent = P.formatMoney(result.totalCents);
      grandEl.dataset.cents = String(result.totalCents);
    } else {
      grandEl.textContent = "Check";
      grandEl.dataset.cents = "";
    }
    paintSelected();
    return result;
  }

  function showMenu(node) {
    jobMenu.innerHTML = "";
    jobMenu.appendChild(node);
    jobMenu.hidden = false;
    jobInput.setAttribute("aria-expanded", "true");
  }

  function showMenuMessage(message) {
    var note = document.createElement("p");
    note.className = "menu-note";
    note.textContent = message;
    showMenu(note);
  }

  function hideMenu() {
    jobMenu.hidden = true;
    jobInput.setAttribute("aria-expanded", "false");
  }

  function renderJobChoices(jobs) {
    jobMenu.innerHTML = "";
    if (!jobs.length) {
      showMenuMessage("No POR-STR or POR-MIT jobs match.");
      return;
    }
    jobs.forEach(function (job) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "job-option";
      button.setAttribute("role", "option");
      var meta = [job.workflowName, job.className, job.number ? "#" + job.number : "", job.address].filter(Boolean).join(" · ");
      button.innerHTML = "<strong></strong><span></span>";
      button.querySelector("strong").textContent = job.name;
      button.querySelector("span").textContent = meta;
      button.addEventListener("click", function () { chooseJob(job); });
      jobMenu.appendChild(button);
    });
    jobMenu.hidden = false;
    jobInput.setAttribute("aria-expanded", "true");
  }

  function chooseJob(job) {
    state.selected = {
      jnid: job.jnid,
      name: job.name,
      number: job.number || "",
      className: job.className || "",
      workflowName: job.workflowName || "",
      statusName: job.statusName || "",
      address: job.address || ""
    };
    jobInput.value = job.name;
    state.jobName = job.name;
    hideMenu();
    paintSelected();
    saveDraft();
    setStatus("");
  }

  function runSearch() {
    var query = jobInput.value.trim();
    if (query.length < 2) {
      showMenuMessage("Type at least 2 characters.");
      return;
    }
    if (searchAbort) searchAbort.abort();
    searchAbort = typeof AbortController === "function" ? new AbortController() : null;
    var seq = ++searchSeq;
    showMenuMessage("Searching JobNimbus…");
    var options = { cache: "no-store" };
    if (searchAbort) options.signal = searchAbort.signal;
    fetch("/api/jobnimbus/jobs?q=" + encodeURIComponent(query), options).then(function (response) {
      return response.json().then(function (body) {
        return { ok: response.ok, body: body };
      });
    }).then(function (result) {
      if (seq !== searchSeq) return;
      if (!result.body || result.body.ok === false) {
        showMenuMessage((result.body && result.body.error) || "Job search failed.");
        return;
      }
      renderJobChoices(result.body.jobs || []);
    }).catch(function (err) {
      if (err && err.name === "AbortError") return;
      if (seq !== searchSeq) return;
      showMenuMessage("Job search needs a connection. Pricing on this phone still works.");
    });
  }

  function setActiveOption(options, index) {
    Array.prototype.forEach.call(options, function (option, optionIndex) {
      option.classList.toggle("active", optionIndex === index);
    });
    if (options[index]) options[index].scrollIntoView({ block: "nearest" });
  }

  function requireReady() {
    syncFromDom();
    var result = refreshPrices();
    saveDraft();
    if (!result.ok) {
      setStatus(result.errors[0], true);
      return null;
    }
    if (!state.jobName) {
      setStatus("Enter the job name. It is printed on the PDF and used in the file name.", true);
      jobInput.focus();
      return null;
    }
    return result;
  }

  function buildPdfDocument(result) {
    var JsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!JsPDF) throw new Error("PDF library failed to load.");
    var doc = new JsPDF({ unit: "pt", format: "letter" });
    var jobName = pdfSafe(state.jobName) || "Job";
    var filename = P.estimateFilename(state.jobName);
    var pageWidth = doc.internal.pageSize.getWidth();
    var pageHeight = doc.internal.pageSize.getHeight();
    var y = 0;

    function footer() {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(90, 102, 120);
      doc.text("24 Hour Flood Pros  ·  Patch Estimator  ·  One sheet, priced per patch", 40, pageHeight - 28);
    }

    function newPage() {
      footer();
      doc.addPage();
      y = 48;
    }

    function ensure(height) {
      if (y + height > pageHeight - 48) newPage();
    }

    doc.setFillColor(18, 48, 85);
    doc.rect(0, 0, pageWidth, 78, "F");
    doc.setTextColor(247, 244, 236);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.text("24 HOUR FLOOD PROS", 40, 30);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(22);
    doc.text("Patch Estimate", 40, 56);

    y = 104;
    doc.setTextColor(90, 102, 120);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text("JOB", 40, y);
    y += 20;
    doc.setTextColor(18, 48, 85);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    var nameLines = doc.splitTextToSize(jobName, pageWidth - 80);
    doc.text(nameLines, 40, y);
    y += nameLines.length * 20 + 6;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(23, 32, 51);
    var meta = [];
    if (state.selected) {
      if (state.selected.number) meta.push("#" + pdfSafe(state.selected.number));
      if (state.selected.workflowName) meta.push(pdfSafe(state.selected.workflowName));
      if (state.selected.className) meta.push(pdfSafe(state.selected.className));
      if (state.selected.address) meta.push(pdfSafe(state.selected.address));
    }
    if (meta.length) {
      var metaLines = doc.splitTextToSize(meta.join("  ·  "), pageWidth - 80);
      doc.text(metaLines, 40, y);
      y += metaLines.length * 14 + 6;
    }
    var when = new Date().toLocaleString();
    doc.text(pdfSafe(when), 40, y);
    y += 18;
    doc.setFont("helvetica", "bold");
    doc.text(pdfSafe(result.sheet.label), 40, y);
    y += 16;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(90, 102, 120);
    var rule = doc.splitTextToSize("One sheet only. Drywall and all-inclusive prices are not blended. Patches 100 SF and under are inspect-locked. Over 100 SF uses the custom $ per SF on this estimate.", pageWidth - 80);
    doc.text(rule, 40, y);
    y += rule.length * 13 + 16;

    function section(title) {
      ensure(28);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.setTextColor(18, 48, 85);
      doc.text(title, 40, y);
      y += 8;
      doc.setDrawColor(213, 222, 234);
      doc.line(40, y, pageWidth - 40, y);
      y += 16;
    }

    section("Patches");
    if (!result.patchLines.length) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.setTextColor(23, 32, 51);
      doc.text("No patches. Base charge only.", 40, y);
      y += 18;
    }
    result.patchLines.forEach(function (line) {
      ensure(42);
      var title = "Patch " + (line.index + 1);
      if (line.location) title += "  ·  " + pdfSafe(line.location);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(23, 32, 51);
      var titleLines = doc.splitTextToSize(title, 360);
      doc.text(titleLines, 40, y);
      doc.setFont("helvetica", "bold");
      doc.text(P.formatMoney(line.cents), pageWidth - 40, y, { align: "right" });
      y += titleLines.length * 14;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(90, 102, 120);
      var detail = (line.sf != null ? line.sf + " SF · " : "") + (line.bucketLabel || "") + (line.detail ? " · " + line.detail : "");
      if (!line.locked) detail += " · no inspect lock";
      else detail += " · inspect lock";
      doc.text(pdfSafe(detail), 40, y);
      y += 18;
    });

    section("Add-ons and total");
    function moneyLine(label, cents, strong) {
      ensure(20);
      doc.setFont("helvetica", strong ? "bold" : "normal");
      doc.setFontSize(strong ? 13 : 11);
      doc.setTextColor(23, 32, 51);
      doc.text(label, 40, y);
      doc.text(P.formatMoney(cents), pageWidth - 40, y, { align: "right" });
      y += strong ? 22 : 18;
    }
    moneyLine("Base", result.baseCents, false);
    moneyLine("Patches", result.patchesCents, false);
    if (result.skim.sf) moneyLine("Skim coat " + result.skim.sf + " SF @ $7.80", result.skim.cents, false);
    if (result.paint.sf) moneyLine("Paint " + result.paint.sf + " SF @ $3.16", result.paint.cents, false);
    y += 4;
    moneyLine("Total", result.totalCents, true);

    var notes = pdfSafe(state.notes);
    if (notes) {
      y += 8;
      section("Notes");
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.setTextColor(23, 32, 51);
      var noteLines = doc.splitTextToSize(notes, pageWidth - 80);
      noteLines.forEach(function (line) {
        ensure(16);
        doc.text(line, 40, y);
        y += 14;
      });
    }

    footer();
    doc.setProperties({
      title: jobName + " Patch Estimate",
      subject: "24 Hour Flood Pros patch estimate",
      creator: "Patch Estimator"
    });
    doc.__filename = filename;
    return doc;
  }

  function confirmSend(filename, jobName) {
    var dialog = document.getElementById("confirm-dialog");
    document.getElementById("confirm-text").textContent =
      'Attach "' + filename + '" to JobNimbus job "' + jobName + '"? This does not create a job.';
    if (typeof dialog.showModal === "function") {
      return new Promise(function (resolve) {
        function onClose() {
          dialog.removeEventListener("close", onClose);
          resolve(dialog.returnValue === "send");
        }
        dialog.addEventListener("close", onClose);
        dialog.showModal();
      });
    }
    return Promise.resolve(window.confirm('Attach "' + filename + '" to "' + jobName + '"?'));
  }

  jobInput.addEventListener("input", function () {
    if (state.selected && state.selected.name !== jobInput.value) state.selected = null;
    state.jobName = jobInput.value;
    paintSelected();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, DEBOUNCE_MS);
    saveDraft();
  });

  jobInput.addEventListener("focus", function () {
    clearTimeout(searchTimer);
    runSearch();
  });

  jobInput.addEventListener("keydown", function (event) {
    var options = jobMenu.querySelectorAll(".job-option");
    if (event.key === "Escape") {
      hideMenu();
      return;
    }
    if (jobMenu.hidden || !options.length) return;
    var current = jobMenu.querySelector(".job-option.active");
    var index = current ? Array.prototype.indexOf.call(options, current) : -1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveOption(options, Math.min(options.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveOption(options, Math.max(0, index - 1));
    } else if (event.key === "Enter" && index >= 0) {
      event.preventDefault();
      options[index].click();
    }
  });

  jobClear.addEventListener("click", function () {
    jobInput.value = "";
    state.jobName = "";
    state.selected = null;
    hideMenu();
    paintSelected();
    saveDraft();
    jobInput.focus();
  });

  document.addEventListener("click", function (event) {
    if (!event.target.closest("#job-card")) hideMenu();
  });

  document.getElementById("sheet-drywall").addEventListener("click", function () {
    state.sheet = "drywall";
    refreshPrices();
    saveDraft();
  });
  document.getElementById("sheet-allin").addEventListener("click", function () {
    state.sheet = "allin";
    refreshPrices();
    saveDraft();
  });

  document.getElementById("add-patch").addEventListener("click", function () {
    syncFromDom();
    var patch = blankPatch();
    state.patches.push(patch);
    renderPatches();
    refreshPrices();
    saveDraft();
    var field = patchList.querySelector('.patch[data-id="' + patch.id + '"] .patch-sf');
    if (field) field.focus();
  });

  patchList.addEventListener("input", function (event) {
    var row = event.target.closest(".patch");
    if (!row) return;
    var wasCustom = row.dataset.custom === "1";
    var sf = P.parseAmount(row.querySelector(".patch-sf").value);
    var isCustom = sf != null && !isNaN(sf) && sf > 100;
    syncFromDom();
    if (wasCustom !== isCustom) {
      var focusId = row.dataset.id;
      var focusClass = event.target.classList.contains("patch-location") ? "patch-location" : (isCustom && event.target.classList.contains("patch-sf") ? "patch-rate" : event.target.className.split(" ")[0]);
      renderPatches();
      var next = patchList.querySelector('.patch[data-id="' + focusId + '"]');
      var field = next && (next.querySelector("." + focusClass) || next.querySelector(".patch-sf"));
      if (field) {
        field.focus();
        if (field.setSelectionRange && field.value) field.setSelectionRange(field.value.length, field.value.length);
      }
    }
    refreshPrices();
    saveDraft();
  });

  patchList.addEventListener("click", function (event) {
    var button = event.target.closest(".patch-remove");
    if (!button) return;
    syncFromDom();
    var id = button.closest(".patch").dataset.id;
    state.patches = state.patches.filter(function (patch) { return patch.id !== id; });
    if (!state.patches.length) state.patches.push(blankPatch());
    renderPatches();
    refreshPrices();
    saveDraft();
  });

  [skimInput, paintInput, notesInput].forEach(function (input) {
    input.addEventListener("input", function () {
      refreshPrices();
      saveDraft();
    });
  });

  document.getElementById("download-pdf").addEventListener("click", function () {
    var result = requireReady();
    if (!result) return;
    try {
      var doc = buildPdfDocument(result);
      doc.save(doc.__filename);
      setStatus("Downloaded " + doc.__filename + ".");
    } catch (err) {
      setStatus("Could not build the PDF on this phone.", true);
    }
  });

  document.getElementById("send-jobnimbus").addEventListener("click", function () {
    var result = requireReady();
    if (!result) return;
    var doc;
    try {
      doc = buildPdfDocument(result);
    } catch (err) {
      setStatus("Could not build the PDF on this phone.", true);
      return;
    }
    var filename = doc.__filename;
    var dataUri = doc.output("datauristring");
    var pdfBase64 = dataUri.split(",")[1];
    var sendButton = document.getElementById("send-jobnimbus");
    confirmSend(filename, state.jobName).then(function (accepted) {
      if (!accepted) {
        setStatus("Send cancelled.");
        return null;
      }
      sendButton.disabled = true;
      setStatus("Sending to JobNimbus…");
      return fetch("/api/jobnimbus/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          jobName: state.jobName,
          filename: filename,
          pdfBase64: pdfBase64,
          jobJnid: state.selected && state.selected.jnid ? state.selected.jnid : undefined
        })
      });
    }).then(function (response) {
      if (!response) return null;
      return response.json().then(function (body) {
        return { ok: response.ok, body: body };
      });
    }).then(function (result) {
      sendButton.disabled = false;
      if (!result) return;
      if (!result.body || result.body.ok === false) {
        setStatus((result.body && result.body.error) || "JobNimbus did not accept the PDF.", true);
        return;
      }
      setStatus(result.body.message || "Sent to JobNimbus.");
    }).catch(function () {
      sendButton.disabled = false;
      setStatus("Could not reach the server. The PDF was not sent.", true);
    });
  });

  jobInput.value = state.jobName || "";
  skimInput.value = state.skimSf || "";
  paintInput.value = state.paintSf || "";
  notesInput.value = state.notes || "";
  renderPatches();
  refreshPrices();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(function () {});
  }

  window.PatchApp = {
    buildPdfDocument: function () {
      syncFromDom();
      return buildPdfDocument(P.priceEstimate(state));
    },
    refreshPrices: refreshPrices
  };
})();
