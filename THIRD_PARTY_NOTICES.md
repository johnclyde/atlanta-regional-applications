# Third-party notices

The custom application is copyright 2026 John Clyde; see LICENSE. Dependency licenses are not replaced by that notice.

- **Leaflet 1.9.4**, copyright Vladimir Agafonkin and contributors: BSD-2-Clause, bundled with its complete notice at `site/static/vendor/leaflet/LICENSE.txt`. https://leafletjs.com
- **ARC public ACS services and geographic data:** U.S. Census Bureau / Atlanta Regional Commission. The service catalog retains source URLs, descriptions, credits, field aliases and reported license text. ARC's published source records specify Creative Commons Attribution 4.0. https://opendata.atlantaregional.com / https://creativecommons.org/licenses/by/4.0/
- **Housing-unit estimates:** U.S. Census Bureau, Vintage 2025 county housing-unit estimates, Georgia. https://www2.census.gov/programs-surveys/popest/tables/2020-2025/housing/totals/CO-EST2025-HU-13.xlsx
- **Street tiles:** © OpenStreetMap contributors. https://www.openstreetmap.org/copyright
- **Imagery tiles:** Esri, Maxar and Earthstar Geographics, credited on the map. https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer

Python packages are installed from PyPI at the versions and hashes in `uv.lock` (`requirements.txt` is a generated interoperability export); their distributions retain their own license files. Principal packages are Starlette (BSD), Uvicorn (BSD), Authlib (BSD), GeoPandas (BSD), pandas (BSD), NumPy (BSD), pyogrio (MIT), GDAL (MIT/X-style and component notices), Shapely (BSD), pyproj/PROJ (MIT and component notices), PyArrow/Apache Arrow (Apache-2.0), openpyxl (MIT), Pillow (HPND and component notices), and ReportLab (BSD). Consult the installed distributions for exact notices and transitive components; this summary is not a replacement for them.

The public source cache contains only responses from the credited public data providers. It excludes uploads, staff identity, drafts, passwords, application sessions, private records and request history. The demo is not endorsed by ARC, the Census Bureau, the tile providers or John's former employers.
