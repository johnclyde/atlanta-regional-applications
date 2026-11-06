"""Transient GIS/table conversion and portable joined-data exports."""

import csv
import io
import json
import re
import tempfile
import zipfile
from pathlib import Path

import geopandas as gpd
import pandas as pd
import pyarrow as pa
import pyogrio
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill

MAX_BYTES = 25 * 1024 * 1024
MAX_ROWS = 15000


def plain(v):
    if pd.isna(v):
        return None
    if isinstance(v, str | bool | int | float):
        return v
    return str(v)


def safe_zip(raw, root):
    z = zipfile.ZipFile(io.BytesIO(raw))
    files = z.infolist()
    if len(files) > 1000 or sum(x.file_size for x in files) > 150 * 1024 * 1024:
        raise ValueError("Archive expands beyond the supported limit.")
    for x in files:
        p = Path(x.filename)
        if (
            p.is_absolute()
            or ".." in p.parts
            or x.flag_bits & 1
            or (x.external_attr >> 16) & 0o170000 == 0o120000
        ):
            raise ValueError("Unsafe archive entry.")
        if x.compress_size and x.file_size / x.compress_size > 500:
            raise ValueError("Archive compression ratio is too high.")
        target = root / p
        if x.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(z.read(x))
    return [root / Path(x.filename) for x in files if not x.is_dir()]


def convert(name, raw, layer=None):
    if not raw or len(raw) > MAX_BYTES:
        raise ValueError("Choose a file of at most 25 MB.")
    suffix = Path(name).suffix.lower()
    with tempfile.TemporaryDirectory(prefix="arc-import-") as td:
        root = Path(td)
        p = root / ("upload" + suffix)
        p.write_bytes(raw)
        if suffix == ".csv":
            df = pd.read_csv(p, dtype=str, keep_default_na=False, nrows=MAX_ROWS + 1)
        elif suffix == ".xlsx":
            with zipfile.ZipFile(p) as z:
                if sum(x.file_size for x in z.infolist()) > 100 * 1024 * 1024:
                    raise ValueError("Workbook is too large when expanded.")
            w = load_workbook(p, read_only=True, data_only=False)
            sheet = w[layer] if layer and layer in w.sheetnames else w.active
            values = []
            for row in sheet.iter_rows():
                if any(c.data_type == "f" for c in row):
                    raise ValueError(
                        "Save spreadsheet formulas as values before importing."
                    )
                values.append([c.value for c in row])
                if len(values) > MAX_ROWS + 1:
                    raise ValueError("Import exceeds 15,000 rows.")
            if len(values) < 2:
                raise ValueError("The workbook needs a header and data rows.")
            if len(set(values[0])) != len(values[0]) or any(
                v is None for v in values[0]
            ):
                raise ValueError("Column headings must be present and unique.")
            df = pd.DataFrame(values[1:], columns=[str(v) for v in values[0]])
        else:
            allowed = {
                ".geojson",
                ".json",
                ".gpkg",
                ".kml",
                ".kmz",
                ".zip",
                ".parquet",
                ".geoparquet",
            }
            if suffix not in allowed:
                raise ValueError(
                    "Supported formats: CSV, XLSX, GeoJSON, zipped Shapefile/GDB, KML/KMZ, GeoPackage and GeoParquet."
                )
            if suffix in {".zip", ".kmz"}:
                files = safe_zip(raw, root / "expanded")
                gdbs = list((root / "expanded").rglob("*.gdb"))
                choices = gdbs or [
                    x
                    for x in files
                    if x.suffix.lower() in {".shp", ".kml", ".gpkg", ".geojson"}
                ]
                if not choices:
                    raise ValueError("Archive contains no supported spatial dataset.")
                if len(choices) > 1 and not layer:
                    raise ValueError(
                        "Archive has multiple datasets; provide one dataset per archive."
                    )
                p = choices[0]
            if p.suffix.lower() == ".kml":
                text = p.read_text(errors="replace")
                if re.search(
                    r"<!DOCTYPE|<!ENTITY|<NetworkLink|<href|<styleUrl>\s*(?!#)",
                    text,
                    re.I,
                ):
                    raise ValueError(
                        "KML must contain local geometries without external links or entities."
                    )
            if p.suffix.lower() in {".json", ".geojson"}:
                data = json.loads(p.read_bytes())
                if data.get("type") != "FeatureCollection" or not isinstance(
                    data.get("features"), list
                ):
                    raise ValueError("Use a GeoJSON FeatureCollection.")
                if len(data["features"]) > MAX_ROWS:
                    raise ValueError("Too many features.")
            if (
                p.suffix.lower() == ".gpkg"
                and p.read_bytes()[:16] != b"SQLite format 3\x00"
            ):
                raise ValueError("Not a GeoPackage file.")
            if p.suffix.lower() == ".shp" and p.read_bytes()[:4] != b"\x00\x00\x27\x0a":
                raise ValueError("Not a Shapefile.")
            if p.suffix.lower() in {".parquet", ".geoparquet"}:
                df = gpd.read_parquet(p)
            else:
                layers = pyogrio.list_layers(p)
                if layer is None and len(layers) > 1:
                    return {"layers": [str(x[0]) for x in layers], "choose_layer": True}
                chosen = layer or str(layers[0][0])
                if chosen not in [str(x[0]) for x in layers]:
                    raise ValueError("Layer not found.")
                info = pyogrio.read_info(p, layer=chosen)
                if info["driver"] not in {
                    "GeoJSON",
                    "GPKG",
                    "OpenFileGDB",
                    "ESRI Shapefile",
                    "KML",
                    "LIBKML",
                }:
                    raise ValueError("Unsupported spatial driver.")
                df = pyogrio.read_dataframe(p, layer=chosen, max_features=MAX_ROWS + 1)
            if not isinstance(df, gpd.GeoDataFrame) or df.crs is None:
                raise ValueError(
                    "Spatial data must declare its coordinate reference system."
                )
        if len(df) > MAX_ROWS or len(df.columns) > 300:
            raise ValueError("Imports support up to 15,000 rows and 300 columns.")
        if df.columns.duplicated().any():
            raise ValueError("Column headings must be unique.")
        spatial = isinstance(df, gpd.GeoDataFrame)
        crs = df.crs.to_epsg() if spatial else None
        if spatial:
            if (~df.geometry.is_valid & ~df.geometry.isna()).any():
                raise ValueError(
                    "The file contains invalid geometry; repair it before import."
                )
            geo = json.loads(df.to_crs(4326).to_json(drop_id=True, na="null"))
            table = pd.DataFrame(df.drop(columns=df.geometry.name))
        else:
            geo = None
            table = df
        # Only fully numeric columns are coerced. Preserve keys and leading zeroes.
        records = [
            {str(k): plain(v) for k, v in row.items()}
            for row in table.to_dict("records")
        ]
        return {
            "name": Path(name).name,
            "columns": [str(c) for c in table.columns],
            "rows": records,
            "geojson": geo,
            "crs": crs,
            "count": len(records),
            "transient": True,
        }


