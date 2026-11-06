import copy
import io
import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
TMP = tempfile.TemporaryDirectory(prefix="arc-tests-")
os.environ["ARC_STATE"] = TMP.name
os.environ["ARC_ORIGIN"] = "http://testserver"
sys.path.insert(0, str(ROOT / "site"))
import formats
import geopandas as gpd
import providers
import pyogrio
import server
import store
from openpyxl import Workbook, load_workbook
from starlette.testclient import TestClient

FC = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"GEOID": "13121", "Name": "Fulton", "value": 75000},
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [[-84.5, 33.6], [-84.3, 33.6], [-84.3, 33.8], [-84.5, 33.6]]
                ],
            },
        }
    ],
}
FIELDS = [
    {
        "name": "value",
        "alias": "Median household income",
        "source": "Test fixture",
        "period": "2024",
        "url": "https://example.org",
    }
]


class Formats(unittest.TestCase):
    def test_csv_keeps_leading_zeroes(self):
        r = formats.convert("data.csv", b"GEOID,value\n00123,5\n")
        self.assertEqual(r["rows"][0]["GEOID"], "00123")

    def test_csv_formula_protection(self):
        raw, _, _ = formats.export_table(
            [{"GEOID": "00123", "Name": '=HYPERLINK("x")', "value": 10}], FIELDS, "csv"
        )
        self.assertIn(b"'=HYPERLINK", raw)

    def test_excel_roundtrip_values_and_keys(self):
        raw, _, _ = formats.export_table(
            [{"GEOID": "00123", "Name": "Example", "value": 17}], FIELDS, "xlsx"
        )
        r = formats.convert("data.xlsx", raw)
        self.assertEqual(
            r["rows"][0], {"GEOID": "00123", "Name": "Example", "value": 17}
        )

    def test_excel_metadata(self):
        raw, _, _ = formats.export_table(
            [{"GEOID": "1", "Name": "=2+2", "value": 2}], FIELDS, "xlsx"
        )
        wb = load_workbook(io.BytesIO(raw))
        self.assertEqual(wb["Data"]["B2"].data_type, "s")
        self.assertEqual(wb["Indicators"]["B2"].value, "Median household income")

    def test_excel_formulas_rejected(self):
        w = Workbook()
        w.active.append(["GEOID", "value"])
        w.active.append(["1", "=2+3"])
        b = io.BytesIO()
        w.save(b)
        with self.assertRaisesRegex(ValueError, "formulas"):
            formats.convert("data.xlsx", b.getvalue())

    def test_zip_traversal_rejected(self):
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w") as z:
            z.writestr("../secret.kml", "bad")
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            formats.convert("data.zip", b.getvalue())

    def test_external_kml_rejected(self):
        with self.assertRaisesRegex(ValueError, "external"):
            formats.convert(
                "map.kml",
                b"<kml><NetworkLink><Link><href>http://127.0.0.1</href></Link></NetworkLink></kml>",
            )

    def test_disguised_vrt_rejected(self):
        with self.assertRaises(Exception):
            formats.convert(
                "map.geojson",
                b'<OGRVRTDataSource><OGRVRTLayer name="x"><SrcDataSource>/etc/passwd</SrcDataSource></OGRVRTLayer></OGRVRTDataSource>',
            )

    def test_geojson(self):
        r = formats.convert("data.geojson", json.dumps(FC).encode())
        self.assertEqual(r["count"], 1)
        self.assertEqual(r["crs"], 4326)

    def test_gpkg_roundtrip_crs(self):
        raw, _, name = formats.export_geo(FC, FIELDS, "gpkg", 3857)
        r = formats.convert(name, raw)
        self.assertEqual(r["crs"], 3857)
        self.assertEqual(r["rows"][0]["value"], 75000)

    def test_geoparquet_roundtrip(self):
        raw, _, name = formats.export_geo(FC, FIELDS, "parquet", 3857)
        r = formats.convert(name, raw)
        self.assertEqual(r["crs"], 3857)
        self.assertEqual(r["rows"][0]["GEOID"], "13121")

    def test_gdb_native_alias_and_crs(self):
        raw, _, name = formats.export_geo(FC, FIELDS, "gdb", 3857)
        r = formats.convert(name, raw)
        self.assertEqual(r["crs"], 3857)
        with tempfile.TemporaryDirectory() as td:
            zipfile.ZipFile(io.BytesIO(raw)).extractall(td)
            m, table = pyogrio.read_arrow(Path(td) / "data.gdb")
            self.assertEqual(
                table.schema.field("value").metadata[b"GDAL:OGR:alternative_name"],
                b"Median household income",
            )

    def test_shapefile_zip(self):
        with tempfile.TemporaryDirectory() as td:
            df = gpd.GeoDataFrame.from_features(FC["features"], crs=4326)
            p = Path(td) / "data.shp"
            pyogrio.write_dataframe(df, p, driver="ESRI Shapefile")
            b = io.BytesIO()
            with zipfile.ZipFile(b, "w") as z:
                for f in Path(td).iterdir():
                    z.write(f, f.name)
            r = formats.convert("shapes.zip", b.getvalue())
            self.assertEqual(r["count"], 1)

    def test_kml_and_kmz(self):
        raw = b'<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>Example</name><Point><coordinates>-84.4,33.7,0</coordinates></Point></Placemark></Document></kml>'
        self.assertEqual(formats.convert("data.kml", raw)["count"], 1)
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w") as z:
            z.writestr("doc.kml", raw)
        self.assertEqual(formats.convert("data.kmz", b.getvalue())["count"], 1)

    def test_invalid_geometry_rejected(self):
        fc = copy.deepcopy(FC)
        fc["features"][0]["geometry"]["coordinates"] = [
            [[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]
        ]
        with self.assertRaisesRegex(ValueError, "invalid geometry"):
            formats.convert("x.geojson", json.dumps(fc).encode())

    def test_unknown_export_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unknown"):
            formats.export_geo(FC, FIELDS, "invalid")


class SourceValidation(unittest.TestCase):
    def test_private_url_rejected(self):
        for url in [
            "http://services1.arcgis.com/x/FeatureServer/0",
            "https://127.0.0.1/FeatureServer/0",
            "https://services1.arcgis.com.evil.test/FeatureServer/0",
            "https://services1.arcgis.com:444/x/FeatureServer/0",
            "https://secret@services1.arcgis.com/x/FeatureServer/0",
        ]:
            with self.assertRaises(ValueError):
                providers.safe_url(url)

    def test_safe_url_encoded(self):
        self.assertIn(
            "%20",
            providers.safe_url("https://services1.arcgis.com/a test/FeatureServer/0"),
        )

    def test_catalog_sources_and_cardinality(self):
        c = store.edition()["catalog"]
        providers.validate_catalog(c)
        self.assertGreaterEqual(
            sum(sum(not f.get("moe") for f in d["fields"]) for d in c["datasets"]), 1000
        )
        self.assertEqual(len(c["geographies"]), 23)

    def test_duplicate_dataset_rejected(self):
        c = copy.deepcopy(store.edition()["catalog"])
        c["datasets"].append(c["datasets"][0])
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            providers.validate_catalog(c)

    def test_suppression_not_zero(self):
        self.assertIsNone(providers.clean_value(-666666666))
        self.assertEqual(providers.clean_value(0), 0)

    def test_staff_override_and_missing_value(self):
        c = {
            "datasets": [
                {
                    "id": "test",
                    "title": "Test",
                    "year": 2024,
                    "period": "2024",
                    "source": "Fixture",
                    "item_url": "https://example.org",
                    "layers": {"County": 0},
                    "fields": [{"name": "Value", "alias": "Value"}],
                    "records": {"County": [{"GEOID": "13121", "Value": 5}]},
                    "overrides": {"County": {"13121": {"Value": None}}},
                }
            ],
            "geographies": [{"id": "County"}],
        }
        self.assertIsNone(
            providers.query(c, "County", ["test.Value"])["rows"][0]["test.Value"]
        )

    def test_oversized_query_rejected(self):
        with self.assertRaisesRegex(ValueError, "40"):
            providers.query(store.edition()["catalog"], "County", ["x.y"] * 41)


class StaffFlow(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)
        self.origin = {"Origin": "http://testserver"}

    def sign_in(self, role="publisher"):
        token = store.create_session("test-" + role, role)
        self.client.cookies.set(server.COOKIE, token)
        return {**self.origin, "X-CSRF-Token": store.session(token)["csrf"]}

    def test_public_pages_and_headers(self):
        for p in [
            "/",
            "/explorer",
            "/housing",
            "/mobility",
            "/admin",
            "/guide",
            "/about",
            "/delivery",
        ]:
            r = self.client.get(p)
            self.assertEqual(r.status_code, 200)
            self.assertIn("script-src 'self'", r.headers["content-security-policy"])

    def test_health_and_search(self):
        self.assertTrue(self.client.get("/api/health").json()["ok"])
        r = self.client.get("/api/indicators?q=median%20income&geo=County").json()
        self.assertGreater(r["total"], 0)
        self.assertTrue(all("income" in x["alias"].lower() for x in r["results"]))

    def test_no_anonymous_publication(self):
        self.assertEqual(
            self.client.post("/api/publish", json={}, headers=self.origin).status_code,
            403,
        )

    def test_csrf_required(self):
        self.sign_in()
        self.assertEqual(
            self.client.post("/api/publish", json={}, headers=self.origin).status_code,
            403,
        )

    def test_origin_required(self):
        h = self.sign_in()
        h["Origin"] = "https://other.test"
        self.assertEqual(
            self.client.post("/api/publish", json={}, headers=h).status_code, 403
        )

    def test_editor_cannot_publish(self):
        h = self.sign_in("editor")
        self.assertEqual(
            self.client.post("/api/publish", json={}, headers=h).status_code, 403
        )

    def test_editor_draft_roundtrip(self):
        h = self.sign_in("editor")
        e = store.edition()
        e["catalog"]["dashboards"]["housing"]["title"] = "Draft title"
        r = self.client.post("/api/draft", json=e, headers=h)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            self.client.get("/api/draft").json()["catalog"]["dashboards"]["housing"][
                "title"
            ],
            "Draft title",
        )
        self.assertNotEqual(
            store.edition()["catalog"]["dashboards"]["housing"]["title"], "Draft title"
        )

    def test_publish_conflict_restore_history(self):
        h = self.sign_in()
        e = store.edition()
        old = e["revision"]
        e["catalog"]["dashboards"]["housing"]["title"] = "New title"
        e["note"] = "Fixture update"
        r = self.client.post("/api/publish", json=e, headers=h)
        self.assertEqual(r.status_code, 200)
        new = r.json()["revision"]
        self.assertEqual(
            self.client.post("/api/publish", json=e, headers=h).status_code, 409
        )
        r = self.client.post(
            "/api/restore", json={"edition": old, "revision": new}, headers=h
        )
        self.assertEqual(r.status_code, 200)
        history = self.client.get("/api/history").json()
        self.assertGreaterEqual(len(history["editions"]), 3)
        self.assertTrue(any(x["action"] == "publish" for x in history["audit"]))

    def test_logout_revokes_session(self):
        h = self.sign_in()
        self.assertTrue(self.client.get("/api/auth").json()["signed_in"])
        self.assertEqual(
            self.client.post("/api/logout", json={}, headers=h).status_code, 200
        )
        self.assertFalse(self.client.get("/api/auth").json()["signed_in"])

    def test_owner_auth_fail_closed(self):
        self.assertEqual(
            self.client.post(
                "/api/login", json={"password": "anything"}, headers=self.origin
            ).status_code,
            403,
        )

    def test_entra_unconfigured_fail_closed(self):
        self.assertEqual(self.client.get("/auth/login").status_code, 403)

    def test_oversize_request(self):
        self.assertEqual(
            self.client.post(
                "/api/import",
                headers={**self.origin, "Content-Length": str(server.MAX_BODY + 1)},
            ).status_code,
            413,
        )

    def test_public_transient_import(self):
        before = store.edition()["revision"]
        r = self.client.post(
            "/api/import",
            files={"file": ("sample.csv", b"GEOID,value\n13121,3\n", "text/csv")},
            headers=self.origin,
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["count"], 1)
        self.assertEqual(store.edition()["revision"], before)

    def test_history_requires_sign_in(self):
        self.assertEqual(self.client.get("/api/history").status_code, 403)


