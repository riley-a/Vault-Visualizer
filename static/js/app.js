/* Verkada Co-Term Visualizer — frontend logic.
 *
 * No build step, no framework. Two pieces of state:
 *   - state.columns: the "Device breakdown" lines (same shape/picker pattern
 *     as the sibling planner app's Before grid).
 *   - state.newLicense: a SINGLE new-license entry (not a list) — product
 *     line + term + kind (capacity/renewal) + devices claimed. Picking a
 *     product for it that isn't already a breakdown column adds it there
 *     too, starting at 0 claimed/0 active, exactly like the planner's
 *     "new product lines are independent" behavior.
 *
 * "Visualize" fires two /api/coterm/compute requests (new license zeroed,
 * then applied) and renders a horizontal stacked-bar Gantt-style chart:
 * one row per product line, x-axis = days since the as-of date.
 */
(function () {
  "use strict";

  const state = {
    catalog: { families: [], units: [] },
    columns: [], // { id, key, label, family, unit_basis, devices_per_license, term_options_days, skus, claimed_before, active_before, custom }
    newLicense: null, // { columnId, term_days, kind, devices_claimed }
    nextId: 1,
    chart: null,
  };

  const FAMILY_COLORS = {
    "Cameras": "#4f8cff",
    "Access Control": "#34c77b",
    "Alarms": "#ef5a5a",
    "Environmental Sensors": "#f5a623",
    "Gateway": "#a56eff",
    "Intercom": "#22c1d6",
    "Workplace": "#e0c341",
    "Custom": "#8b93a1",
  };

  function familyColor(family) {
    return FAMILY_COLORS[family] || "#8b93a1";
  }

  function el(tag, opts) {
    opts = opts || {};
    const node = document.createElement(tag);
    if (opts.className) node.className = opts.className;
    if (opts.text !== undefined) node.textContent = opts.text;
    if (opts.html !== undefined) node.innerHTML = opts.html;
    if (opts.attrs) {
      for (const k in opts.attrs) node.setAttribute(k, opts.attrs[k]);
    }
    return node;
  }

  function todayIso() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function slugify(label) {
    return (label || "custom")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "custom";
  }

  function showError(msg) {
    const banner = document.getElementById("error-banner");
    banner.textContent = msg;
    banner.style.display = msg ? "block" : "none";
  }

  // ---------------------------------------------------------------------
  // Catalog fetch + picker
  // ---------------------------------------------------------------------

  async function loadCatalog() {
    try {
      const resp = await fetch("/api/catalog");
      if (!resp.ok) throw new Error(`catalog fetch failed (${resp.status})`);
      state.catalog = await resp.json();
    } catch (err) {
      showError("Could not load license catalog: " + err.message);
      state.catalog = { families: [], units: [] };
    }
  }

  // Two independent pickers share this registry: the Device Breakdown's
  // "+ Add license" and the New License section's "+ Choose product".
  const PICKERS = {}; // menuId -> { btnId, onPick }

  function registerPicker(btnId, menuId, onPick) {
    PICKERS[menuId] = { btnId, onPick };
    document.getElementById(btnId).addEventListener("click", (e) => {
      e.stopPropagation();
      togglePicker(menuId);
    });
  }

  function togglePicker(menuId) {
    const menu = document.getElementById(menuId);
    if (menu.style.display === "block") {
      closePicker(menuId);
    } else {
      closeAllPickers();
      openPicker(menuId);
    }
  }

  function openPicker(menuId) {
    const menu = document.getElementById(menuId);
    const onPick = PICKERS[menuId].onPick;
    menu.innerHTML = "";

    const byFamily = {};
    for (const u of state.catalog.units || []) {
      (byFamily[u.family] = byFamily[u.family] || []).push(u);
    }
    const familyOrder = (state.catalog.families || []).filter((f) => byFamily[f]);

    for (const fam of familyOrder) {
      menu.appendChild(el("div", { className: "picker-family", text: fam }));
      for (const u of byFamily[fam]) {
        const item = el("div", { className: "picker-item" });
        item.appendChild(el("div", { className: "pi-label", text: u.label }));
        if (u.unit_basis) {
          item.appendChild(el("div", { className: "pi-basis", text: u.unit_basis }));
        }
        item.addEventListener("click", () => {
          onPick(u);
          closePicker(menuId);
        });
        menu.appendChild(item);
      }
    }

    menu.appendChild(el("hr"));
    const customItem = el("div", {
      className: "picker-item picker-custom",
      text: "+ Add custom license…",
    });
    customItem.addEventListener("click", () => {
      onPick(null);
      closePicker(menuId);
    });
    menu.appendChild(customItem);

    menu.style.display = "block";
  }

  function closePicker(menuId) {
    document.getElementById(menuId).style.display = "none";
  }

  function closeAllPickers() {
    Object.keys(PICKERS).forEach(closePicker);
  }

  document.addEventListener("click", (e) => {
    for (const [menuId, { btnId }] of Object.entries(PICKERS)) {
      const menu = document.getElementById(menuId);
      const btn = document.getElementById(btnId);
      if (!menu.contains(e.target) && e.target !== btn) {
        closePicker(menuId);
      }
    }
  });

  // ---------------------------------------------------------------------
  // Device breakdown ("existing") column state
  // ---------------------------------------------------------------------

  function addColumnFromCatalog(catalogUnit) {
    // De-dupe: the new-license picker and the breakdown picker share the
    // same catalog, so picking the same product in both should reuse one
    // column rather than double-counting it.
    const existing = state.columns.find((c) => c.key === catalogUnit.key);
    if (existing) return existing;

    const col = {
      id: state.nextId++,
      key: catalogUnit.key,
      label: catalogUnit.label,
      family: catalogUnit.family,
      unit_basis: catalogUnit.unit_basis || "",
      devices_per_license: catalogUnit.devices_per_license || 1,
      term_options_days: catalogUnit.term_options_days || [365, 1095, 1825, 3650],
      skus: catalogUnit.skus || [],
      claimed_before: 0,
      active_before: 0,
      custom: false,
    };
    state.columns.push(col);
    renderColumns();
    return col;
  }

  function addCustomColumn() {
    const label = window.prompt("Custom license name:", "");
    if (label === null) return null; // cancelled
    const trimmed = label.trim() || "Custom License";
    const family = window.prompt("Family (group heading):", "Custom") || "Custom";
    const col = {
      id: state.nextId++,
      key: slugify(trimmed) + "_" + state.nextId,
      label: trimmed,
      family: family.trim() || "Custom",
      unit_basis: "",
      devices_per_license: 1,
      term_options_days: [365, 1095, 1825, 3650],
      skus: [],
      claimed_before: 0,
      active_before: 0,
      custom: true,
    };
    state.columns.push(col);
    renderColumns();
    return col;
  }

  function removeColumn(id) {
    state.columns = state.columns.filter((c) => c.id !== id);
    if (state.newLicense && state.newLicense.columnId === id) {
      state.newLicense = null;
      renderNewLicenseForm();
    }
    renderColumns();
  }

  function findColumn(id) {
    return state.columns.find((c) => c.id === id);
  }

  // ---------------------------------------------------------------------
  // Rendering: device breakdown
  // ---------------------------------------------------------------------

  function renderColumns() {
    const grid = document.getElementById("columns-grid");
    const emptyState = document.getElementById("empty-state");
    grid.innerHTML = "";

    if (state.columns.length === 0) {
      emptyState.style.display = "block";
      return;
    }
    emptyState.style.display = "none";

    for (const col of state.columns) {
      grid.appendChild(buildColumnCard(col));
    }
  }

  function termLabel(days) {
    const years = Math.round(days / 365);
    return `${years}-Year (${days}d)`;
  }

  function priceHintFor(col, termDays) {
    const sku = (col.skus || []).find((s) => s.term_days === termDays);
    if (!sku) return "";
    return ` — $${sku.us_price.toLocaleString()}`;
  }

  // Unit price alone vs. unit price + total cost once a devices-claimed
  // count is known, so the license quantity -- and therefore a real total
  // -- can be shown. Quantity mirrors the same ceil(devices / dpl) math
  // used when building the actual purchase batch sent to the API.
  function priceBreakdownFor(col, termDays, devicesClaimed) {
    const sku = (col && col.skus || []).find((s) => s.term_days === termDays);
    if (!sku) return "";
    const dpl = (col && col.devices_per_license) || 1;
    const qty = Math.max(1, Math.ceil((devicesClaimed || 0) / dpl));
    const unit = sku.us_price;
    if (qty <= 1) return `$${unit.toLocaleString()}`;
    return `$${unit.toLocaleString()} ea × ${qty} = $${(unit * qty).toLocaleString()} total`;
  }

  // Some SKUs (e.g. cloud backup retention increments) need a
  // product-specific term label instead of the generic "N-Year (Xd)" text.
  function termDisplayLabel(col, termDays) {
    const sku = (col && col.skus || []).find((s) => s.term_days === termDays);
    if (sku && sku.term_label) return sku.term_label;
    return termLabel(termDays);
  }

  function buildColumnCard(col) {
    const card = el("div", { className: "col-card" });

    const head = el("div", { className: "col-head" });
    const titleBlock = el("div");
    titleBlock.appendChild(el("div", { className: "col-title", text: col.label }));
    const tag = el("span", {
      className: "family-tag",
      text: col.family,
      attrs: { style: `background:${familyColor(col.family)};` },
    });
    titleBlock.appendChild(tag);
    head.appendChild(titleBlock);

    const removeBtn = el("button", { className: "danger", text: "×", attrs: { type: "button", title: "Remove" } });
    removeBtn.addEventListener("click", () => removeColumn(col.id));
    head.appendChild(removeBtn);
    card.appendChild(head);

    if (col.unit_basis) {
      card.appendChild(el("div", { className: "hint", text: col.unit_basis }));
    }

    if (col.custom) {
      card.appendChild(labeledInput("Devices per license", "number", col.devices_per_license, (v) => {
        const n = parseFloat(v);
        col.devices_per_license = isFinite(n) && n > 0 ? n : 1;
      }));
    }

    const row1 = el("div", { className: "row-2" });
    row1.appendChild(labeledInput("Claimed", "number", col.claimed_before, (v) => {
      col.claimed_before = parseNonNegInt(v);
    }));
    row1.appendChild(labeledInput("Active", "number", col.active_before, (v) => {
      col.active_before = parseNonNegInt(v);
    }));
    card.appendChild(row1);

    return card;
  }

  function labeledInput(labelText, type, value, onChange) {
    const field = el("div", { className: "field" });
    field.appendChild(el("label", { text: labelText }));
    const input = el("input", { attrs: { type } });
    if (type === "number") {
      input.min = "0";
    }
    input.value = value === undefined || value === null ? "" : value;
    input.addEventListener("input", () => onChange(input.value));
    field.appendChild(input);
    return field;
  }

  function parseNonNegInt(v) {
    const n = parseInt(v, 10);
    return isFinite(n) && n >= 0 ? n : 0;
  }

  // ---------------------------------------------------------------------
  // New license (single entry, not a list)
  // ---------------------------------------------------------------------

  function renderNewLicenseForm() {
    const wrap = document.getElementById("new-license-form-wrap");
    wrap.innerHTML = "";

    if (!state.newLicense) {
      wrap.appendChild(el("div", {
        className: "hint",
        text: "No product selected yet — click \"+ Choose product\" above.",
      }));
      return;
    }

    const col = findColumn(state.newLicense.columnId);
    if (!col) {
      // Stale reference (its column was removed from the breakdown).
      state.newLicense = null;
      wrap.appendChild(el("div", {
        className: "hint",
        text: "No product selected yet — click \"+ Choose product\" above.",
      }));
      return;
    }

    const card = el("div", { className: "new-license-card" });

    const head = el("div", { className: "col-head" });
    const titleBlock = el("div");
    titleBlock.appendChild(el("div", { className: "col-title", text: col.label }));
    const tag = el("span", {
      className: "family-tag",
      text: col.family,
      attrs: { style: `background:${familyColor(col.family)};` },
    });
    titleBlock.appendChild(tag);
    head.appendChild(titleBlock);

    const removeBtn = el("button", { className: "danger", text: "×", attrs: { type: "button", title: "Clear selection" } });
    removeBtn.addEventListener("click", () => {
      state.newLicense = null;
      renderNewLicenseForm();
    });
    head.appendChild(removeBtn);
    card.appendChild(head);

    const row = el("div", { className: "row-3" });

    // Term select
    const termField = el("div", { className: "field" });
    termField.appendChild(el("label", { text: "Term" }));
    const termSelect = el("select");
    const termOptions = (col.term_options_days && col.term_options_days.length)
      ? col.term_options_days
      : [365, 1095, 1825, 3650];
    for (const days of termOptions) {
      const opt = el("option", { text: termDisplayLabel(col, days) + priceHintFor(col, days) });
      opt.value = String(days);
      termSelect.appendChild(opt);
    }
    if (!state.newLicense.term_days) state.newLicense.term_days = termOptions[0];
    termSelect.value = String(state.newLicense.term_days);
    termSelect.addEventListener("change", () => {
      state.newLicense.term_days = parseInt(termSelect.value, 10);
      renderNewLicenseForm();
    });
    termField.appendChild(termSelect);
    row.appendChild(termField);

    // Kind select
    const kindField = el("div", { className: "field" });
    kindField.appendChild(el("label", { text: "Kind" }));
    const kindSelect = el("select");
    kindSelect.appendChild(el("option", { text: "Capacity increase", attrs: { value: "capacity" } }));
    kindSelect.appendChild(el("option", { text: "Renewal", attrs: { value: "renewal" } }));
    kindSelect.value = state.newLicense.kind || "capacity";
    kindSelect.addEventListener("change", () => {
      state.newLicense.kind = kindSelect.value === "renewal" ? "renewal" : "capacity";
      if (state.newLicense.kind === "renewal" && !state.newLicense.devices_claimed) {
        state.newLicense.devices_claimed = col.claimed_before || 0;
      }
      renderNewLicenseForm();
    });
    kindField.appendChild(kindSelect);
    row.appendChild(kindField);

    // Devices claimed/covered
    const devField = el("div", { className: "field" });
    devField.appendChild(el("label", { text: state.newLicense.kind === "renewal" ? "Devices covered" : "Devices claimed" }));
    const devInput = el("input", { attrs: { type: "number", min: "0" } });
    devInput.value = state.newLicense.devices_claimed || "";
    devInput.addEventListener("input", () => {
      state.newLicense.devices_claimed = parseNonNegInt(devInput.value);
    });
    devField.appendChild(devInput);
    row.appendChild(devField);

    card.appendChild(row);

    const priceBreakdown = priceBreakdownFor(col, state.newLicense.term_days, state.newLicense.devices_claimed);
    if (priceBreakdown) {
      card.appendChild(el("div", { className: "hint", text: priceBreakdown }));
    }

    wrap.appendChild(card);
  }

  // ---------------------------------------------------------------------
  // Compute + results rendering
  // ---------------------------------------------------------------------

  // Builds the /api/coterm/compute payload. beforeOnly=true zeroes the new
  // license's devices/batches for every column (the pure "existing"
  // baseline); beforeOnly=false applies it to its one target column. Same
  // aggregation rule as the planner: license batch quantity is always
  // ceil(devicesClaimed / devicesPerLicense), and that quantity always goes
  // into new_batches (license-days) -- but new_claimed_devices (which
  // drives required_units_after, i.e. device/unit count) is only
  // incremented for "capacity", NEVER for "renewal".
  function buildPayload(beforeOnly) {
    const orgName = document.getElementById("org-name").value.trim() || "Untitled Org";
    const asOfDate = document.getElementById("as-of-date").value || todayIso();
    const currentExpiration = document.getElementById("current-expiration-date").value || null;

    const byColumn = {};
    if (!beforeOnly && state.newLicense && state.newLicense.columnId &&
        state.newLicense.term_days && state.newLicense.devices_claimed > 0) {
      const nl = state.newLicense;
      const col = findColumn(nl.columnId);
      if (col) {
        const dpl = col.devices_per_license || 1;
        const qty = Math.max(1, Math.ceil(nl.devices_claimed / dpl));
        byColumn[nl.columnId] = {
          devices: nl.kind === "renewal" ? 0 : nl.devices_claimed,
          batches: [{ term_days: nl.term_days, quantity: qty }],
        };
      }
    }

    const units = state.columns.map((col) => {
      const bucket = byColumn[col.id] || { devices: 0, batches: [] };
      return {
        key: col.key,
        label: col.label,
        family: col.family,
        devices_per_license: col.devices_per_license,
        claimed_before: col.claimed_before,
        active_before: col.active_before,
        expiration_before: currentExpiration,
        new_claimed_devices: bucket.devices,
        new_batches: bucket.batches,
      };
    });

    return { org_name: orgName, as_of_date: asOfDate, units };
  }

  async function postCompute(payload) {
    const resp = await fetch("/api/coterm/compute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data && data.error ? data.error : `Compute failed (${resp.status})`);
    }
    return data;
  }

  async function compute() {
    showError("");

    if (state.columns.length === 0) {
      showError("Add at least one license line (or choose a new-license product) before visualizing.");
      return;
    }

    let beforeData, afterData;
    try {
      [beforeData, afterData] = await Promise.all([
        postCompute(buildPayload(true)),
        postCompute(buildPayload(false)),
      ]);
    } catch (err) {
      showError(err.message);
      return;
    }

    renderResults(beforeData, afterData);
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    return iso;
  }

  function fmtNum(n, digits) {
    if (n === null || n === undefined) return "—";
    return Number(n).toLocaleString(undefined, {
      minimumFractionDigits: digits || 0,
      maximumFractionDigits: digits || 0,
    });
  }

  // as-of date (ISO "YYYY-MM-DD") is day 0. Converts an (possibly
  // fractional) day offset into a real calendar Date. Uses Math.floor, NOT
  // Math.round: the Python engine computes expiration dates via
  // `date + timedelta(days=float)`, and timedelta normalizes a fractional
  // day count by keeping only the integer `.days` (truncating toward zero
  // for positive values) -- `date.__add__` then uses only that `.days`
  // component. Rounding here instead of flooring would make chart
  // tooltip/tick dates disagree by a day with the API's own
  // standalone_expiration_date / org_expiration_date strings whenever the
  // day count has a fractional part (e.g. 791.67 days -> the engine's
  // actual expiration date is 791 days out, not 792).
  function dayToDate(asOfIso, days) {
    const d = new Date(asOfIso + "T00:00:00");
    d.setDate(d.getDate() + Math.floor(days));
    return d;
  }

  function fmtDateObj(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // Combines the before/after responses into one row per product line:
  //   existingDays   = beforeRow.standalone_remaining_days (that line's own
  //                    trajectory with no new purchase involved anywhere).
  //   extensionDays  = afterRow.standalone_remaining_days - existingDays,
  //                    but ONLY for the single line the new license
  //                    targets -- every other line is unaffected by a
  //                    purchase on a different line, so it's exactly 0.
  // Not clamped to zero: a negative extensionDays (the line's own
  // trajectory got shorter) is shown as a reduction, not hidden.
  function buildCombinedRows(beforeData, afterData) {
    const beforeByKey = {};
    for (const r of beforeData.rows) beforeByKey[r.key] = r;

    const nl = state.newLicense;
    const targetActive = !!(nl && nl.term_days && nl.devices_claimed > 0);
    const targetCol = targetActive ? findColumn(nl.columnId) : null;
    const targetKey = targetCol ? targetCol.key : null;

    return afterData.rows.map((afterRow) => {
      const beforeRow = beforeByKey[afterRow.key] || afterRow;
      const existingDays = beforeRow.standalone_remaining_days || 0;
      const isTarget = targetActive && afterRow.key === targetKey;
      const extensionDays = isTarget
        ? (afterRow.standalone_remaining_days - beforeRow.standalone_remaining_days)
        : 0;
      const claimedAfter = (isTarget && nl.kind === "capacity")
        ? beforeRow.claimed_before + nl.devices_claimed
        : beforeRow.claimed_before;

      return {
        key: afterRow.key,
        label: afterRow.label,
        family: afterRow.family,
        claimedBefore: beforeRow.claimed_before,
        claimedAfter,
        standaloneDateBefore: beforeRow.standalone_expiration_date,
        standaloneDateAfter: afterRow.standalone_expiration_date,
        existingDays,
        extensionDays,
      };
    });
  }

  function renderResults(beforeData, afterData) {
    document.getElementById("results").style.display = "flex";

    const rows = buildCombinedRows(beforeData, afterData);
    renderCallout(beforeData, afterData);
    renderChart(rows, afterData.as_of_date, afterData.org_expiration_date, afterData.org_remaining_days);
    renderTable(rows);
  }

  function renderCallout(beforeData, afterData) {
    const callout = document.getElementById("callout");
    callout.innerHTML = "";

    const orgLabel = el("div", { className: "co-term-block" });
    orgLabel.appendChild(el("div", { className: "co-term-label", text: "Org" }));
    orgLabel.appendChild(el("div", { className: "co-term-date", text: afterData.org_name }));
    orgLabel.appendChild(el("div", { className: "co-term-delta", text: `As of ${fmtDate(afterData.as_of_date)}` }));
    callout.appendChild(orgLabel);

    const currentBlock = el("div", { className: "co-term-block" });
    currentBlock.appendChild(el("div", { className: "co-term-label", text: "Current org co-term" }));
    currentBlock.appendChild(el("div", { className: "co-term-date", text: fmtDate(beforeData.org_expiration_date) }));
    currentBlock.appendChild(el("div", { className: "co-term-delta", text: `Runway: ${fmtNum(beforeData.org_remaining_days, 1)} days` }));
    callout.appendChild(currentBlock);

    callout.appendChild(el("div", { className: "arrow", text: "→" }));

    const isLater = afterData.org_remaining_days >= beforeData.org_remaining_days;
    const newBlock = el("div", { className: "co-term-block" });
    newBlock.appendChild(el("div", { className: "co-term-label", text: "New org co-term" }));
    newBlock.appendChild(el("div", {
      className: "co-term-date " + (isLater ? "good" : "bad"),
      text: fmtDate(afterData.org_expiration_date),
    }));
    newBlock.appendChild(el("div", { className: "co-term-delta", text: `Runway: ${fmtNum(afterData.org_remaining_days, 1)} days` }));
    callout.appendChild(newBlock);
  }

  function renderChart(rows, asOfIso, orgExpAfterIso, orgRemainingAfterDays) {
    const ctx = document.getElementById("coterm-chart").getContext("2d");

    const labels = rows.map((r) => r.label);
    const existingData = rows.map((r) => r.existingDays);
    const extensionData = rows.map((r) => r.extensionDays);
    const extensionColors = rows.map((r) => (r.extensionDays < 0 ? "#ef5a5a" : "#34c77b"));

    if (state.chart) {
      state.chart.destroy();
    }

    state.chart = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Existing",
            data: existingData,
            backgroundColor: "#4f8cff",
            stack: "coterm",
            borderRadius: 3,
          },
          {
            label: "Extension",
            data: extensionData,
            backgroundColor: extensionColors,
            stack: "coterm",
            borderRadius: 3,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            stacked: true,
            grid: { color: "#262c35" },
            ticks: {
              color: "#8b93a1",
              callback: (value) => fmtDateObj(dayToDate(asOfIso, value)),
            },
            title: { display: true, text: "Calendar date", color: "#8b93a1" },
          },
          y: {
            stacked: true,
            grid: { display: false },
            ticks: { color: "#e6e9ef" },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const row = rows[ctx.dataIndex];
                if (ctx.dataset.label === "Existing") {
                  const d = dayToDate(asOfIso, row.existingDays);
                  return `Existing: ${fmtNum(row.existingDays, 0)}d → ${fmtDateObj(d)}`;
                }
                const kind = row.extensionDays < 0 ? "Reduction" : "Extension";
                const endDay = row.existingDays + row.extensionDays;
                const d = dayToDate(asOfIso, endDay);
                return `${kind}: ${fmtNum(Math.abs(row.extensionDays), 0)}d → ${fmtDateObj(d)}`;
              },
            },
          },
          annotation: {
            annotations: {
              orgLine: {
                type: "line",
                xMin: orgRemainingAfterDays,
                xMax: orgRemainingAfterDays,
                borderColor: "#e6e9ef",
                borderWidth: 2,
                borderDash: [6, 4],
                label: {
                  display: true,
                  content: `Org co-term: ${orgExpAfterIso}`,
                  position: "start",
                  color: "#e6e9ef",
                  backgroundColor: "rgba(23,27,33,0.9)",
                  font: { size: 11 },
                  padding: 4,
                },
              },
            },
          },
        },
      },
    });

    const wrap = document.querySelector("#results .chart-wrap");
    wrap.style.height = Math.max(260, rows.length * 48) + "px";
  }

  function renderTable(rows) {
    const tbody = document.querySelector("#results-table tbody");
    tbody.innerHTML = "";

    for (const row of rows) {
      const tr = el("tr");
      tr.appendChild(el("td", { text: row.label }));
      tr.appendChild(el("td", { text: fmtNum(row.claimedBefore) }));
      tr.appendChild(el("td", { text: fmtNum(row.claimedAfter) }));
      tr.appendChild(el("td", { text: fmtDate(row.standaloneDateBefore) }));
      tr.appendChild(el("td", { text: fmtDate(row.standaloneDateAfter) }));
      const deltaTd = el("td", { text: (row.extensionDays >= 0 ? "+" : "") + fmtNum(row.extensionDays, 1) });
      deltaTd.className = row.extensionDays < 0 ? "bad" : (row.extensionDays > 0 ? "good" : "");
      tr.appendChild(deltaTd);
      tbody.appendChild(tr);
    }
  }

  // Hides the last computed output without touching any input.
  function clearResults() {
    document.getElementById("results").style.display = "none";
    if (state.chart) {
      state.chart.destroy();
      state.chart = null;
    }
    showError("");
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  function init() {
    document.getElementById("as-of-date").value = todayIso();

    registerPicker("add-column-btn", "picker-menu", (u) => {
      if (u) addColumnFromCatalog(u); else addCustomColumn();
    });
    registerPicker("add-new-license-product-btn", "new-license-picker-menu", (u) => {
      const col = u ? addColumnFromCatalog(u) : addCustomColumn();
      if (col) {
        state.newLicense = { columnId: col.id, term_days: null, kind: "capacity", devices_claimed: 0 };
        renderNewLicenseForm();
      }
    });

    document.getElementById("compute-btn").addEventListener("click", compute);
    document.getElementById("clear-results-btn").addEventListener("click", clearResults);

    renderColumns();
    renderNewLicenseForm();
    loadCatalog();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
