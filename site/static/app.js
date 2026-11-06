"use strict";
const { esc, fmt, number, breaks, color, filterRows, joinRows } = Core;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const state = {
  page:
    location.pathname === "/mobility"
      ? "mobility"
      : location.pathname === "/explorer"
        ? "explorer"
        : "housing",
  geo: "County",
  scope: location.pathname === "/explorer" ? "state" : "region",
  keys: [],
  metric: "",
  y: "",
  selected: new Set(),
  search: "",
  min: "",
  max: "",
  ramp: "teal",
  binning: "quantile",
  basemap: "streets",
  sort: "Name",
  desc: false,
  pageIndex: 0,
  custom: null,
  features: [],
  data: [],
  fields: [],
  rows: [],
};
let catalog,
  edition,
  housing,
  map,
  thematic,
  baseLayer,
  customLayer,
  renderId = 0,
  noticeTimer;
function toast(s) {
  $("#notice").textContent = s;
  $("#notice").style.display = "block";
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => ($("#notice").style.display = "none"), 6000);
}
async function api(url, options = {}) {
  const r = await fetch(url, options);
  if (!r.ok) {
    let e;
    try {
      e = await r.json();
    } catch {
      e = { error: "Request failed (" + r.status + ")" };
    }
    throw Error(e.error);
  }
  return r.json();
}
function post(url, data, csrf) {
  return api(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    body: JSON.stringify(data),
  });
}
function download(content, name, mime = "application/json") {
  let b =
    content instanceof Blob
      ? content
      : new Blob(
          [
            typeof content === "string"
              ? content
              : JSON.stringify(content, null, 2),
          ],
          { type: mime },
        );
  let a = document.createElement("a");
  a.href = URL.createObjectURL(b);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function dialog(title, html) {
  $("#dialog-title").textContent = title;
  $("#dialog-body").innerHTML = html;
  $("#dialog").showModal();
}
function safeLink(u) {
  try {
    return new URL(u).protocol === "https:" ? u : "#";
  } catch {
    return "#";
  }
}
function currentField(key = state.metric) {
  return (
    state.fields.find((f) => f.id === key) || { alias: key, unit: "number" }
  );
}
function fieldLabel(key) {
  let f = currentField(key);
  return f.alias.replace(/^[#%]\s*/, "").replace(/, 2024(?: \(MOE\))?$/, "");
}
function opts(items, value) {
  return items
    .map(
      (x) =>
        `<option value="${esc(x.id)}" ${x.id === value ? "selected" : ""}>${esc(x.label || x.title || x.alias || x.id)}</option>`,
    )
    .join("");
}
function bind(selector, event, fn) {
  const e = $(selector);
  if (e) e.addEventListener(event, fn);
}
function appHtml() {
  let isExplore = state.page === "explorer",
    isHousing = state.page === "housing";
  let title =
    catalog.dashboards[state.page]?.title ||
    (isExplore
      ? "Georgia data explorer"
      : isHousing
        ? "Regional housing"
        : "Economic mobility");
  let intro = isExplore
    ? "Find indicators, compare places and take the data with you. Explore statewide or focus on the Atlanta region."
    : isHousing
      ? "Housing production, affordability and conditions across the 11-county Atlanta region."
      : "Explore income, education, employment and access across the Atlanta region. Demonstration measures use published ACS data; ARC will define its final mobility measures.";
  $("#main").innerHTML =
    `<div class="page-top"><div><div class="eyebrow">${isExplore ? "Statewide data" : isHousing ? "Housing Forward 2035" : "Regional conditions"}</div><h1>${title}</h1><p>${intro}</p></div><div class="actions"><button id="save-session">Save session</button><button id="load-session">Open session</button><button class="primary" id="export">Download</button><input type="file" id="session-file" accept=".json" hidden></div></div><div id="stats" class="stats"></div><div class="workspace"><aside class="panel controls" aria-label="Data and map controls"><h2>Explore the data</h2><div class="control-grid"><label>Geography<select id="geography">${opts(catalog.geographies, state.geo)}</select></label><label>Area<select id="scope"><option value="region">Atlanta 11-county region</option><option value="state">All available areas</option></select></label></div><label>Find a place<input id="place-search" type="search" placeholder="County, city or district name"></label><div id="selected-places" class="selection"></div><div class="rule"><h2>Indicators</h2><div id="indicator-chips"></div><button class="full" id="browse">Browse ${new Intl.NumberFormat().format(catalog.datasets.reduce((n, d) => n + d.fields.filter((f) => !f.moe).length, 0))} indicators</button><label>Color the map by<select id="metric"></select></label></div><div class="rule"><h2>Map settings</h2><label>Basemap<select id="basemap"><option value="streets">Street map</option><option value="imagery">Aerial imagery</option><option value="none">Boundaries only</option></select></label><div class="control-row"><label>Color<select id="ramp"><option value="teal">Teal</option><option value="purple">Purple</option><option value="blue">Blue</option></select></label><label>Classes<select id="binning"><option value="quantile">Quantiles</option><option value="equal">Equal intervals</option><option value="stddev">Standard deviation</option></select></label></div><div class="control-row"><label>Minimum<input id="min" type="number" step="any" placeholder="Any"></label><label>Maximum<input id="max" type="number" step="any" placeholder="Any"></label></div><button id="reset" class="full">Clear selections & filters</button></div><div class="rule"><button class="full" id="import">Add your data</button><p class="small muted">Join a spreadsheet by geographic ID or add a spatial layer. Your file is private to this session.</p><div id="custom-summary"></div></div></aside><div><section class="panel map-panel"><div class="panel-head"><div><h2 id="map-title">Loading indicators…</h2><p id="map-subtitle"></p></div><button id="fit" aria-label="Fit map to visible geography">Fit map</button></div><div id="map" role="region" aria-label="Interactive geography map. The same values and selection controls are available in the table below."></div><div class="map-bottom"><div id="legend" class="legend"></div><span id="row-count" class="small muted"></span></div></section><div class="below-map"><section class="panel"><div class="chart-toolbar"><h2>Compare places</h2><select id="compare-mode" aria-label="Comparison chart type"><option value="bar">Bar chart</option><option value="scatter">Scatterplot</option></select></div><label id="y-label" hidden>Compare with<select id="y-metric"></select></label><div id="comparison" class="chart"></div><p class="source-note">Select a bar or point to highlight its geography on the map. Use the table for every value.</p></section><section class="panel"><h2>Distribution</h2><div id="histogram" class="chart"></div><p class="source-note">Select a range to filter the map, charts and table together.</p><div id="selection-detail"></div></section></div><section class="panel table-panel"><div class="panel-head" style="padding:0 0 14px"><div><h2>Data table</h2><p id="table-count"></p></div><button id="select-visible">Select visible places</button></div><div class="table-wrap" id="table"></div><div class="pager"><button id="prev">Previous</button><span id="page-number" class="small"></span><button id="next">Next</button></div><p id="data-source" class="source-note"></p></section></div></div><div id="context-section"></div>`;
  $("#scope").value = state.scope;
  $("#ramp").value = state.ramp;
  $("#binning").value = state.binning;
  map = L.map("map", { preferCanvas: false, scrollWheelZoom: false, zoomSnap: 0.25 }).setView(
    [33.85, -84.25],
    8,
  );
  setBasemap();
  bind("#geography", "change", async (e) => {
    state.geo = e.target.value;
    state.selected.clear();
    state.keys = state.keys.filter(
      (k) =>
        k.startsWith("user.") ||
        catalog.datasets.find((d) => k.startsWith(d.id + "."))?.layers[
          state.geo
        ] !== undefined,
    );
    if (!state.keys.length) state.keys = ["population.TotPop_e24"];
    await loadData(true);
  });
  bind("#scope", "change", (e) => {
    state.scope = e.target.value;
    state.selected.clear();
    renderAll(true);
  });
  bind("#place-search", "input", (e) => {
    state.search = e.target.value;
    state.pageIndex = 0;
    renderAll();
  });
  bind("#metric", "change", (e) => {
    state.metric = e.target.value;
    state.min = "";
    state.max = "";
    $("#min").value = "";
    $("#max").value = "";
    renderAll();
  });
  bind("#ramp", "change", (e) => {
    state.ramp = e.target.value;
    renderAll();
  });
  bind("#binning", "change", (e) => {
    state.binning = e.target.value;
    renderAll();
  });
  bind("#basemap", "change", (e) => {
    state.basemap = e.target.value;
    setBasemap();
    renderMap();
  });
  for (let s of ["min", "max"])
    bind("#" + s, "input", (e) => {
      state[s] = e.target.value;
      state.pageIndex = 0;
      renderAll();
    });
  bind("#reset", "click", () => {
    state.selected.clear();
    state.search = "";
    state.min = "";
    state.max = "";
    ["place-search", "min", "max"].forEach((s) => ($("#" + s).value = ""));
    renderAll(true);
  });
  bind("#fit", "click", () => fitMap());
  bind("#browse", "click", browseIndicators);
  bind("#import", "click", importDialog);
  bind("#export", "click", exportDialog);
  bind("#save-session", "click", saveSession);
  bind("#load-session", "click", () => $("#session-file").click());
  bind("#session-file", "change", loadSession);
  bind("#compare-mode", "change", renderComparison);
  bind("#y-metric", "change", (e) => {
    state.y = e.target.value;
    renderComparison();
  });
  bind("#select-visible", "click", () => {
    state.selected = new Set(visibleRows().map((r) => r.GEOID));
    renderAll();
  });
  bind("#prev", "click", () => {
    state.pageIndex = Math.max(0, state.pageIndex - 1);
    renderTable();
  });
  bind("#next", "click", () => {
    state.pageIndex++;
    renderTable();
  });
}
function setBasemap() {
  if (baseLayer) map.removeLayer(baseLayer);
  if (state.basemap === "none") return;
  let imagery = state.basemap === "imagery";
  baseLayer = L.tileLayer(
    imagery
      ? "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
      : "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 18,
      crossOrigin: true,
      attribution: imagery
        ? "Imagery © Esri, Maxar, Earthstar Geographics"
        : '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  ).addTo(map);
}
async function loadData(fit = false) {
  const id = ++renderId;
  $("#map-title").textContent = "Loading indicators…";
  try {
    const keys = state.keys.filter((k) => !k.startsWith("user."));
    const [geo, data] = await Promise.all(
      state.preview
        ? [
            post("/api/preview", {
              kind: "geography",
              catalog,
              geo: state.geo,
            }),
            post("/api/preview", {
              kind: "data",
              catalog,
              geo: state.geo,
              keys,
            }),
          ]
        : [
            api("/api/geography?geo=" + encodeURIComponent(state.geo)),
            api(
              "/api/data?" +
                new URLSearchParams({ geo: state.geo, keys: keys.join(",") }),
            ),
          ],
    );
    if (id !== renderId) return;
    state.features = geo.features;
    state.data = data.rows;
    state.fields = data.fields;
    state.stale = geo.stale || data.stale;
    state.fetched = Math.min(geo.fetched, data.fetched);
    state.source = geo.source;
    if (state.custom)
      for (let key of state.custom.fields)
        state.fields.push({
          id: "user." + key,
          name: key,
          alias: key,
          unit: "number",
          source: "Your file",
          period: "Session only",
          url: "",
        });
    state.rows = joinRows(state.features, state.data, state.custom);
    if (!state.fields.some((f) => f.id === state.metric))
      state.metric = state.fields[0].id;
    if (!state.fields.some((f) => f.id === state.y))
      state.y = state.fields[1]?.id || state.metric;
    renderControls();
    renderAll(fit);
  } catch (e) {
    if (id !== renderId) return;
    $("#map-title").textContent = "Data could not be loaded";
    $("#map-subtitle").textContent = e.message;
    toast(e.message);
  }
}
function renderControls() {
  $("#metric").innerHTML = opts(state.fields, state.metric);
  $("#y-metric").innerHTML = opts(state.fields, state.y);
  $("#indicator-chips").innerHTML = state.fields
    .map(
      (f) =>
        `<div class="indicator-chip"><div>${esc(fieldLabel(f.id))}<span class="key">${esc(f.dataset || f.source)} · ${esc(f.period)}</span></div><button data-remove="${esc(f.id)}" aria-label="Remove ${esc(f.alias)}">×</button></div>`,
    )
    .join("");
  $$("[data-remove]").forEach(
    (b) =>
      (b.onclick = () => {
        if (
          state.keys.filter((k) => !k.startsWith("user.")).length <= 1 &&
          !b.dataset.remove.startsWith("user.")
        )
          return toast("Keep at least one published indicator.");
        state.keys = state.keys.filter((k) => k !== b.dataset.remove);
        if (b.dataset.remove.startsWith("user."))
          state.custom.fields = state.custom.fields.filter(
            (k) => "user." + k !== b.dataset.remove,
          );
        loadData();
      }),
  );
}
function visibleRows() {
  return filterRows(state.rows, state);
}
function togglePlace(id, zoom = false) {
  state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
  renderAll();
  if (zoom) {
    const f = state.features.find((f) => f.properties.GEOID === id);
    if (f)
      map.fitBounds(L.geoJSON(f).getBounds(), {
        maxZoom: 11,
        padding: [30, 30],
      });
  }
}
function renderAll(fit = false) {
  if (!state.rows.length) return;
  const visible = new Set(visibleRows().map((r) => r.GEOID));
  state.selected = new Set([...state.selected].filter((id) => visible.has(id)));
  renderMap();
  renderStats();
  renderTable();
  renderComparison();
  renderHistogram();
  renderSelection();
  renderContext();
  if (fit) fitMap();
}
function renderMap() {
  if (!map) return;
  const rows = visibleRows(),
    ids = new Set(rows.map((r) => r.GEOID)),
    byId = new Map(rows.map((r) => [r.GEOID, r]));
  const bs = breaks(
    rows.map((r) => r[state.metric]),
    state.binning,
  );
  state.breaks = bs;
  if (thematic) map.removeLayer(thematic);
  thematic = L.geoJSON(
    state.features.filter((f) => ids.has(f.properties.GEOID)),
    {
      style: (f) => ({
        color: state.selected.has(f.properties.GEOID) ? "#c57020" : "#65887f",
        weight: state.selected.has(f.properties.GEOID) ? 3 : 1,
        fillColor: color(
          byId.get(f.properties.GEOID)?.[state.metric],
          bs,
          state.ramp,
        ),
        fillOpacity: state.basemap === "imagery" ? 0.6 : 0.82,
      }),
      onEachFeature: (f, l) => {
        const r = byId.get(f.properties.GEOID);
        l.bindTooltip(
          esc(r.Name) + ": " + esc(fmt(r[state.metric], currentField().unit)),
          { sticky: true },
        );
        l.on("click", () => togglePlace(r.GEOID));
        l.on("add", () => {
          const el = l.getElement();
          if (el) {
            el.setAttribute("tabindex", "0");
            el.setAttribute("role", "button");
            el.setAttribute(
              "aria-label",
              r.Name + ", " + fmt(r[state.metric], currentField().unit),
            );
            el.onkeydown = (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                togglePlace(r.GEOID);
              }
            };
          }
        });
      },
    },
  ).addTo(map);
  $("#map-title").textContent = fieldLabel(state.metric);
  $("#map-subtitle").textContent =
    (currentField().period || "Your data") +
    " · " +
    catalog.geographies.find((g) => g.id === state.geo)?.label;
  $("#row-count").textContent = rows.length + " places";
  const vals = rows
      .map((r) => number(r[state.metric]))
      .filter((v) => v !== null),
    bounds = vals.length ? [Math.min(...vals), ...bs, Math.max(...vals)] : [];
  $("#legend").innerHTML =
    bounds
      .slice(0, -1)
      .map((b, i) => {
        let middle = (b + bounds[i + 1]) / 2;
        return `<span><i class="swatch" style="background:${color(middle, bs, state.ramp)}"></i>${esc(fmt(b, currentField().unit))} – ${esc(fmt(bounds[i + 1], currentField().unit))}</span>`;
      })
      .join("") +
    (bounds.length === 1 ? esc(fmt(bounds[0], currentField().unit)) : "") +
    '<span><i class="swatch" style="background:#d7dbd7"></i>No value</span>';
}
function fitMap() {
  if (thematic?.getLayers().length)
    map.fitBounds(thematic.getBounds(), { padding: [20, 20], maxZoom: 11 });
}
function stat(label, value, note) {
  return `<div class="stat"><div class="label">${esc(label)}</div><strong>${esc(value)}</strong><span>${esc(note)}</span></div>`;
}
function housingRows() {
  let rows = housing?.counties || [];
  if (state.geo !== "County")
    return rows.filter((r) =>
      [
        "Cherokee",
        "Clayton",
        "Cobb",
        "DeKalb",
        "Douglas",
        "Fayette",
        "Forsyth",
        "Fulton",
        "Gwinnett",
        "Henry",
        "Rockdale",
      ].includes(r.name),
    );
  let candidates = visibleRows(),
    picked = candidates.filter((r) => state.selected.has(r.GEOID));
  if (picked.length) candidates = picked;
  const names = new Set(
    candidates.map((r) => r.Name.replace(/ County(?:, Georgia)?$/, "")),
  );
  return rows.filter((r) => names.has(r.name));
}
function renderStats() {
  const rows = visibleRows(),
    selected = rows.filter((r) => state.selected.has(r.GEOID)),
    active = selected.length ? selected : rows;
  if (state.page === "housing" && state.geo === "County") {
    let hs = housingRows(),
      base = hs.reduce((n, r) => n + r.baseline, 0),
      total = hs.reduce((n, r) => n + r.values["2025"], 0),
      added = total - base;
    $("#stats").innerHTML =
      stat(
        "Housing units, 2025",
        fmt(total),
        hs.length + " counties · Census estimates",
      ) +
      stat(
        "Net units added since 2020",
        fmt(added),
        "April 2020 baseline to July 2025",
      ) +
      stat(
        "Published regional goal",
        fmt(367000),
        "Additional homes by 2035 · proposed",
      ) +
      stat(
        "Places selected",
        state.selected.size ? fmt(selected.length) : "All " + hs.length,
        "Select map features or table rows",
      );
  } else {
    $("#stats").innerHTML =
      stat(
        "Places in view",
        fmt(rows.length),
        catalog.geographies.find((g) => g.id === state.geo)?.label || state.geo,
      ) +
      state.fields
        .slice(0, 3)
        .map((f) => {
          let v = active.map((r) => number(r[f.id])).filter((x) => x !== null);
          let value = v.length
            ? v.length === 1
              ? fmt(v[0], f.unit)
              : fmt(Math.min(...v), f.unit) +
                " – " +
                fmt(Math.max(...v), f.unit)
            : "Not available";
          return stat(
            fieldLabel(f.id),
            value,
            v.length === 1
              ? "Selected place"
              : "Range across " + v.length + " places",
          );
        })
        .join("");
  }
}
function renderSelection() {
  const rows = state.rows.filter((r) => state.selected.has(r.GEOID));
  $("#selected-places").innerHTML =
    rows
      .slice(0, 8)
      .map(
        (r) =>
          `<span class="chip">${esc(r.Name)} <button data-clear="${esc(r.GEOID)}" aria-label="Remove ${esc(r.Name)} from selection">×</button></span>`,
      )
      .join("") +
    (rows.length > 8
      ? `<span class="chip">+${rows.length - 8} more</span>`
      : "");
  $$("[data-clear]").forEach(
    (b) => (b.onclick = () => togglePlace(b.dataset.clear)),
  );
  $("#selection-detail").innerHTML = rows.length
    ? `<h3>${rows.length === 1 ? esc(rows[0].Name) : rows.length + " selected places"}</h3><p class="small">${
        rows.length === 1
          ? state.fields
              .slice(0, 5)
              .map(
                (f) =>
                  esc(fieldLabel(f.id)) +
                  ": <strong>" +
                  esc(fmt(rows[0][f.id], f.unit)) +
                  "</strong>",
              )
              .join("<br>")
          : "Downloads include these selected places. Clear selections to download all places in view."
      }</p>`
    : '<p class="small muted">Select a place for its profile. Select multiple places to compare and download them together.</p>';
}
function renderTable() {
  let rows = visibleRows().slice();
  rows.sort((a, b) => {
    let x = a[state.sort],
      y = b[state.sort];
    if (x == null) return y == null ? 0 : 1;
    if (y == null) return -1;
    let c =
      typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y));
    return state.desc ? -c : c;
  });
  const pages = Math.max(1, Math.ceil(rows.length / 30));
  state.pageIndex = Math.min(pages - 1, state.pageIndex);
  let shown = rows.slice(state.pageIndex * 30, state.pageIndex * 30 + 30);
  $("#table").innerHTML =
    `<table><thead><tr><th>Select</th><th><button data-sort="Name">Place ${state.sort === "Name" ? (state.desc ? "↓" : "↑") : ""}</button></th>${state.fields.map((f) => `<th><button data-sort="${esc(f.id)}">${esc(fieldLabel(f.id))} ${state.sort === f.id ? (state.desc ? "↓" : "↑") : ""}</button></th>`).join("")}</tr></thead><tbody>${shown.map((r) => `<tr class="${state.selected.has(r.GEOID) ? "selected" : ""}"><td><input type="checkbox" data-select="${esc(r.GEOID)}" aria-label="Select ${esc(r.Name)}" ${state.selected.has(r.GEOID) ? "checked" : ""}></td><td><button data-zoom="${esc(r.GEOID)}">${esc(r.Name)}</button><br><small class="muted">${esc(r.GEOID)}</small></td>${state.fields.map((f) => `<td class="num">${esc(fmt(r[f.id], f.unit))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  $("#table-count").textContent =
    rows.length + " places · " + state.fields.length + " indicators";
  $("#page-number").textContent =
    "Page " + (state.pageIndex + 1) + " of " + pages;
  $("#prev").disabled = state.pageIndex === 0;
  $("#next").disabled = state.pageIndex >= pages - 1;
  $$("[data-sort]").forEach(
    (b) =>
      (b.onclick = () => {
        state.desc = state.sort === b.dataset.sort ? !state.desc : false;
        state.sort = b.dataset.sort;
        renderTable();
      }),
  );
  $$("[data-select]").forEach(
    (b) => (b.onchange = () => togglePlace(b.dataset.select)),
  );
  $$("[data-zoom]").forEach(
    (b) => (b.onclick = () => togglePlace(b.dataset.zoom, true)),
  );
  const sources = [
    ...new Map(
      state.fields.map((f) => [f.url, { url: f.url, name: f.source }]),
    ).values(),
  ];
  $("#data-source").innerHTML =
    sources
      .map((s) =>
        s.url
          ? `<a href="${esc(safeLink(s.url))}" target="_blank" rel="noopener">${esc(s.name)}</a>`
          : esc(s.name),
      )
      .join(" · ") +
    " · Read " +
    new Date(state.fetched * 1000).toLocaleDateString("en-US") +
    (state.stale ? " · Cached copy: upstream source unavailable." : "") +
    "<br>ACS estimates describe 2020–2024, with sampling uncertainty. Search “MOE” with margins of error enabled to include uncertainty fields. Missing or suppressed values remain blank.";
}
function chartSvg(inner, label, w = 520, h = 280) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="group" aria-label="${esc(label)}">${inner}</svg>`;
}
function renderComparison() {
  const mode = $("#compare-mode").value;
  $("#y-label").hidden = mode !== "scatter";
  let rows = visibleRows().filter((r) => number(r[state.metric]) !== null),
    inner = "";
  if (!rows.length) {
    $("#comparison").innerHTML =
      '<p class="empty">No values for this filter.</p>';
    return;
  }
  if (mode === "bar") {
    rows.sort((a, b) => b[state.metric] - a[state.metric]);
    let shown = rows.slice(0, 12),
      max = Math.max(...shown.map((r) => r[state.metric]), 0),
      min = Math.min(...shown.map((r) => r[state.metric]), 0);
    const x=v=>146+(v-min)/(max-min||1)*245, zero=x(0);
    let h = Math.max(240, shown.length * 28 + 12);
    for (let [i, r] of shown.entries()) {
      let y = i * 28 + 5;
      inner += `<g role="button" tabindex="0" data-point="${esc(r.GEOID)}" aria-label="${esc(r.Name + ": " + fmt(r[state.metric], currentField().unit))}"><text x="0" y="${y + 16}">${esc(r.Name.slice(0, 19))}</text><rect x="${Math.min(zero,x(r[state.metric]))}" y="${y}" width="${Math.max(1,Math.abs(x(r[state.metric])-zero))}" height="21" rx="2" fill="${state.selected.has(r.GEOID) ? "#b36c26" : color(r[state.metric], state.breaks, state.ramp)}"/><text x="400" y="${y + 16}">${esc(fmt(r[state.metric], currentField().unit))}</text></g>`;
    }
    if(min<0)inner+=`<line x1="${zero}" x2="${zero}" y1="0" y2="${h}" stroke="#627a70"/>`;
    $("#comparison").innerHTML =
      chartSvg(inner, "Ranked places by " + fieldLabel(state.metric), 520, h) +
      (rows.length > 12
        ? '<p class="small muted">Top 12 values. The table contains all places.</p>'
        : "");
  } else {
    rows = rows.filter((r) => number(r[state.y]) !== null);
    if (!rows.length) {
      $("#comparison").innerHTML =
        '<p class="empty">Select a second indicator with overlapping values.</p>';
      return;
    }
    let xs = rows.map((r) => r[state.metric]),
      ys = rows.map((r) => r[state.y]),
      xmin = Math.min(...xs),
      xmax = Math.max(...xs),
      ymin = Math.min(...ys),
      ymax = Math.max(...ys);
    const x = (v) => 55 + ((v - xmin) / (xmax - xmin || 1)) * 430,
      y = (v) => 230 - ((v - ymin) / (ymax - ymin || 1)) * 200;
    inner = '<path d="M55 20V230H495" stroke="#a3b7ae" fill="none"/>';
    for (let r of rows)
      inner += `<circle class="point" role="button" tabindex="0" data-point="${esc(r.GEOID)}" aria-label="${esc(r.Name + ", " + fieldLabel(state.metric) + ": " + fmt(r[state.metric], currentField().unit) + ", " + fieldLabel(state.y) + ": " + fmt(r[state.y], currentField(state.y).unit))}" cx="${x(r[state.metric])}" cy="${y(r[state.y])}" r="${state.selected.has(r.GEOID) ? 7 : 4}" fill="${state.selected.has(r.GEOID) ? "#b36c26" : "#2f7e77"}"><title>${esc(r.Name)}</title></circle>`;
    inner += `<text x="55" y="249">${esc(fmt(xmin, currentField().unit))}</text><text x="490" y="249" text-anchor="end">${esc(fmt(xmax, currentField().unit))}</text><text x="49" y="30" text-anchor="end">${esc(fmt(ymax, currentField(state.y).unit))}</text><text x="49" y="230" text-anchor="end">${esc(fmt(ymin, currentField(state.y).unit))}</text><text x="275" y="275" text-anchor="middle">${esc(fieldLabel(state.metric).slice(0, 65))}</text>`;
    $("#comparison").innerHTML = chartSvg(
      inner,
      fieldLabel(state.metric) + " compared with " + fieldLabel(state.y),
    );
  }
  $$("#comparison [data-point]").forEach((el) => {
    el.onclick = () => togglePlace(el.dataset.point, true);
    el.onkeydown = (e) => {
      if (["Enter", " "].includes(e.key)) {
        e.preventDefault();
        el.onclick();
      }
    };
  });
}
function renderHistogram() {
  const rows = state.rows.filter(
      (r) =>
        (state.scope !== "region" || r.region) &&
        (!state.search ||
          r.Name.toLowerCase().includes(state.search.toLowerCase())),
    ),
    v = rows.map((r) => number(r[state.metric])).filter((x) => x !== null);
  if (!v.length) {
    $("#histogram").innerHTML = '<p class="empty">No values to distribute.</p>';
    return;
  }
  let min = Math.min(...v),
    max = Math.max(...v),
    width = (max - min) / 8 || 1,
    bins = Array.from({ length: 8 }, (_, i) => ({
      lo: min + i * width,
      hi: min + (i + 1) * width,
      n: 0,
    }));
  for (let x of v) bins[Math.min(7, Math.floor((x - min) / width))].n++;
  let peak = Math.max(...bins.map((b) => b.n), 1),
    inner = '<path d="M36 15V220H505" stroke="#a3b7ae" fill="none"/>';
  bins.forEach((b, i) => {
    let x = 43 + i * 57,
      h = (b.n / peak) * 170;
    inner += `<g role="button" tabindex="0" data-bin="${i}" aria-label="Filter ${esc(fmt(b.lo, currentField().unit))} to ${esc(fmt(b.hi, currentField().unit))}: ${b.n} places"><rect x="${x}" y="${220 - h}" width="47" height="${Math.max(2, h)}" fill="#6b9d8f"/><text x="${x + 23}" y="${210 - h}" text-anchor="middle">${b.n}</text></g>`;
  });
  inner += `<text x="40" y="245">${esc(fmt(min, currentField().unit))}</text><text x="495" y="245" text-anchor="end">${esc(fmt(max, currentField().unit))}</text>`;
  $("#histogram").innerHTML = chartSvg(
    inner,
    "Distribution of " + fieldLabel(state.metric),
  );
  $$("[data-bin]").forEach((el) => {
    el.onclick = () => {
      const b = bins[Number(el.dataset.bin)];
      state.min = String(b.lo);
      state.max = String(
        Number(el.dataset.bin) === 7
          ? b.hi
          : b.hi - Math.max(Number.EPSILON, Math.abs(b.hi) * Number.EPSILON),
      );
      $("#min").value = state.min;
      $("#max").value = state.max;
      renderAll();
    };
    el.onkeydown = (e) => {
      if (["Enter", " "].includes(e.key)) {
        e.preventDefault();
        el.onclick();
      }
    };
  });
}
function lineChart(rows) {
  const years = [2020, 2021, 2022, 2023, 2024, 2025],
    series = years.map((y) => rows.reduce((n, r) => n + r.values[y], 0)),
    base = rows.reduce((n, r) => n + r.baseline, 0),
    v = series.map((x) => x - base),
    max = Math.max(...v, 1);
  let points = v
      .map((x, i) => `${55 + i * 95},${230 - (x / max) * 190}`)
      .join(" "),
    inner = '<path d="M55 25V230H540" stroke="#b5c6bd" fill="none"/>';
  inner += `<polyline points="${points}" fill="none" stroke="#1d6a61" stroke-width="3"/>`;
  v.forEach(
    (x, i) =>
      (inner += `<circle cx="${55 + i * 95}" cy="${230 - (x / max) * 190}" r="4" fill="#1d6a61"/><text x="${55 + i * 95}" y="${220 - (x / max) * 190}" text-anchor="middle">${esc(fmt(x))}</text><text x="${55 + i * 95}" y="252" text-anchor="middle">${years[i]}</text>`),
  );
  return chartSvg(
    inner,
    "Net housing units added since April 2020, July estimates 2020 through 2025",
    590,
    275,
  );
}
function renderContext() {
  const goals = (catalog.goals || []).filter((g) => g.page === state.page);
  let goalHtml = goals
    .map((g) => {
      const p = Core.progress(g);
      return `<div class="goal"><div class="goal-head"><h3>${esc(g.title)}</h3><span class="status">${esc(g.status || "Reported")}</span></div>${p === null ? "<p>Progress not yet reported.</p>" : `<progress max="100" value="${Math.max(0, Math.min(100, p))}" aria-label="${esc(g.title)} progress"></progress><p>${esc(fmt(g.current))} / ${esc(fmt(g.target))} ${esc(g.unit || "")} · ${p.toFixed(1)}% of target change</p>`}<p>Baseline ${esc(fmt(g.baseline))} · Updated ${esc(g.date || "Not recorded")}${g.due ? " · Target date " + esc(g.due) : ""} · <a href="${esc(safeLink(g.source))}">Source</a></p>${g.note ? "<p>" + esc(g.note) + "</p>" : ""}</div>`;
    })
    .join("");
  if (state.page === "housing") {
    const rows = housingRows(),
      added = rows.reduce((n, r) => n + r.values["2025"] - r.baseline, 0);
    $("#context-section").innerHTML =
      `<div class="trend-section"><section class="panel"><h2>Housing production since 2020</h2><p class="muted">${state.geo !== "County" ? "Atlanta 11-county region (regional context; city and other geography selections do not change this series)" : rows.length === 11 && state.scope === "region" && !state.selected.size ? "Atlanta 11-county region" : rows.length <= 5 ? esc(rows.map((r) => r.name).join(", ")) : rows.length + " counties"} · Net change in housing units</p>${lineChart(rows)}<p class="source-note"><a href="${esc(housing.url)}">Census Vintage 2025 housing-unit estimates</a>. July 1 estimates relative to the April 1, 2020 estimates base. These are net inventory changes, not permits or verified affordable-home production.</p></section><section class="panel"><h2>Housing strategy</h2><div class="goal"><h3>367,000 additional homes by 2035</h3><p>ARC’s published regional proposal; Board adoption is scheduled for November 12, 2026.</p>${state.geo === "County" && rows.length === 11 && state.scope === "region" && !state.selected.size ? `<progress max="367000" value="${Math.max(0, added)}" aria-label="Progress toward proposed regional housing goal"></progress><p><strong>${fmt(added)} net units added</strong> · ${((added / 367000) * 100).toFixed(1)}% of the proposed regional goal</p>` : "<p>The regional target is not allocated to the selected counties here. ARC will supply its approved county targets.</p>"}<p><a href="${esc(housing.target_url)}">Read the strategy and target</a></p></div>${goalHtml}<p class="small muted">Affordable production, preservation and policy adoption can be tracked in the staff workspace as verified records become available.</p></section></div>`;
  } else if (state.page === "mobility") {
    $("#context-section").innerHTML =
      `<section class="panel" style="margin-top:24px"><h2>Mobility measures & implementation</h2><p>The current measures describe economic conditions. They do not measure individual intergenerational mobility or establish causal effects. ARC will select its final indicators, baseline and goals.</p>${goalHtml || '<p class="small muted">No ARC-approved mobility target has been supplied. Staff can add sourced goals, report observations and track milestones in the workspace.</p>'}</section>`;
  } else
    $("#context-section").innerHTML = goalHtml
      ? '<section class="panel" style="margin-top:24px"><h2>Published goals & milestones</h2>' +
        goalHtml +
        "</section>"
      : "";
}
async function browseIndicators() {
  dialog(
    "Find indicators",
    `<div class="form-grid"><label>Search by topic, field, source or year<input id="indicator-search" type="search" placeholder="Income, rent, education…" autofocus></label><label>Dataset<select id="indicator-topic"><option value="">All datasets</option>${opts(catalog.datasets, "")}</select></label></div><label class="inline"><input id="include-moe" type="checkbox">Include margins of error</label><p id="search-count" class="small muted"></p><div id="search-results"></div><div class="pager"><button id="search-more">Show more</button><button id="apply-indicators" class="primary">Apply selection</button></div>`,
  );
  let picked = new Set(state.keys),
    offset = 0,
    seq = 0;
  async function search(append = false) {
    const n = ++seq;
    try {
      let words = $("#indicator-search")
          .value.toLowerCase()
          .split(/\s+/)
          .filter(Boolean),
        topic = $("#indicator-topic").value,
        moe = $("#include-moe").checked;
      let matches = catalog.datasets
        .filter(
          (d) =>
            Object.hasOwn(d.layers, state.geo) && (!topic || d.id === topic),
        )
        .flatMap((d) =>
          d.fields
            .filter(
              (f) =>
                (moe || !f.moe) &&
                words.every((w) =>
                  (
                    f.alias +
                    " " +
                    f.name +
                    " " +
                    d.title +
                    " " +
                    d.source +
                    " " +
                    d.year
                  )
                    .toLowerCase()
                    .includes(w),
                ),
            )
            .map((f) => ({
              ...f,
              id: d.id + "." + f.name,
              dataset: d.title,
              source: d.source,
              year: d.year,
              period: d.period,
              url: d.item_url,
            })),
        );
      let r = {
        total: matches.length,
        results: matches.slice(offset, offset + 60),
      };
      if (n !== seq) return;
      $("#search-count").textContent =
        r.total + " matching indicators · " + picked.size + " selected";
      let html = r.results
        .map(
          (f) =>
            `<div class="result"><input type="checkbox" id="pick-${esc(f.id)}" data-pick="${esc(f.id)}" ${picked.has(f.id) ? "checked" : ""}><label for="pick-${esc(f.id)}"><strong>${esc(f.alias)}</strong><small>${esc(f.dataset)} · ${esc(f.period)}<br>${esc(f.name)}</small></label><a href="${esc(safeLink(f.url))}" target="_blank" rel="noopener">Metadata</a></div>`,
        )
        .join("");
      if (append) $("#search-results").insertAdjacentHTML("beforeend", html);
      else
        $("#search-results").innerHTML =
          html || '<p class="empty">No matching indicators.</p>';
      $("#search-more").disabled = offset + 60 >= r.total;
      $$("[data-pick]").forEach(
        (b) =>
          (b.onchange = () => {
            b.checked
              ? picked.add(b.dataset.pick)
              : picked.delete(b.dataset.pick);
            $("#search-count").textContent =
              r.total + " matching indicators · " + picked.size + " selected";
          }),
      );
    } catch (e) {
      toast(e.message);
    }
  }
  let timer;
  bind("#indicator-search", "input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      offset = 0;
      search();
    }, 220);
  });
  for (let id of ["indicator-topic", "include-moe"])
    bind("#" + id, "change", () => {
      offset = 0;
      search();
    });
  bind("#search-more", "click", () => {
    offset += 60;
    search(true);
  });
  bind("#apply-indicators", "click", async () => {
    if (!picked.size || picked.size > 40)
      return toast("Select 1–40 indicators.");
    state.keys = [...picked];
    $("#dialog").close();
    await loadData();
  });
  await search();
}
function saveSession() {
  download(
    {
      format: "clyde-regional-session",
      version: 1,
      page: state.page,
      geo: state.geo,
      keys: state.keys,
      metric: state.metric,
      y: state.y,
      scope: state.scope,
      search: state.search,
      min: state.min,
      max: state.max,
      ramp: state.ramp,
      binning: state.binning,
      basemap: state.basemap,
      comparison: $("#compare-mode").value,
      sort: state.sort,
      descending: state.desc,
      selected: [...state.selected],
      custom: state.custom,
      view: { center: map.getCenter(), zoom: map.getZoom() },
    },
    "regional-data-session.json",
  );
  toast("Session saved. It includes any private data you added.");
}
async function loadSession(e) {
  const f = e.target.files[0];
  if (!f) return;
  try {
    if (f.size > 32 * 1024 * 1024) throw Error("Session exceeds 32 MB.");
    const s = Core.validateSession(JSON.parse(await f.text()));
    if (!catalog.geographies.some((g) => g.id === s.geo))
      throw Error("This session uses a geography no longer in the catalog.");
    Object.assign(state, {
      page: s.page,
      geo: s.geo,
      keys: s.keys,
      metric: s.metric,
      y: s.y,
      scope: s.scope === "region" ? "region" : "state",
      search: String(s.search || ""),
      min: String(s.min || ""),
      max: String(s.max || ""),
      ramp: Core.ramps[s.ramp] ? s.ramp : "teal",
      binning: s.binning,
      basemap: s.basemap,
      selected: new Set(s.selected),
      custom: s.custom,
      sort: s.sort || "Name",
      desc: Boolean(s.descending),
    });
    map.remove();
    history.replaceState(
      null,
      "",
      "/" + state.page + (state.preview ? "?draft=1" : ""),
    );
    document.title = catalog.dashboards[state.page].title + " | VentiMath";
    $$("nav a").forEach((a) => {
      a.removeAttribute("aria-current");
      if (a.getAttribute("href") === "/" + state.page)
        a.setAttribute("aria-current", "page");
    });
    appHtml();
    $("#geography").value = state.geo;
    $("#scope").value = state.scope;
    $("#place-search").value = state.search;
    $("#min").value = state.min;
    $("#max").value = state.max;
    $("#ramp").value = state.ramp;
    $("#binning").value = state.binning;
    $("#basemap").value = state.basemap;
    $("#compare-mode").value = s.comparison === "scatter" ? "scatter" : "bar";
    setBasemap();
    await loadData(true);
    if (s.view && Number.isFinite(s.view.zoom))
      map.setView(s.view.center, Math.max(3, Math.min(18, s.view.zoom)));
    renderCustom();
    toast("Session restored.");
  } catch (e) {
    toast(e.message);
  } finally {
    e.target.value = "";
  }
}
function importDialog() {
  dialog(
    "Add your data",
    `<p>Upload a table to join by geographic ID, or add a spatial layer. Conversion is temporary; the server does not retain your file. Save the session to keep a copy.</p><label>Spreadsheet or spatial file<input id="import-file" type="file" accept=".csv,.xlsx,.geojson,.json,.zip,.kml,.kmz,.gpkg,.parquet,.geoparquet"></label><p class="small muted">CSV, Excel, GeoJSON, zipped Shapefile/File Geodatabase, KML/KMZ, GeoPackage or GeoParquet. Up to 25 MB and 15,000 features.</p><div id="import-preview"></div><button id="template">Download sample spreadsheet</button>`,
  );
  bind("#template", "click", async () => {
    try {
      let r = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "xlsx",
          catalog: state.preview ? catalog : undefined,
          geo: state.geo,
          keys: state.keys.filter((k) => !k.startsWith("user.")).slice(0, 3),
          selected: visibleRows().map((r) => r.GEOID),
        }),
      });
      if (!r.ok) throw Error((await r.json()).error);
      download(await r.blob(), "regional-data-sample.xlsx");
    } catch (e) {
      toast(e.message);
    }
  });
  bind("#import-file", "change", async (e) => {
    let file = e.target.files[0];
    if (!file) return;
    await previewImport(file);
  });
}
async function previewImport(file, layer) {
  $("#import-preview").innerHTML = '<p class="note">Reading file…</p>';
  try {
    let form = new FormData();
    form.append("file", file);
    if (layer) form.append("layer", layer);
    let r = await api("/api/import", { method: "POST", body: form });
    if (r.choose_layer) {
      $("#import-preview").innerHTML =
        `<label>Layer<select id="import-layer">${r.layers.map((l) => `<option>${esc(l)}</option>`).join("")}</select></label><button id="choose-layer">Read layer</button>`;
      bind("#choose-layer", "click", () =>
        previewImport(file, $("#import-layer").value),
      );
      return;
    }
    const defaultKey =
      r.columns.find((c) => c.toLowerCase() === "geoid") || r.columns[0];
    let numeric = r.columns.filter(
      (c) => c !== defaultKey && r.rows.some((row) => number(row[c]) !== null),
    );
    $("#import-preview").innerHTML =
      `<p class="note">${r.count} records read${r.geojson ? " with geometry" : ""}.</p><label>Join this column to geographic ID<select id="join-column">${r.columns.map((c) => `<option ${c === defaultKey ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label><p class="small" id="match-count"></p><div class="field-list">${numeric.map((c) => `<label><input type="checkbox" data-user-field="${esc(c)}" checked>${esc(c)}</label>`).join("")}</div><div class="actions" style="margin-top:15px"><button id="apply-import" class="primary">Add to session</button></div>`;
    const match = () => {
      let keys = new Set(r.rows.map((x) => String(x[$("#join-column").value])));
      $("#match-count").textContent =
        state.features.filter((f) => keys.has(f.properties.GEOID)).length +
        " of " +
        state.features.length +
        " current geographies match.";
    };
    match();
    bind("#join-column", "change", match);
    bind("#apply-import", "click", () => {
      let fields = $$("[data-user-field]:checked")
        .map((x) => x.dataset.userField)
        .slice(0, 20);
      if (!fields.length && !r.geojson)
        return toast("Choose at least one numeric field.");
      state.keys = state.keys.filter((k) => !k.startsWith("user."));
      state.custom = { ...r, join: $("#join-column").value, fields };
      for (let f of fields) state.keys.push("user." + f);
      $("#dialog").close();
      loadData();
      renderCustom();
    });
  } catch (e) {
    $("#import-preview").innerHTML =
      '<p class="error">' + esc(e.message) + "</p>";
  }
}
function renderCustom() {
  if (customLayer) map.removeLayer(customLayer);
  if (!state.custom) {
    $("#custom-summary").innerHTML = "";
    return;
  }
  $("#custom-summary").innerHTML =
    `<p class="small"><strong>${esc(state.custom.name)}</strong><br>${state.custom.count} rows · ${state.custom.fields.length} numeric fields</p><button id="remove-custom">Remove file</button>`;
  if (state.custom.geojson)
    customLayer = L.geoJSON(state.custom.geojson, {
      style: { color: "#bd7024", weight: 2, fillOpacity: 0.15 },
      pointToLayer: (f, latlng) =>
        L.circleMarker(latlng, { radius: 5, color: "#a3541d" }),
    }).addTo(map);
  bind("#remove-custom", "click", () => {
    state.custom = null;
    state.keys = state.keys.filter((k) => !k.startsWith("user."));
    renderCustom();
    loadData();
  });
}
function exportDialog() {
  dialog(
    "Download data & graphics",
    `<p>${state.selected.size ? state.selected.size + " selected" : visibleRows().length + " visible"} places. Table and geographic downloads join all selected indicators by geographic ID.</p><h3>Data</h3><div class="actions">${["CSV", "XLSX", "GeoJSON", "GeoPackage", "File GDB", "GeoParquet"].map((x, i) => `<button data-export="${["csv", "xlsx", "geojson", "gpkg", "gdb", "parquet"][i]}">${x}</button>`).join("")}</div><h3 style="margin-top:25px">Map graphic</h3><p class="small muted">A clean thematic map with the current colors, geographic extent and source labels. Basemap imagery is omitted from downloadable graphics.</p><div class="actions">${["PNG", "JPG", "SVG", "PDF"].map((x) => `<button data-graphic="${x.toLowerCase()}">${x}</button>`).join("")}</div><p id="export-status" role="status"></p>`,
  );
  $$("[data-export]").forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        $("#export-status").textContent = "Preparing download…";
        try {
          const r = await fetch("/api/export", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind: b.dataset.export,
              catalog: state.preview ? catalog : undefined,
              geo: state.geo,
              keys: state.keys.filter((k) => !k.startsWith("user.")),
              selected: state.selected.size
                ? [...state.selected]
                : visibleRows().map((r) => r.GEOID),
              custom: state.custom,
            }),
          });
          if (!r.ok) throw Error((await r.json()).error);
          const name =
            r.headers
              .get("Content-Disposition")
              ?.match(/filename="([^"]+)"/)?.[1] || "regional-data";
          download(await r.blob(), name);
          $("#export-status").textContent = "Download ready.";
        } catch (e) {
          $("#export-status").textContent = e.message;
        } finally {
          b.disabled = false;
        }
      }),
  );
  $$("[data-graphic]").forEach(
    (b) => (b.onclick = () => exportGraphic(b.dataset.graphic)),
  );
}
function mapSvg() {
  const size = map.getSize(),
    sx = 1000 / size.x,
    sy = 570 / size.y,
    rows = visibleRows(),
    byId = new Map(rows.map((r) => [r.GEOID, r]));
  let inner =
    '<rect width="1000" height="800" fill="white"/><text x="25" y="30" font-family="Arial" font-size="20" fill="#183e42">' +
    esc(fieldLabel(state.metric).slice(0, 90)) +
    '</text><g transform="translate(0 55)" clip-path="url(#map-clip)">';
  const ring = (coords) =>
    coords
      .map((c, i) => {
        let p = map.latLngToContainerPoint([c[1], c[0]]);
        return (
          (i ? "L" : "M") + (p.x * sx).toFixed(2) + "," + (p.y * sy).toFixed(2)
        );
      })
      .join(" ") + "Z";
  for (let f of state.features) {
    if (!byId.has(f.properties.GEOID)) continue;
    let geom = f.geometry,
      polys =
        geom.type === "Polygon"
          ? [geom.coordinates]
          : geom.type === "MultiPolygon"
            ? geom.coordinates
            : [];
    for (let poly of polys)
      inner += `<path d="${poly.map(ring).join(" ")}" fill="${color(byId.get(f.properties.GEOID)[state.metric], state.breaks, state.ramp)}" fill-rule="evenodd" stroke="${state.selected.has(f.properties.GEOID) ? "#b46c25" : "#789389"}" stroke-width="${state.selected.has(f.properties.GEOID) ? 3 : 1}"/>`;
  }
  if(rows.length<=30) for(const f of state.features){
    if(!byId.has(f.properties.GEOID))continue;
    const center=L.geoJSON(f).getBounds().getCenter(),p=map.latLngToContainerPoint(center);
    inner+=`<text x="${p.x*sx}" y="${p.y*sy}" text-anchor="middle" font-family="Arial" font-size="12" fill="#183e42" stroke="white" stroke-width="3" paint-order="stroke">${esc(byId.get(f.properties.GEOID).Name)}</text>`;
  }
  inner += "</g>";
  const values = rows
    .map((r) => number(r[state.metric]))
    .filter((v) => v !== null);
  const limits = values.length
    ? [Math.min(...values), ...state.breaks, Math.max(...values)]
    : [];
  let bins = limits
    .slice(0, -1)
    .map((v, i) => ({
      fill: color((v + limits[i + 1]) / 2, state.breaks, state.ramp),
      label:
        fmt(v, currentField().unit) +
        " – " +
        fmt(limits[i + 1], currentField().unit),
    }));
  bins.push({ fill: "#d7dbd7", label: "No value" });
  bins.forEach((b, i) => {
    const x = 25 + (i % 3) * 325,
      y = 653 + Math.floor(i / 3) * 26;
    inner += `<rect x="${x}" y="${y - 12}" width="17" height="14" fill="${b.fill}"/><text x="${x + 25}" y="${y}" font-family="Arial" font-size="13" fill="#183e42">${esc(b.label)}</text>`;
  });
  inner += `<text x="25" y="724" font-family="Arial" font-size="13" fill="#183e42">${esc(currentField().period || "User supplied")} · ${esc(catalog.geographies.find((g) => g.id === state.geo)?.label || state.geo)} · ${esc(state.binning)} classes</text><text x="25" y="750" font-family="Arial" font-size="12" fill="#183e42">Source: ${esc(currentField().source)}.</text><text x="25" y="775" font-family="Arial" font-size="12" fill="#183e42">Prepared with arc.clydellmfactory.com · ${rows.length} places · ${state.selected.size} selected</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800" viewBox="0 0 1000 800"><defs><clipPath id="map-clip"><rect width="1000" height="570"/></clipPath></defs>${inner}</svg>`;
}
async function exportGraphic(kind) {
  try {
    const svg = mapSvg();
    if (kind === "svg") {
      download(svg, "regional-map.svg", "image/svg+xml");
      return;
    }
    const img = new Image(),
      url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 2000;
    canvas.height = 1600;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, 2000, 1600);
    URL.revokeObjectURL(url);
    if (kind === "pdf") {
      const r = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: fieldLabel(state.metric),
          image: canvas.toDataURL("image/png"),
          source: currentField().source + "\n" + currentField().period,
        }),
      });
      if (!r.ok) throw Error((await r.json()).error);
      download(await r.blob(), "regional-map.pdf");
    } else
      canvas.toBlob(
        (b) => download(b, "regional-map." + kind),
        kind === "jpg" ? "image/jpeg" : "image/png",
        0.95,
      );
    $("#export-status").textContent = "Graphic ready.";
  } catch (e) {
    toast(e.message || "Unable to create graphic.");
  }
}
function article(kind) {
  const common = `<a href="/housing">Regional housing</a> · <a href="/mobility">Economic mobility</a> · <a href="/explorer">Georgia data explorer</a>`;
  let content = "";
  if (kind === "guide") {
    content = `<h1>Guide & sources</h1><p>Use any application without an account. Maps, charts and tables share the same geography, indicator and value filters.</p><section><h2>Explore, compare and download</h2><ol><li>Choose a geography and area, then browse indicators by topic, source, field name or year.</li><li>Select map features, chart bars or table checkboxes. Selected places stay highlighted across views.</li><li>Choose a scatterplot and second variable for cross-variable analysis. Click histogram ranges or enter numeric limits to filter.</li><li>Download CSV or Excel, a geographic dataset, or a map graphic. Downloads use selected places when a selection exists; otherwise they use the visible filtered set.</li><li>Save a session to keep the configuration and any private data. Open the JSON file to restore it later.</li></ol></section><section><h2>Add your own data</h2><p>Download the sample spreadsheet from Add your data. It contains actual geographic IDs and selected indicators. Re-import it unchanged or add your columns. Match the geographic ID column as text so leading zeroes remain intact. Choose numeric columns for analysis.</p><p>CSV, XLSX, GeoJSON, zipped Shapefile and File Geodatabase, KML/KMZ, GeoPackage and GeoParquet are supported. Files are converted in a temporary directory and deleted after the request. Data remain in this browser tab unless you explicitly download a session or publish as an authorized staff member. Public uploads never enter the shared catalog.</p></section><section><h2>Source data and uncertainty</h2><p>ARC publishes the ACS 2020–2024 five-year estimates used here. The catalog contains ${catalog.datasets.length} source services and ${catalog.geographies.length} geography types. Field labels come from the source aliases; metadata links lead to ARC's original records. The <a href="${esc(catalog.manifest_url)}">ACS data manifest</a> documents definitions, geography and calculations.</p><p>These are estimates with sampling uncertainty. Enable margins of error in indicator search to inspect uncertainty. Missing and suppressed observations are not zero. The same label can describe different denominators, so check the source definition before comparing percentages. County medians are shown as a range, never averaged into a regional median. These data describe areas and must not be used to infer an individual's circumstances.</p><p>Housing production uses <a href="${esc(housing.url)}">Census Vintage 2025 housing-unit estimates</a>, with the April 2020 estimates base. Annual releases revise the series. ACS housing counts are contextual; they do not replace this production measure. Affordable production requires verified project records. Permits are a separate leading indicator.</p><p>ARC/Census ACS data are attributed under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. Boundaries are generalized for display; GIS exports request detailed geometry and preserve the source coordinate system. OpenStreetMap and Esri imagery attribution appears on the map.</p></section><section><h2>Staff updates</h2><p>The staff workspace supports dataset connections, private-file validation, field aliases, observation corrections, geography management, dashboard configuration and sourced goal tracking. Preview a draft, save it, and publish a new edition. Editors save drafts; publishers release or restore editions. Every publication and restore has an audit record. A restore creates a new edition, preserving history.</p><p>Public practice changes stay in the tab. Client staff sign-in uses Microsoft Entra ID and assigned application roles; tenant Conditional Access is applied by ARC. A client installation needs its own tenant registration. The demonstration's owner sign-in is separate.</p></section><section><h2>Accessibility and supported limits</h2><p>All data are available in a sortable keyboard-accessible table. Forms have visible labels; maps have table alternatives; charts expose keyboard selection. Use Tab and Enter to move through controls. Current limits are 40 simultaneous indicators, 15,000 features per layer, 25 MB uploads, 150 MB expanded archives and 300 imported columns. Larger holdings remain in the searchable catalog and load on demand.</p><p>WCAG 2.1 AA conformance will be assessed with ARC's final data, branding, tenant and user acceptance. The independent demo is not an ARC accessibility certification or FedRAMP authorization.</p></section>`;
  } else if (kind === "delivery") {
    content = `<h1>Delivery & timeline</h1><p>${common}</p><p>Three working applications share a configurable data catalog and staff workspace. This demonstration is offered for evaluation against RFP828. Official deployment, approved data definitions and organizational acceptance remain part of the paid engagement.</p><div class="panel"><div class="timeline-row"><strong>Available now</strong><div><h3>Working software and public-source demonstration</h3><p>Maps, linked analysis, table and GIS exports, session imports, housing production, staff configuration and publication history.</p></div></div><div class="timeline-row"><strong>January 2027</strong><div><h3>Agree data inventory and production environment</h3><p>Confirm ARC's housing targets and mobility definitions, acceptance cases, refresh assignments, branding, Entra roles and US hosting controls. Configure the client tenant and approved production account.</p></div></div><div class="timeline-row"><strong>After ARC inputs</strong><div><h3>Validate and accept each application</h3><p>Load approved holdings, verify joins and GIS exports, complete accessibility and security reviews, rehearse recovery and conduct staff training for up to ten people. Launch order is agreed with ARC.</p></div></div><div class="timeline-row"><strong>Through Dec. 31, 2027</strong><div><h3>Host, maintain and support</h3><p>US hosting, recurring refresh assistance, vulnerability remediation and Eastern-time weekday support within the agreed contract. Handover includes source, configuration, data procedures and operating documentation.</p></div></div></div><section><h2>Client-controlled decisions</h2><p>ARC supplies its approved indicator inventory, strategy definitions, targets, data permissions and branding. The published housing target is labeled as proposed until adoption is verified. Economic mobility uses clearly identified demonstration measures until ARC supplies the final specification. The software provides the update and tracking workflows for those decisions.</p></section>`;
  } else {
    content = `<h1>About this project</h1><p>John Clyde prepared these applications in response to the Atlanta Regional Commission's <a href="https://procurement.atlantaregional.org/opportunities/rfp828-interactive-web-mapping-and-dashboard-application-development/">RFP828</a>. This is an independent demonstration, not an official ARC service or an awarded contract.</p><section><h2>Software available for evaluation</h2><p>The applications are usable now, with public data, working imports and exports, and published source. Evaluation can include actual maps, joins, downloads and staff practice workflows. Commercial adoption includes the agreed source rights, ARC-specific configuration, hosting, support and handover.</p></section><section><h2>John Clyde and VentiMath</h2><p>John is a software engineer with experience at Google, Facebook, Lyft, D. E. Shaw and Mozart Data. Paid engineering work supports VentiMath's work to make strong math education freely available.</p><p>Other public projects: <a href="https://aquidneck.clydellmfactory.com">Aquidneck resilience dashboard</a> and <a href="https://kzfr.clydellmfactory.com">KZFR radio website</a>.</p></section><section><h2>Preparation and responsibility</h2><p>AI tools assisted development, research, testing and document preparation. The applications do not send user data to a language model. John is the proposer and delivery contact. The demonstration's source data, limitations and technical evidence are available for inspection.</p><p>Procurement should respect engineering time. A functioning application gives reviewers concrete evidence of the work; adoption, ongoing operation and further client-specific work are paid services.</p></section><section><h2>Source and ownership</h2><p><a href="https://github.com/johnclyde/atlanta-regional-applications">The public repository</a> contains the application and portable operating instructions. Public visibility permits inspection; commercial adoption and source rights are set by agreement. Third-party software and datasets retain their own licenses.</p></section>`;
  }
  $("#main").innerHTML = '<article class="article">' + content + "</article>";
}
async function start() {
  try {
    [edition, housing] = await Promise.all([
      api("/api/catalog"),
      api("/api/housing"),
    ]);
    catalog = edition.catalog;
    state.preview = new URLSearchParams(location.search).get("draft") === "1";
    if (state.preview && sessionStorage.getItem("arc-practice-catalog"))
      catalog = JSON.parse(sessionStorage.getItem("arc-practice-catalog"));
    const route = location.pathname;
    $$("nav a").forEach((a) => {
      if (a.getAttribute("href") === (route === "/" ? "/housing" : route))
        a.setAttribute("aria-current", "page");
    });
    if (["/guide", "/delivery", "/about"].includes(route))
      return article(route.slice(1));
    if (route === "/admin") return window.startAdmin();
    const cfg = catalog.dashboards[state.page];
    state.geo = cfg.geography;
    state.keys = [...cfg.indicators];
    state.ramp = cfg.ramp || "teal";
    state.binning = cfg.binning || "quantile";
    state.metric = state.keys[0];
    state.y = state.keys[1];
    document.title = (cfg.title || "Regional data") + " | VentiMath";
    appHtml();
    if (state.preview) {
      const p = document.createElement("p");
      p.className = "note";
      p.textContent = "Draft preview. These changes are not published.";
      $("#main").prepend(p);
    }
    await loadData(true);
  } catch (e) {
    $("#main").innerHTML =
      '<div class="error"><h1>Unable to load the application</h1><p>' +
      esc(e.message) +
      '</p><button id="retry">Try again</button></div>';
    bind("#retry", "click", () => location.reload());
  }
}
window.addEventListener("DOMContentLoaded", () => {
  bind("#dialog-close", "click", () => $("#dialog").close());
  start();
});