class ReleaseRegressions(unittest.TestCase):
    def test_empty_selection_does_not_export_everything(self):
        fields = [dict(FIELDS[0], id="test.value")]
        fc = copy.deepcopy(FC)
        fc["features"][0]["properties"].update(label="Fulton")
        fc["crs_epsg"] = 4326
        with (
            patch.object(
                providers,
                "query",
                return_value={
                    "rows": [{"GEOID": "13121", "test.value": 2}],
                    "fields": fields,
                },
            ),
            patch.object(providers, "geometry", return_value=fc),
        ):
            raw, _, _ = server.make_export(
                {}, {"keys": ["test.value"], "selected": [], "kind": "csv"}
            )
            self.assertEqual(len(raw.decode("utf-8-sig").strip().splitlines()), 1)

    def test_custom_column_spaces_are_retained(self):
        fields = [dict(FIELDS[0], id="test.value")]
        fc = copy.deepcopy(FC)
        fc["features"][0]["properties"].update(label="Fulton")
        fc["crs_epsg"] = 4326
        with (
            patch.object(
                providers,
                "query",
                return_value={
                    "rows": [{"GEOID": "13121", "test.value": 2}],
                    "fields": fields,
                },
            ),
            patch.object(providers, "geometry", return_value=fc),
        ):
            raw, _, _ = server.make_export(
                {},
                {
                    "keys": ["test.value"],
                    "selected": ["13121"],
                    "kind": "xlsx",
                    "custom": {
                        "join": "GEOID",
                        "rows": [{"GEOID": "13121", "Local homes": 37}],
                        "fields": ["Local homes"],
                    },
                },
            )
            wb = load_workbook(io.BytesIO(raw))
            self.assertEqual(wb["Data"].cell(2, 4).value, 37)
            self.assertEqual(wb["Indicators"].cell(3, 2).value, "Local homes")

    def test_metadata_formula_is_literal(self):
        fields = [dict(FIELDS[0], alias="=1+1")]
        raw, _, _ = formats.export_table([], fields, "xlsx")
        wb = load_workbook(io.BytesIO(raw))
        self.assertEqual(wb["Indicators"]["B2"].data_type, "s")

    def test_currency_threshold_is_a_count(self):
        c = store.edition()["catalog"]
        d = next(x for x in c["datasets"] if x["id"] == "income")
        f = next(x for x in d["fields"] if x["name"] == "HHIncLt10k_e24")
        self.assertEqual(f["unit"], "number")

    def test_age_is_not_money(self):
        c = store.edition()["catalog"]
        d = next(x for x in c["datasets"] if x["id"] == "demographic-change-2010")
        f = next(x for x in d["fields"] if x["name"] == "mMedianAge_e10")
        self.assertEqual(f["unit"], "number")

    def test_chunked_body_limit(self):
        client = TestClient(server.app)
        with patch.object(server, "MAX_BODY", 64):
            r = client.post(
                "/api/preview",
                content=iter([b"1" * 40, b"2" * 40]),
                headers={"Origin": "http://testserver"},
            )
            self.assertEqual(r.status_code, 413)

    def test_invalid_content_length(self):
        self.assertEqual(
            TestClient(server.app)
            .post("/api/import", headers={"Content-Length": "invalid"})
            .status_code,
            400,
        )

    def test_gdb_rejects_inexact_large_integer(self):
        fc = copy.deepcopy(FC)
        fc["features"][0]["properties"]["value"] = 2**53 + 1
        with self.assertRaisesRegex(ValueError, "precision"):
            formats.export_geo(fc, FIELDS, "gdb")


if __name__ == "__main__":
    unittest.main(verbosity=2)