def safe_cell(value):
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def export_table(rows, fields, kind):
    columns = ["GEOID", "Name"] + [f["name"] for f in fields]
    if kind == "csv":
        out = io.StringIO(newline="")
        w = csv.writer(out)
        w.writerow(columns)
        for r in rows:
            w.writerow([safe_cell(r.get(c, "")) for c in columns])
        return out.getvalue().encode("utf-8-sig"), "text/csv", "data.csv"
    wb = Workbook()
    ws = wb.active
    ws.title = "Data"
    ws.append(columns)
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = f"A1:{ws.cell(1, len(columns)).column_letter}{len(rows) + 1}"
    for r in rows:
        ws.append([r.get(c) for c in columns])
        for cell in ws[ws.max_row]:
            if isinstance(cell.value, str):
                cell.data_type = "s"
    meta = wb.create_sheet("Indicators")
    meta.append(["Field", "Label", "Source", "Period", "Source URL"])
    for f in fields:
        meta.append(
            [
                f["name"],
                f["alias"],
                f.get("source", "User supplied"),
                f.get("period", ""),
                f.get("url", ""),
            ]
        )
    for sh in wb:
        for row in sh:
            for cell in row:
                if isinstance(cell.value, str):
                    cell.data_type = "s"
        sh.row_dimensions[1].height = 24
        for cell in sh[1]:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="163F45")
        for col in sh.columns:
            sh.column_dimensions[col[0].column_letter].width = min(
                55, max(16, max(len(str(c.value or "")) for c in list(col)[:100]) + 2)
            )
    out = io.BytesIO()
    wb.save(out)
    return (
        out.getvalue(),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "data.xlsx",
    )


def export_geo(fc, fields, kind, crs=4326):
    if not fc["features"]:
        raise ValueError("No selected geography to export.")
    if kind == "geojson":
        return (
            json.dumps(fc, allow_nan=False).encode(),
            "application/geo+json",
            "data.geojson",
        )
    df = gpd.GeoDataFrame.from_features(fc["features"], crs=4326).to_crs(crs)
    with tempfile.TemporaryDirectory(prefix="arc-export-") as td:
        root = Path(td)
        if kind == "parquet":
            path = root / "data.parquet"
            df.to_parquet(path)
            return path.read_bytes(), "application/octet-stream", path.name
        if kind == "gpkg":
            path = root / "data.gpkg"
            pyogrio.write_dataframe(df, path, driver="GPKG", layer="RegionalData")
            return path.read_bytes(), "application/geopackage+sqlite3", path.name
        if kind != "gdb":
            raise ValueError("Unknown geographic export format.")
        path = root / "data.gdb"
        attrs = pd.DataFrame(df.drop(columns=df.geometry.name))
        table = pa.Table.from_pandas(attrs, preserve_index=False)
        for column in attrs.select_dtypes(include=["int64", "uint64"]):
            if (attrs[column].abs() > 2**53).any():
                raise ValueError(
                    "A whole number exceeds exact Esri v10 numeric precision. Use GeoParquet to preserve this value."
                )
        aliases = {f["name"]: f["alias"] for f in fields}
        schema = pa.schema(
            [
                f.with_metadata(
                    {b"GDAL:OGR:alternative_name": aliases.get(f.name, f.name).encode()}
                )
                for f in table.schema
            ]
        )
        table = table.cast(schema).append_column(
            "geometry", pa.array(df.geometry.to_wkb(), type=pa.binary())
        )
        types = set(df.geometry.geom_type.dropna())
        geom_type = (
            "MultiPolygon"
            if types <= {"Polygon", "MultiPolygon"}
            else (
                "MultiLineString"
                if types <= {"LineString", "MultiLineString"}
                else "Point"
                if types == {"Point"}
                else "Unknown"
            )
        )
        pyogrio.write_arrow(
            table,
            path,
            driver="OpenFileGDB",
            layer="RegionalData",
            geometry_name="geometry",
            geometry_type=geom_type,
            crs=df.crs.to_wkt(),
            layer_options={"TARGET_ARCGIS_VERSION": "ALL"},
        )
        (root / "fields.json").write_text(
            json.dumps({"crs": df.crs.to_string(), "fields": fields}, indent=2)
        )
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for f in root.rglob("*"):
                if f.is_file():
                    z.write(f, str(f.relative_to(root)))
        return out.getvalue(), "application/zip", "data.gdb.zip"
