# Atlanta regional applications

Three working mapping and data applications prepared by John Clyde in response to the Atlanta Regional Commission's RFP828.

- [Georgia data explorer](https://arc.clydellmfactory.com/explorer): 1,611 searchable indicators across 41 public ARC services and 23 geography types.
- [Regional housing](https://arc.clydellmfactory.com/housing): housing conditions, county/city comparisons, Census housing production since 2020 and sourced goal tracking.
- [Economic mobility](https://arc.clydellmfactory.com/mobility): published income, poverty, education, employment and broadband conditions, with configurable measures and goals.
- [Staff workspace](https://arc.clydellmfactory.com/admin): practice dataset imports, metadata edits, geographic layers, dashboard configuration, corrections and milestone tracking. Authorized editors save drafts; publishers release or restore audited editions.
- [Delivery and timeline](https://arc.clydellmfactory.com/delivery).

This is an independent demonstration, not an official ARC service or awarded contract. ARC's final mobility definitions, adopted housing goals, branding and Microsoft tenant configuration remain client inputs. The 367,000-home regional proposal is labeled as proposed pending the scheduled November 12, 2026 Board action.

## Run locally

Use Python 3.12 with the uv lockfile (uv 0.13.7 or later), or Docker Compose:

```sh
uv sync --locked
uv run python site/server.py
```

Open http://127.0.0.1:8788. Staff practice works without credentials. Public users cannot publish. The local server binds to loopback, uses `site/state` for SQLite and public-source cache, and disables staff sign-in unless explicitly configured.

```sh
docker compose up --build
```

The container runs without root privileges. The compose file binds only to loopback, keeps runtime state in a named volume, and makes application code read-only. Set the exact `ARC_ORIGIN` for deployment behind HTTPS.

## Working features

Map, sortable table, bar chart, scatterplot and histogram share the same geographic selections and value filters. Geographic IDs join indicators across source tables. County medians are shown as ranges, not averaged into an invented regional median. Missing and suppressed observations remain missing.

Users can import CSV, XLSX, GeoJSON, zipped Shapefile or File Geodatabase, KML/KMZ, GeoPackage and GeoParquet. The downloadable sample spreadsheet contains actual geographic IDs and can be imported unchanged or edited. Upload conversion uses temporary files deleted after the request; public imports never modify shared data. Private data stay in the tab until the user explicitly saves a session file.

Exports include CSV, XLSX with indicator metadata, GeoJSON, GeoPackage, GeoParquet and joined File Geodatabase. GDB exports use Esri v10-compatible storage, source CRS and native aliases; integers beyond exact v10 numeric precision are rejected with a GeoParquet alternative. Map exports include PNG, JPG, SVG and PDF, current extent, classification, legend and source credit. Basemap tiles are omitted from export graphics.

Session files preserve application, geography, indicators, map extent, classification, filters, selections, comparison mode, sort and any imported data. Treat exported sessions as private when they contain private data.

## Data and implementation

The catalog reads ARC's public ACS 2020-2024 services; some services also supply 2010 comparison fields, labeled by their original aliases. Geometry is generalized for display; geographic downloads request detailed boundaries and transform back to the source CRS. Housing production uses Census Vintage 2025 housing-unit estimates, April 2020 base to July estimates. Permits and verified affordable production are different measures and are not inferred from ACS.

[Guide and source links](https://arc.clydellmfactory.com/guide) · [ARC ACS manifest](https://opendata.atlantaregional.com/documents/e7c6f916c90949f0a5f972524d1544d2/about) · [Census housing estimates](https://www.census.gov/data/datasets/time-series/demo/popest/2020s-total-housing-units.html)

The server uses Starlette, SQLite, Authlib and a bounded ArcGIS adapter. GeoPandas, GDAL/pyogrio and PyArrow handle spatial conversion. Leaflet is bundled locally. No viewer licenses, browser API keys, external AI calls or third-party analytics are required. Street and imagery tiles are requested from their credited providers.

Limits: 40 simultaneous indicators, 15,000 features per layer, 25 MB uploaded files, 150 MB expanded archives, 300 imported columns. Source reads are cached for 24 hours, with visibly labeled stale fallback when a provider is unavailable. A small attributed public-source cache is bundled for reliable first use; no staff drafts, visitor records or uploaded files are bundled.

## Administration and operation

See [OPERATIONS.md](OPERATIONS.md) for Entra setup, publication, data refresh, backup, recovery and hosting. See [VERIFICATION.md](VERIFICATION.md) for the checks actually completed and their limits. The independent demonstration is not an ARC security accreditation, FedRAMP authorization or accessibility certification.

```sh
uv run python tests/test_application.py
node tests/test_core.cjs
```

Local verification is recorded in [VERIFICATION.md](VERIFICATION.md). The repository includes a manually triggered CI workflow. GitHub Issues are disabled; work is coordinated in the owner's private records.

## John Clyde / VentiMath

John's engineering experience includes Google, Facebook, Lyft, D. E. Shaw and Mozart Data. Paid engineering work supports [VentiMath](https://ventimath.org). Other public projects: [Aquidneck](https://github.com/johnclyde/aquidneck) and [KZFR](https://github.com/johnclyde/kzfr).

AI tools assisted research, implementation, tests and documentation. The proposer remains responsible for delivery and client-specific acceptance. Source visibility enables inspection; it is not a claim of client adoption.

Copyright and permitted evaluation use are described in [LICENSE](LICENSE). Third-party software and data retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This repository excludes procurement forms, private proposal material, credentials and runtime state.
