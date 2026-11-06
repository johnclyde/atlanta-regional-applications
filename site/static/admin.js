"use strict";
let adminDraft,
  adminBase,
  adminAuth,
  adminTab = "datasets",
  adminDataset = "population";
window.startAdmin = async function () {
  adminAuth = await api("/api/auth");
  let saved = sessionStorage.getItem("arc-practice-catalog");
  adminDraft = saved ? JSON.parse(saved) : structuredClone(catalog);
  adminBase = edition.revision;
  renderAdmin();
};
function rememberDraft() {
  sessionStorage.setItem("arc-practice-catalog", JSON.stringify(adminDraft));
}
function adminOptions() {
  return adminDraft.datasets.map((d) => ({ id: d.id, label: d.title }));
}
function renderAdmin() {
  $("#main").innerHTML =
    `<div class="page-top"><div><div class="eyebrow">Data management</div><h1>Staff workspace</h1><p>${adminAuth.signed_in ? "Signed in as " + esc(adminAuth.actor) + " · " + esc(adminAuth.role) : "Practice with the complete catalog. Changes stay in this tab until an authorized publisher releases them."}</p></div><div class="actions">${adminAuth.signed_in ? '<button id="signout">Sign out</button>' : adminAuth.entra ? '<a class="button" href="/auth/login">Sign in with Microsoft</a>' : adminAuth.owner_login ? '<button id="owner-signin">Owner sign-in</button>' : ""}</div></div><div class="admin-top"><div class="badges"><span class="status">${adminAuth.signed_in ? "Staff draft" : "Practice draft"}</span><span class="status">Based on edition ${adminBase}</span></div><div class="actions"><button id="preview-draft">Preview housing</button><button id="download-catalog">Download catalog</button><button id="load-catalog">Import catalog</button><input type="file" accept=".json" id="catalog-file" hidden>${adminAuth.signed_in ? '<button id="save-draft">Save staff draft</button><button id="load-draft">Load staff draft</button>' : ""}${adminAuth.role === "publisher" ? '<button id="publish-draft" class="primary">Publish edition</button>' : ""}</div></div><div class="tabs" role="group" aria-label="Workspace sections">${["datasets", "geographies", "dashboards", "goals", "history"].map((t) => `<button data-admin-tab="${t}" aria-pressed="${adminTab === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div><div id="admin-content"></div>`;
  $$("[data-admin-tab]").forEach(
    (b) =>
      (b.onclick = () => {
        adminTab = b.dataset.adminTab;
        renderAdmin();
      }),
  );
  bind("#preview-draft", "click", () => {
    rememberDraft();
    location.href = "/housing?draft=1";
  });
  bind("#download-catalog", "click", () =>
    download(adminDraft, "regional-data-catalog.json"),
  );
  bind("#load-catalog", "click", () => $("#catalog-file").click());
  bind("#catalog-file", "change", async (e) => {
    try {
      const f = e.target.files[0];
      if (f.size > 32 * 1024 * 1024) throw Error("Catalog is too large.");
      const c = JSON.parse(await f.text());
      if (
        c.schema !== 1 ||
        !Array.isArray(c.datasets) ||
        !Array.isArray(c.geographies)
      )
        throw Error("Not a supported catalog.");
      adminDraft = c;
      rememberDraft();
      renderAdmin();
      toast("Catalog loaded into draft.");
    } catch (e) {
      toast(e.message);
    }
  });
  bind("#owner-signin", "click", () => {
    dialog(
      "Owner sign-in",
      '<p>This sign-in administers the independent demonstration.</p><form id="login-form"><label>Password<input type="password" id="password" autocomplete="current-password" required></label><button class="primary" style="margin-top:16px">Sign in</button></form>',
    );
    bind("#login-form", "submit", async (e) => {
      e.preventDefault();
      try {
        await post("/api/login", { password: $("#password").value });
        $("#dialog").close();
        adminAuth = await api("/api/auth");
        renderAdmin();
      } catch (e) {
        toast(e.message);
      }
    });
  });
  bind("#signout", "click", async () => {
    await post("/api/logout", {}, adminAuth.csrf);
    adminAuth = await api("/api/auth");
    renderAdmin();
  });
  bind("#save-draft", "click", async () => {
    try {
      await post(
        "/api/draft",
        { revision: adminBase, catalog: adminDraft },
        adminAuth.csrf,
      );
      toast("Staff draft saved.");
    } catch (e) {
      toast(e.message);
    }
  });
  bind("#load-draft", "click", async () => {
    try {
      let r = await api("/api/draft");
      adminDraft = r.catalog;
      adminBase = r.revision;
      rememberDraft();
      renderAdmin();
      toast("Staff draft loaded.");
    } catch (e) {
      toast(e.message);
    }
  });
  bind("#publish-draft", "click", publishDialog);
  ({
    datasets: renderDatasets,
    geographies: renderGeographies,
    dashboards: renderDashboardConfig,
    goals: renderGoalConfig,
    history: renderHistory,
  })[adminTab]();
}
function renderDatasets() {
  if (!adminDraft.datasets.some((d) => d.id === adminDataset))
    adminDataset = adminDraft.datasets[0]?.id;
  const d = adminDraft.datasets.find((d) => d.id === adminDataset);
  $("#admin-content").innerHTML =
    `<div class="admin-grid"><aside class="panel"><h2>Datasets</h2><label>Find a dataset<input type="search" id="dataset-search"></label><div class="admin-list" style="margin-top:14px">${adminDraft.datasets.map((d) => `<button data-dataset="${esc(d.id)}" aria-pressed="${d.id === adminDataset}">${esc(d.title)} <small>(${d.fields.length})</small></button>`).join("")}</div><div class="actions" style="margin-top:15px"><button id="connect-source">Connect ArcGIS</button><button id="upload-table">Import table</button></div></aside><section class="panel" id="dataset-detail">${d ? `<h2>${esc(d.title)}</h2><p class="small muted">${d.fields.length} fields · ${Object.keys(d.layers).length} geographies · ${esc(d.period)}</p><form id="dataset-form"><div class="form-grid"><label>Dataset title<input id="dataset-title" value="${esc(d.title)}" required></label><label>Year<input id="dataset-year" type="number" value="${d.year}" required></label><label>Source credit<input id="dataset-source" value="${esc(d.source)}" required></label><label>Reporting period<input id="dataset-period" value="${esc(d.period)}" required></label><label class="wide">Metadata URL<input id="dataset-link" type="url" value="${esc(d.item_url)}" required></label><label class="wide">Description<textarea id="dataset-description">${esc(d.description || "")}</textarea></label></div><button class="primary">Save metadata to draft</button></form><details style="margin-top:22px"><summary>Field labels and units</summary><label style="margin-top:12px">Find field<input type="search" id="field-search"></label><div id="field-editors" class="field-list" style="margin-top:12px">${d.fields.map((f, i) => `<div class="field-editor" data-field-row="${esc((f.name + " " + f.alias).toLowerCase())}"><span class="small">${esc(f.name)}</span><input data-field-index="${i}" aria-label="Label for ${esc(f.name)}" value="${esc(f.alias)}"><select data-unit-index="${i}" aria-label="Unit for ${esc(f.name)}">${["number", "percent", "points", "dollars"].map((u) => `<option ${u === f.unit ? "selected" : ""}>${u}</option>`).join("")}</select></div>`).join("")}</div><button id="save-labels" style="margin-top:10px">Save field labels</button></details><div class="actions" style="margin-top:22px"><button id="correct-observation">Correct an observation</button><button id="refresh-source">Refresh field definitions</button><button id="remove-dataset" class="danger">Remove from draft</button></div>` : "<p>Add a dataset to begin.</p>"}</section></div>`;
  $$("[data-dataset]").forEach(
    (b) =>
      (b.onclick = () => {
        adminDataset = b.dataset.dataset;
        renderDatasets();
      }),
  );
  bind("#dataset-search", "input", (e) =>
    $$("[data-dataset]").forEach(
      (b) =>
        (b.hidden = !b.textContent
          .toLowerCase()
          .includes(e.target.value.toLowerCase())),
    ),
  );
  if (d) {
    bind("#dataset-form", "submit", (e) => {
      e.preventDefault();
      Object.assign(d, {
        title: $("#dataset-title").value,
        year: Number($("#dataset-year").value),
        source: $("#dataset-source").value,
        period: $("#dataset-period").value,
        item_url: $("#dataset-link").value,
        description: $("#dataset-description").value,
      });
      rememberDraft();
      toast("Metadata saved to draft.");
    });
    bind("#field-search", "input", (e) =>
      $$("[data-field-row]").forEach(
        (el) =>
          (el.hidden = !el.dataset.fieldRow.includes(
            e.target.value.toLowerCase(),
          )),
      ),
    );
    bind("#save-labels", "click", () => {
      $$("[data-field-index]").forEach(
        (el) => (d.fields[Number(el.dataset.fieldIndex)].alias = el.value),
      );
      $$("[data-unit-index]").forEach(
        (el) => (d.fields[Number(el.dataset.unitIndex)].unit = el.value),
      );
      rememberDraft();
      toast("Field labels saved.");
    });
    bind("#remove-dataset", "click", () => {
      const used = Object.values(adminDraft.dashboards).some((cfg) =>
        cfg.indicators.some((k) => k.startsWith(d.id + ".")),
      );
      if (used)
        return toast(
          "Remove this dataset’s indicators from dashboard configurations first.",
        );
      adminDraft.datasets = adminDraft.datasets.filter((x) => x.id !== d.id);
      rememberDraft();
      renderDatasets();
    });
    bind("#correct-observation", "click", () => observationDialog(d));
    bind("#refresh-source", "click", async () => {
      try {
        if (d.records)
          throw Error(
            "Replace imported records by importing an updated table.",
          );
        const geo = Object.keys(d.layers)[0],
          m = await post("/api/inspect", { url: d.url + "/" + d.layers[geo] });
        d.fields = fieldsFromMeta(m);
        rememberDraft();
        renderDatasets();
        toast("Definitions refreshed from source aliases.");
      } catch (e) {
        toast(e.message);
      }
    });
  }
  bind("#connect-source", "click", connectDialog);
  bind("#upload-table", "click", () => staffImport("table"));
}
function fieldsFromMeta(m) {
  return m.fields
    .filter(
      (f) =>
        [
          "esriFieldTypeInteger",
          "esriFieldTypeSmallInteger",
          "esriFieldTypeDouble",
          "esriFieldTypeSingle",
          "esriFieldTypeBigInteger",
        ].includes(f.type) &&
        ![
          "OBJECTID",
          "FID",
          "LOGRECNO",
          "Vintage",
          "Shape__Area",
          "Shape__Length",
        ].includes(f.name),
    )
    .map((f) => ({
      name: f.name,
      alias: f.alias || f.name,
      unit: (f.alias || "").startsWith("%") ? "percent" : "number",
      moe: /MOE|_m\d\d$/.test(f.alias + " " + f.name),
    }));
}
function connectDialog() {
  dialog(
    "Connect a public ArcGIS layer",
    `<p>Use an HTTPS FeatureServer layer URL. The connection reads its fields and aliases; it does not publish back to ArcGIS.</p><form id="connect-form"><label>FeatureServer layer URL<input id="source-url" type="url" placeholder="https://services1.arcgis.com/…/FeatureServer/0" required></label><div class="form-grid"><label>Dataset title<input id="new-title" required></label><label>Geography<select id="new-geo">${opts(adminDraft.geographies, "County")}</select></label><label>Year<input id="new-year" type="number" value="2026" required></label><label>Source credit<input id="new-credit" value="Atlanta Regional Commission" required></label></div><button class="primary">Inspect & add to draft</button></form><p id="connect-result" role="status"></p>`,
  );
  bind("#connect-form", "submit", async (e) => {
    e.preventDefault();
    try {
      const url = $("#source-url").value.trim();
      if (!/\/FeatureServer\/\d+$/.test(url))
        throw Error("Choose a specific numeric FeatureServer layer.");
      const m = await post("/api/inspect", { url }),
        fields = fieldsFromMeta(m),
        id = $("#new-title")
          .value.toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
      if (adminDraft.datasets.some((d) => d.id === id))
        throw Error("A dataset with that name already exists.");
      const key = m.fields.find((f) => f.name.toLowerCase() === "geoid")?.name;
      if (!key)
        throw Error(
          "The layer needs a GEOID field. Import a table with an explicit join column for other keys.",
        );
      adminDraft.datasets.push({
        id,
        title: $("#new-title").value,
        source: $("#new-credit").value,
        year: Number($("#new-year").value),
        period: String($("#new-year").value),
        url: url.replace(/\/\d+$/, ""),
        item_url: url,
        license: "Review source terms",
        description: m.description || "",
        geokey: key,
        crs:
          m.extent?.spatialReference?.latestWkid ||
          m.extent?.spatialReference?.wkid ||
          4326,
        layers: { [$("#new-geo").value]: Number(url.split("/").at(-1)) },
        fields,
      });
      adminDataset = id;
      rememberDraft();
      $("#dialog").close();
      renderDatasets();
      toast(fields.length + " fields added to the draft.");
    } catch (e) {
      $("#connect-result").textContent = e.message;
    }
  });
}
function observationDialog(d) {
  dialog(
    "Correct an observation",
    `<p>This creates an explicit staff override in the next catalog edition. Source values remain in ArcGIS. Record the evidence in the publication note.</p><form id="observation-form"><div class="form-grid"><label>Geography<select id="observation-geo">${opts(
      adminDraft.geographies.filter((g) => Object.hasOwn(d.layers, g.id)),
      "County",
    )}</select></label><label>Geographic ID<input id="observation-geoid" placeholder="13121" required></label><label class="wide">Indicator<select id="observation-field">${d.fields.map((f) => `<option value="${esc(f.name)}">${esc(f.alias)}</option>`).join("")}</select></label><label>Corrected value<input id="observation-value" type="number" step="any"></label><label class="inline"><input id="observation-null" type="checkbox">Mark missing</label></div><button class="primary">Save correction to draft</button></form>`,
  );
  bind("#observation-form", "submit", (e) => {
    e.preventDefault();
    const geo = $("#observation-geo").value,
      gid = $("#observation-geoid").value.trim(),
      field = $("#observation-field").value;
    d.overrides ??= {};
    d.overrides[geo] ??= {};
    d.overrides[geo][gid] ??= {};
    d.overrides[geo][gid][field] = $("#observation-null").checked
      ? null
      : Number($("#observation-value").value);
    rememberDraft();
    $("#dialog").close();
    toast("Observation correction saved to draft.");
  });
}
function staffImport(kind) {
  dialog(
    kind === "table" ? "Import a staff dataset" : "Import a geography",
    `<p>Read a file, inspect its columns and choose the geographic key before adding it to the draft. Publication remains a separate action.</p><label>File<input id="staff-file" type="file" accept=".csv,.xlsx,.geojson,.json,.zip,.kml,.kmz,.gpkg,.parquet,.geoparquet"></label><div id="staff-file-preview"></div>`,
  );
  bind("#staff-file", "change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    async function read(layer) {
      try {
        const form = new FormData();
        form.append("file", file);
        if (layer) form.append("layer", layer);
        $("#staff-file-preview").innerHTML =
          '<p class="note">Reading file…</p>';
        const r = await api("/api/import", { method: "POST", body: form });
        if (r.choose_layer) {
          $("#staff-file-preview").innerHTML =
            `<label>Layer<select id="staff-layer">${r.layers.map((x) => `<option>${esc(x)}</option>`).join("")}</select></label><button id="staff-read-layer">Read layer</button>`;
          bind("#staff-read-layer", "click", () =>
            read($("#staff-layer").value),
          );
          return;
        }
        if (kind === "geography" && !r.geojson)
          throw Error("A geography needs spatial geometry.");
        $("#staff-file-preview").innerHTML =
          `<p class="note">${r.count} records validated. ${r.geojson ? "Spatial geometry available." : ""}</p><form id="staff-import-form"><div class="form-grid"><label>Title<input id="staff-import-title" required></label><label>Geographic ID column<select id="staff-key">${r.columns.map((x) => `<option ${x.toLowerCase() === "geoid" ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></label>${kind === "table" ? `<label>Join to geography<select id="staff-geography">${opts(adminDraft.geographies, "County")}</select></label>` : `<label>Display name column<select id="staff-name">${r.columns.map((x) => `<option ${/^(name|label)$/i.test(x) ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></label>`}<label>Year<input id="staff-year" type="number" value="2026" required></label><label class="wide">Source URL<input id="staff-source" type="url" required></label></div><p class="small">Numeric fields are detected from the supplied records. All values remain reviewable in the downloaded catalog.</p><button class="primary">Add validated data to draft</button></form>`;
        bind("#staff-import-form", "submit", (e) => {
          e.preventDefault();
          try {
            const title = $("#staff-import-title").value,
              id = title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, ""),
              key = $("#staff-key").value,
              url = $("#staff-source").value,
              year = Number($("#staff-year").value);
            if (!id) throw Error("Enter a title.");
            const keys = r.rows.map((x) => String(x[key] ?? ""));
            if (keys.some((x) => !x) || new Set(keys).size !== keys.length)
              throw Error("Geographic IDs must be non-empty and unique.");
            if (kind === "geography") {
              if (adminDraft.geographies.some((g) => g.id === id))
                throw Error("A geography with this title already exists.");
              for (const f of r.geojson.features) {
                f.properties.GEOID = String(f.properties[key]);
                f.properties.Name = String(
                  f.properties[$("#staff-name").value],
                );
              }
              adminDraft.geographies.push({
                id,
                label: title,
                source: url,
                geokey: "GEOID",
                crs: r.crs || 4326,
                features: r.geojson.features,
              });
            } else {
              const geo = $("#staff-geography").value;
              let cols = r.columns.filter(
                (c) =>
                  c !== key &&
                  /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(c) &&
                  r.rows.some((x) => number(x[c]) !== null),
              );
              if (!cols.length)
                throw Error(
                  "No numeric fields with GIS-compatible names found.",
                );
              const dataset = {
                id,
                title,
                source: title,
                item_url: url,
                url,
                year,
                period: String(year),
                license: "Supplied by staff",
                description: "Imported file: " + file.name,
                geokey: "GEOID",
                layers: { [geo]: 0 },
                fields: cols.map((c) => ({
                  name: c,
                  alias: c,
                  unit: "number",
                  moe: false,
                })),
                records: {
                  [geo]: r.rows.map((row) => ({
                    GEOID: String(row[key]),
                    ...Object.fromEntries(cols.map((c) => [c, number(row[c])])),
                  })),
                },
              };
              const existing = adminDraft.datasets.findIndex(
                (d) => d.id === id,
              );
              if (existing >= 0) adminDraft.datasets[existing] = dataset;
              else adminDraft.datasets.push(dataset);
              adminDataset = id;
            }
            rememberDraft();
            $("#dialog").close();
            renderAdmin();
            toast("Validated data added to draft.");
          } catch (e) {
            toast(e.message);
          }
        });
      } catch (e) {
        $("#staff-file-preview").innerHTML =
          '<p class="error">' + esc(e.message) + "</p>";
      }
    }
    await read();
  });
}
function renderGeographies() {
  $("#admin-content").innerHTML =
    `<section class="panel"><div class="panel-head" style="padding:0"><div><h2>Geographic layers</h2><p>Geographic IDs join data across source tables. New spatial layers can be added without changing application code.</p></div><button id="add-geography">Import geography</button></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>ID</th><th>Source</th><th>Action</th></tr></thead><tbody>${adminDraft.geographies.map((g) => `<tr><td><input data-geo-label="${esc(g.id)}" aria-label="Name for ${esc(g.id)}" value="${esc(g.label)}"></td><td>${esc(g.id)}</td><td>${g.features ? "Uploaded: " + g.features.length + " features" : `<a href="${esc(safeLink(g.url))}" target="_blank" rel="noopener">ArcGIS service</a>`}</td><td><button data-geo-remove="${esc(g.id)}">Remove</button></td></tr>`).join("")}</tbody></table></div><button id="save-geography" style="margin-top:15px">Save names to draft</button></section>`;
  bind("#add-geography", "click", () => staffImport("geography"));
  bind("#save-geography", "click", () => {
    $$("[data-geo-label]").forEach(
      (el) =>
        (adminDraft.geographies.find(
          (g) => g.id === el.dataset.geoLabel,
        ).label = el.value),
    );
    rememberDraft();
    toast("Names saved.");
  });
  $$("[data-geo-remove]").forEach(
    (b) =>
      (b.onclick = () => {
        const id=b.dataset.geoRemove;
        if(Object.values(adminDraft.dashboards).some(c=>c.geography===id))
          return toast("Choose another default geography in Dashboards first.");
        const affected=adminDraft.datasets.filter(d=>Object.hasOwn(d.layers,id));
        if(affected.some(d=>Object.keys(d.layers).length===1))
          return toast("A dataset uses only this geography. Remove that dataset from the draft first.");
        dialog("Remove geography from draft",`<p>This removes the geography and its connections from ${affected.length} datasets in this draft. The published edition remains available.</p><button id="confirm-geography-remove" class="danger">Remove geography from draft</button>`);
        bind("#confirm-geography-remove","click",()=>{
          for(const d of affected){delete d.layers[id];if(d.records)delete d.records[id];if(d.overrides)delete d.overrides[id];}
          adminDraft.geographies=adminDraft.geographies.filter(g=>g.id!==id);
          rememberDraft();$("#dialog").close();renderGeographies();
        });
      }),
  );
}
function renderDashboardConfig() {
  $("#admin-content").innerHTML = `<div class="doc-grid">${Object.entries(
    adminDraft.dashboards,
  )
    .map(
      ([key, c]) =>
        `<form class="panel dashboard-config" data-page="${key}"><h2>${key === "explorer" ? "Data explorer" : key === "housing" ? "Housing" : "Economic mobility"}</h2><div class="form-grid"><label class="wide">Title<input name="title" value="${esc(c.title)}" required></label><label>Default geography<select name="geography">${opts(adminDraft.geographies, c.geography)}</select></label><label>Color ramp<select name="ramp">${["teal", "purple", "blue"].map((v) => `<option ${v === c.ramp ? "selected" : ""}>${v}</option>`).join("")}</select></label><label>Classification<select name="binning">${["quantile", "equal", "stddev"].map((v) => `<option ${v === c.binning ? "selected" : ""}>${v}</option>`).join("")}</select></label><label class="wide">Default indicators, one dataset.field per line<textarea name="indicators">${esc(c.indicators.join("\n"))}</textarea></label></div><details><summary>Choose another indicator</summary><label>Search fields<input type="search" data-config-search="${key}"></label><div class="field-list" id="config-fields-${key}"></div></details><button class="primary" style="margin-top:18px">Save configuration</button></form>`,
    )
    .join("")}</div>`;
  $$(".dashboard-config").forEach((form) => {
    form.onsubmit = (e) => {
      e.preventDefault();
      try {
        let fd = new FormData(form),
          cfg = Object.fromEntries(fd),
          indicators = cfg.indicators
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
        if (!indicators.length || indicators.length > 20)
          throw Error("Choose 1–20 default indicators.");
        for (let k of indicators) {
          const [did, f] = k.split("."),
            d = adminDraft.datasets.find((d) => d.id === did);
          if (
            !d?.fields.some((x) => x.name === f) ||
            !Object.hasOwn(d.layers, cfg.geography)
          )
            throw Error("Unavailable indicator: " + k);
        }
        cfg.indicators = indicators;
        adminDraft.dashboards[form.dataset.page] = cfg;
        rememberDraft();
        toast("Dashboard configuration saved.");
      } catch (e) {
        toast(e.message);
      }
    };
  });
  $$("[data-config-search]").forEach(
    (input) =>
      (input.oninput = () => {
        const q = input.value.toLowerCase(),
          key = input.dataset.configSearch;
        const list = adminDraft.datasets
          .flatMap((d) =>
            d.fields
              .filter(
                (f) =>
                  !f.moe && (f.alias + " " + d.title).toLowerCase().includes(q),
              )
              .map((f) => ({ id: d.id + "." + f.name, label: f.alias })),
          )
          .slice(0, 25);
        $("#config-fields-" + key).innerHTML = list
          .map(
            (f) =>
              `<button type="button" data-config-add="${esc(f.id)}" data-for="${key}" style="display:block;width:100%;text-align:left;font-size:12px">${esc(f.label)}</button>`,
          )
          .join("");
        $$("[data-config-add]").forEach(
          (b) =>
            (b.onclick = () => {
              let t = $(`form[data-page="${b.dataset.for}"] textarea`);
              t.value += "\n" + b.dataset.configAdd;
            }),
        );
      }),
  );
}
function renderGoalConfig() {
  $("#admin-content").innerHTML =
    `<section class="panel"><h2>Goals and milestone tracking</h2><p>Record a sourced baseline, current observation and target. Leave unknown values blank. Completion is a recorded status, independent of the target date.</p><div class="actions"><button id="add-goal" class="primary">Add goal or milestone</button></div><div id="goals-list">${adminDraft.goals.map((g, i) => `<div class="goal"><div class="goal-head"><h3>${esc(g.title)}</h3><button data-edit-goal="${i}">Edit</button></div><p>${esc(g.page)} · ${esc(g.status)} · ${esc(g.date || "No observation date")}</p><p>Baseline: ${esc(fmt(g.baseline))} · Current: ${esc(fmt(g.current))} · Target: ${esc(fmt(g.target))} ${esc(g.unit)}</p><p><a href="${esc(safeLink(g.source))}">Evidence source</a></p></div>`).join("") || '<p class="empty">No staff-added goals yet. Published housing production is calculated from Census estimates.</p>'}</div></section>`;
  bind("#add-goal", "click", () => goalDialog());
  $$("[data-edit-goal]").forEach(
    (b) => (b.onclick = () => goalDialog(Number(b.dataset.editGoal))),
  );
}
function goalDialog(index) {
  const g =
    index === undefined
      ? {
          page: "housing",
          title: "",
          baseline: null,
          current: null,
          target: null,
          unit: "homes",
          date: "",
          due: "",
          status: "Not reported",
          source: "",
          note: "",
        }
      : adminDraft.goals[index];
  dialog(
    "Goal or milestone",
    `<form id="goal-form"><div class="form-grid"><label>Application<select name="page">${["housing", "mobility", "explorer"].map((p) => `<option ${p === g.page ? "selected" : ""}>${p}</option>`).join("")}</select></label><label>Status<select name="status">${["Not reported", "In progress", "Completed", "On hold"].map((s) => `<option ${s === g.status ? "selected" : ""}>${s}</option>`).join("")}</select></label><label class="wide">Title<input name="title" value="${esc(g.title)}" required></label>${["baseline", "current", "target"].map((k) => `<label>${k[0].toUpperCase() + k.slice(1)}<input name="${k}" type="number" step="any" value="${g[k] ?? ""}"></label>`).join("")}<label>Unit<input name="unit" value="${esc(g.unit)}"></label><label>Observation / completion date<input name="date" type="date" value="${esc(g.date)}"></label><label>Target date<input name="due" type="date" value="${esc(g.due || "")}"></label><label class="wide">Evidence URL<input name="source" type="url" value="${esc(g.source)}" required></label><label class="wide">Notes<textarea name="note">${esc(g.note || "")}</textarea></label></div><div class="actions"><button class="primary">Save to draft</button>${index !== undefined ? '<button type="button" id="delete-goal" class="danger">Remove from draft</button>' : ""}</div></form>`,
  );
  bind("#goal-form", "submit", (e) => {
    e.preventDefault();
    const o = Object.fromEntries(new FormData(e.target));
    for (let k of ["baseline", "current", "target"])
      o[k] = o[k] === "" ? null : Number(o[k]);
    if (o.status === "Completed" && !o.date)
      return toast("Record a completion date.");
    if (index === undefined) adminDraft.goals.push(o);
    else adminDraft.goals[index] = o;
    rememberDraft();
    $("#dialog").close();
    renderGoalConfig();
    toast("Goal saved to draft.");
  });
  bind("#delete-goal", "click", () => {
    adminDraft.goals.splice(index, 1);
    rememberDraft();
    $("#dialog").close();
    renderGoalConfig();
  });
}
async function renderHistory() {
  if (!adminAuth.signed_in) {
    $("#admin-content").innerHTML =
      '<section class="panel"><h2>Publication history</h2><p>Sign in to view staff audit records and prior editions. Practice changes are kept separately in this tab.</p></section>';
    return;
  }
  try {
    const r = await api("/api/history");
    $("#admin-content").innerHTML =
      `<section class="panel"><h2>Published editions</h2><div class="table-wrap"><table><thead><tr><th>Edition</th><th>Published</th><th>Note</th><th>Action</th></tr></thead><tbody>${r.editions.map((x) => `<tr><td>${x.id}</td><td>${esc(new Date(x.created * 1000).toLocaleString())}</td><td>${esc(x.note)}</td><td>${adminAuth.role === "publisher" ? `<button data-restore="${x.id}">Restore as new edition</button>` : ""}</td></tr>`).join("")}</tbody></table></div><h2 style="margin-top:30px">Audit log</h2><div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead><tbody>${r.audit.map((x) => `<tr><td>${esc(new Date(x.created * 1000).toLocaleString())}</td><td>${esc(x.actor)}</td><td>${esc(x.action)}</td><td>${esc(x.detail)}</td></tr>`).join("")}</tbody></table></div></section>`;
    $$("[data-restore]").forEach(
      (b) =>
        (b.onclick = () => {
          dialog(
            "Restore edition " + b.dataset.restore,
            `<p>This will publish the selected catalog as a new edition. Existing history remains available.</p><button id="confirm-restore" class="primary">Publish restored edition</button>`,
          );
          bind("#confirm-restore", "click", async () => {
            try {
              let n = await post(
                "/api/restore",
                { edition: Number(b.dataset.restore), revision: adminBase },
                adminAuth.csrf,
              );
              adminBase = n.revision;
              const e = await api("/api/catalog");
              adminDraft = e.catalog;
              rememberDraft();
              $("#dialog").close();
              renderAdmin();
            } catch (e) {
              toast(e.message);
            }
          });
        }),
    );
  } catch (e) {
    toast(e.message);
  }
}
function publishDialog() {
  dialog(
    "Publish catalog edition",
    `<p>The draft contains ${adminDraft.datasets.length} datasets, ${adminDraft.geographies.length} geographies and ${adminDraft.goals.length} staff-added goals. Publication changes the public applications.</p><label>Publication note<textarea id="publish-note" required placeholder="Describe the data release, corrections and evidence reviewed."></textarea></label><button id="confirm-publish" class="primary" style="margin-top:18px">Publish edition</button><p id="publish-result" role="status"></p>`,
  );
  bind("#confirm-publish", "click", async () => {
    try {
      const note = $("#publish-note").value.trim();
      if (!note) throw Error("Add a publication note.");
      let r = await post(
        "/api/publish",
        { revision: adminBase, catalog: adminDraft, note },
        adminAuth.csrf,
      );
      adminBase = r.revision;
      rememberDraft();
      $("#dialog").close();
      renderAdmin();
      toast("Published edition " + r.revision + ".");
    } catch (e) {
      $("#publish-result").textContent = e.message;
    }
  });
}
