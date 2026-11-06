/* Pure data operations shared by the three applications. */
(() => {
  "use strict";
  const number = (v) =>
    v === null || v === undefined || v === ""
      ? null
      : Number.isFinite(Number(v))
        ? Number(v)
        : null;
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const fmt = (v, unit = "number") => {
    v = number(v);
    return v === null
      ? "Not available"
      : new Intl.NumberFormat("en-US", {
          maximumFractionDigits: unit === "dollars" ? 0 : 1,
          style: unit === "dollars" ? "currency" : "decimal",
          currency: "USD",
        }).format(v) +
          (unit === "percent" ? "%" : unit === "points" ? " pp" : "");
  };
  function breaks(values, method = "quantile", count = 5) {
    const v = values
      .map(number)
      .filter((x) => x !== null)
      .sort((a, b) => a - b);
    if (!v.length) return [];
    if (v[0] === v.at(-1)) return [v[0]];
    let out = [];
    for (let i = 1; i < count; i++) {
      if (method === "equal") out.push(v[0] + ((v.at(-1) - v[0]) * i) / count);
      else if (method === "stddev") {
        let mean = v.reduce((a, b) => a + b, 0) / v.length,
          sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
        out.push(mean + (i - count / 2) * sd);
      } else {
        let pos = ((v.length - 1) * i) / count,
          lo = Math.floor(pos);
        out.push(v[lo] + (v[Math.ceil(pos)] - v[lo]) * (pos - lo));
      }
    }
    return [...new Set(out.filter((x) => x > v[0] && x < v.at(-1)))];
  }
  const ramps = {
    teal: ["#e3efeb", "#b8d8ce", "#82b9ac", "#468d80", "#175e56", "#103c37"],
    purple: ["#eee8f3", "#d5c2e3", "#b397cc", "#8866ac", "#603c86", "#40235f"],
    blue: ["#e4eef6", "#b8d2e9", "#83b3d3", "#508eb6", "#225e89", "#173d60"],
  };
  function color(v, bs, ramp = "teal") {
    v = number(v);
    if (v === null) return "#d7dbd7";
    let i = bs.filter((b) => v > b).length;
    return ramps[ramp][Math.round((i * 5) / Math.max(1, bs.length))];
  }
  function filterRows(rows, state) {
    return rows.filter(
      (r) =>
        (state.scope !== "region" || r.region) &&
        (!state.search ||
          String(r.Name).toLowerCase().includes(state.search.toLowerCase())) &&
        (state.min === "" ||
          (number(r[state.metric]) !== null &&
            number(r[state.metric]) >= Number(state.min))) &&
        (state.max === "" ||
          (number(r[state.metric]) !== null &&
            number(r[state.metric]) <= Number(state.max))),
    );
  }
  function joinRows(features, values, custom) {
    const byId = new Map(values.map((v) => [String(v.GEOID), v]));
    const own = new Map(
      (custom?.rows || []).map((r) => [String(r[custom.join] ?? ""), r]),
    );
    return features.map((f) => {
      const a = f.properties,
        row = {
          ...byId.get(a.GEOID),
          GEOID: a.GEOID,
          Name: a.label,
          region: a.region,
        };
      const r = own.get(a.GEOID);
      for (const key of custom?.fields || [])
        row["user." + key] = number(r?.[key]);
      return row;
    });
  }
  function validateSession(s) {
    if (
      s?.format !== "clyde-regional-session" ||
      s.version !== 1 ||
      !["explorer", "housing", "mobility"].includes(s.page) ||
      !Array.isArray(s.keys) ||
      s.keys.length > 40 ||
      typeof s.geo !== "string" ||
      !Array.isArray(s.selected) ||
      s.selected.length > 15000
    )
      throw Error("This is not a supported regional-data session.");
    if (
      s.custom &&
      (!Array.isArray(s.custom.rows) || s.custom.rows.length > 15000)
    )
      throw Error("Session contains too many private rows.");
    return s;
  }
  function progress(g) {
    let b = number(g.baseline),
      c = number(g.current),
      t = number(g.target);
    if (b === null || c === null || t === null || b === t) return null;
    return ((c - b) / (t - b)) * 100;
  }
  const api = {
    number,
    esc,
    fmt,
    breaks,
    color,
    ramps,
    filterRows,
    joinRows,
    validateSession,
    progress,
  };
  if (typeof module !== "undefined") module.exports = api;
  else window.Core = api;
})();
