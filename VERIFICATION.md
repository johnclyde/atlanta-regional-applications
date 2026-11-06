# Verification record

Verified November 5, 2026. These results describe the independent demonstration, not ARC's eventual production acceptance.

- **Toolchain:** uv 0.13.7 with a committed lockfile; Ruff 0.17.4 lint/format checks and ty 0.0.98 type checks pass. Black is not a dependency.
- **45 Python tests pass:** GIS/table format round trips; Esri v10 GDB native aliases and source CRS; GeoPackage/GeoParquet; Shapefile/KML/KMZ; formula and archive defenses; source allowlisting; suppressed values; request byte limits; empty selections; custom column labels; publication authentication/roles/CSRF/origin; stale-edition conflicts; restore history; sessions and private imports.
- **18 JavaScript assertions pass:** missing values, formatting, classification, geographic joins, combined filters, target progress and session validation.
- **Browser workflows verified:** Fulton selection changes housing inventory to 534,663 and net additions to 40,707; the corresponding six-year trend changes. A histogram range produces the same three counties in map and table. Scatterplot and table share selections. Municipality views load 67 ARC-region places, including Atlanta. Downloaded sample Excel joins all 11 counties; session export/reopen restores imported data across applications. Staff practice records a completed milestone and previews it without changing the published edition.
- **Downloaded GIS inspected:** browser-produced GDB has 11 counties, EPSG:3857 and the native alias `Median gross rent (dollars), 2024`. Map PNG contains a thematic map, legend and source credit. Maps use detailed geometry for GIS downloads and generalized boundaries for screen drawing.
- **Accessibility:** axe-core 4.10.2 WCAG2A/AA and WCAG2.1A/AA rules report zero automatic violations on seven pages at 1280 and 390 CSS pixels (14 runs). The engine marked color-contrast checks incomplete; they are not counted as a complete pass. Main text/link color pairs were checked separately (ratios 5.57:1 to 11.84:1). Phone overflow was corrected; the 390-pixel housing page has a 390-pixel document width. Keyboard histogram activation, labeled forms, focus indication and table alternatives were inspected. A complete assistive-technology and final-client-content audit remains part of acceptance.

Run the recorded checks:

```sh
uv sync --locked
uv run ruff check
uv run ruff format --check
uv run ty check
uv run python tests/test_application.py
node tests/test_core.cjs
```

The tests use isolated temporary state. They do not alter an operating installation. Source-provider checks and manual browser downloads use the public ARC/Census data; deterministic tests do not depend on those providers being online.

Remaining client acceptance: Entra tenant integration with real assigned/unassigned staff and Conditional Access, approved final indicators and targets, source inventory beyond this demo catalog, negotiated load/availability targets, ARC-specific NIST/FedRAMP control evidence, backup/restore rehearsal in the production account, final branding and accessibility/user acceptance. No external penetration test or production compliance certification is claimed.

GitHub-hosted checks may be unavailable because of account billing; no hosted-CI success is inferred from these local results.

The release also initializes from an empty folder, serves all three county datasets from its bundled public cache with network access disabled, and rejects anonymous publication.
