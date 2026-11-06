# Operations

## Environment and service

Python 3.12 is the supported runtime. `pyproject.toml` declares dependencies and `uv.lock` pins the tested packages and hashes. Use `uv sync --locked`; Ruff formats and lints the Python source, and ty checks its types. The Docker image contains Linux GIS wheels and avoids a system GDAL installation. Run one process with a persistent writable `ARC_STATE` directory; SQLite editions, drafts, sessions, audit records and public cache live there. Multiple application replicas require a shared data-service design and are not represented as tested by this demo.

| Setting | Purpose |
| --- | --- |
| `ARC_ORIGIN` | Exact public HTTPS origin; protects mutations and transient conversions against cross-origin requests. |
| `ARC_STATE` | Persistent writable state directory; default `site/state`, container `/state`. |
| `ARC_BIND`, `PORT` | Listen address/port; defaults loopback/8788, container 0.0.0.0/8788 behind loopback host binding. |
| `ARC_OWNER_HASH` | Optional scrypt owner-password hash. Disabled when Entra is configured. Keep in a protected secret, never the repository. |
| `ARC_SESSION_SECRET` | Random session signing key, supplied as a secret or generated inside private state. |
| `ARC_ENTRA_TENANT`, `ARC_ENTRA_CLIENT`, `ARC_ENTRA_SECRET` | Client-controlled Microsoft tenant, application ID and credential. |
| `ARC_SOURCE_HOSTS` | Operator-only extra approved ArcGIS hostnames, comma separated. Do not add internal endpoints. |

The public workspace is a practice draft stored in tab session storage. Clearing that browser storage loses practice changes. Download a catalog to retain them. Public practice does not grant publication privileges.

The demonstration runs on an existing Google Cloud US host, isolated from other applications by container, user, persistent directory, loopback port and service. That is not a representation that the owner's account satisfies ARC's production authorization requirements. Production provisioning must use the approved US account, IAM, organizational controls, logs, backup location and access restrictions agreed with ARC. No changes to the public demo constitute ARC acceptance.

## Microsoft Entra ID

1. Register a single-tenant web application in ARC's tenant. Use `https://<approved-host>/auth/callback` as the exact redirect URI.
2. Define user application roles `ARC.Editor` and `ARC.Publisher`. Require assignment, then assign only approved staff or groups.
3. Apply ARC's Conditional Access policy to this enterprise application, including its MFA/device/location requirements. ARC controls that policy.
4. Supply tenant UUID, client ID and secret through the production secret store. Use `openid profile`; the application does not request Graph access or broad tenant permissions.
5. Test staff accounts with each role, an unassigned account, failed Conditional Access and sign-out. The implementation validates provider tokens, tenant ID and assigned roles, then creates hashed, revocable eight-hour application sessions. A disabled tenant account can retain an existing application session until expiry; revoke local sessions for immediate removal. Reauthentication/CAE behavior must be agreed with ARC before acceptance.

Editors save drafts. Publishers publish or restore editions. Every mutation requires an authenticated session, exact origin and CSRF token; publication compares the base edition and rejects stale updates. A restore creates a new edition instead of erasing history. Raw secrets and tokens must not appear in application or proxy access logs.

## Data updates and training exercise

- **Connections:** Datasets > Connect ArcGIS accepts a public FeatureServer layer, source credit, year and geography. Field aliases come from the source. Approved source hosts are enforced on the server.
- **Tables:** Import table reads CSV, XLSX or supported GIS, validates geographic keys and creates numeric indicators. Use GIS-compatible source field names for published datasets. Reimport with the same dataset title to replace its draft records. Review the result before publication.
- **Metadata:** Edit labels, units, period and source links. Refresh field definitions when a provider changes schema; verify dashboard defaults before publication. Data reads refresh after the 24-hour cache window. For an immediate operator refresh, move only the public `cache` directory aside and recreate it with the service user's ownership, or warm the cache in a fresh state directory. Never remove the SQLite database to refresh data.
- **Corrections:** Enter geography, geographic ID, field and an explicit numeric value or missing marker. Overrides are versioned with the catalog; record evidence in the publication note.
- **Geographies:** Import a spatial layer, choose stable geographic IDs and a display-name field. Names can be edited; deleting a geography removes its draft dataset connections after confirmation, with guards for dashboard defaults and datasets that depend on it.
- **Dashboards:** Choose default geography, fields, title, palette and classification. The field picker avoids writing application code. Advanced catalog download/import supports bulk configuration.
- **Goals:** Enter evidence, baseline/current/target when known, status and dates. A completed milestone requires a completion date. Numeric progress is `(current - baseline) / (target - baseline)`; status is independent, and unknown values remain blank. Notes and target dates appear publicly after publication.
- **Review:** Preview the housing application with the draft. Other configured dashboard pages use the same catalog when opened with `?draft=1` in that tab. Save a staff draft, obtain the agreed review, then publish with a meaningful note. Check all three application defaults, joined exports and source labels. Restore from History if necessary.

Training for up to ten staff should cover imports, validation, definitions, correction evidence, publication, rollback and recovery, using staff-controlled examples. Provide the operating guide and a recorded walkthrough when ARC permits recording.

## Backup and recovery

Use SQLite's backup API, not a raw copy of an active WAL database:

```sh
python3 deploy/database.py backup /path/to/regional.sqlite3 /protected/backup/edition-2026-11-05.sqlite3
python3 deploy/database.py check /protected/backup/edition-2026-11-05.sqlite3
```

The guarded demo installer backs up the database before replacing code, builds and initializes the container first, validates a candidate Caddy configuration, and restores prior service/routing on a failed health check. Existing Aquidneck, KZFR and main application health checks are mandatory.

For production, schedule encrypted daily backups in the approved US storage location with agreed retention (proposed 30 daily copies), restrict restore access and rehearse recovery. Recovery: stop the service, preserve the current database and WAL/SHM files as a rollback set, restore an integrity-checked backup with the service user's ownership, remove only the old active WAL/SHM copies from the restored location, start the service and verify the current edition and all three applications. Never publish backup files or credentials in a repository.

## Security and acceptance boundaries

Controls implemented include source-host allowlisting, no redirects, request/file/archive bounds, archive traversal and symlink rejection, temporary conversion, unsafe KML rejection, spreadsheet formula safeguards, parameterized SQLite, non-root read-only container, staff role checks, CSRF, HTTPS-oriented cookies, CSP, revocable sessions and immutable publication history.

Production work includes a NIST SP 800-53 Rev.5 control mapping with ARC, US-only access and backup arrangements, approved FedRAMP service boundary where required, tenant acceptance, dependency scanning, incident contacts, performance targets and accessibility testing with the final content. No completed third-party penetration test, screen-reader certification, disaster-recovery SLA or FedRAMP authorization is claimed. The demo has no per-viewer fees and no user-upload ingestion into shared datasets without explicit staff publication.

Hosting, maintenance and recurring refresh support in the proposed engagement cover January 1 through December 31, 2027. Post-2027 service and any expanded hosting/security boundary require an agreed renewal. The proposal, pricing and procurement forms are maintained privately, outside this repository.
