"""Private reporting: HTTP boundaries, duplicate handling and cursor retention."""

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

TMP = tempfile.TemporaryDirectory(prefix="arc-visits-")
os.environ["ARC_STATE"] = TMP.name
os.environ["ARC_ORIGIN"] = "http://testserver"
os.environ["ARC_DEMO_REPORTING"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "site"))
import server
import store
import visit_reporting as visits
from starlette.testclient import TestClient


class Visits(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)
        self.event = {
            "event_id": str(uuid4()),
            "session_id": str(uuid4()),
            "page": "/explorer",
        }
        with sqlite3.connect(server.VISIT_DB) as c:
            c.execute("DELETE FROM demo_visits")
        visits._rates.clear()

    def send(self, event=None):
        return self.client.post(
            "/api/visit",
            json=event or self.event,
            headers={"Origin": "http://testserver"},
        )

    def report(self, after=0):
        with sqlite3.connect(server.VISIT_DB) as c:
            return visits.report(c, after)

    def test_default_off(self):
        with patch.object(visits, "ENABLED", False):
            self.assertFalse(self.client.get("/api/visit-config").json()["enabled"])
            self.assertFalse(self.send().json()["recorded"])
        self.assertEqual(self.report()["pageviews"], 0)

    def test_duplicate_and_anonymous_session_group(self):
        self.assertTrue(self.send().json()["recorded"])
        self.assertFalse(self.send().json()["recorded"])
        self.send({**self.event, "event_id": str(uuid4()), "page": "/housing"})
        r = self.report()
        self.assertEqual((r["pageviews"], r["browser_sessions"]), (2, 1))
        self.assertNotIn(self.event["session_id"], json.dumps(r))
        self.assertEqual(self.report(r["last_event_id"])["pageviews"], 0)

    def test_no_public_report(self):
        self.assertEqual(self.client.get("/api/visits").status_code, 404)

    def test_origin_and_no_arbitrary_payloads(self):
        self.assertEqual(
            self.client.post("/api/visit", json=self.event).status_code, 403
        )
        self.assertEqual(
            self.send({**self.event, "email": "secret@example.com"}).status_code, 400
        )
        self.assertEqual(
            self.send({**self.event, "page": "/explorer?secret=yes"}).status_code, 400
        )
        self.assertEqual(
            self.send({**self.event, "session_id": "not-a-session"}).status_code, 400
        )

    def test_authenticated_owner_excluded(self):
        token = store.create_session("owner", "publisher")
        self.client.cookies.set(server.COOKIE, token)
        self.assertFalse(self.client.get("/api/visit-config").json()["enabled"])
        self.assertFalse(self.send().json()["recorded"])

    def test_forwarded_spoofing(self):
        self.assertEqual(visits.client_address("8.8.8.8", "1.1.1.1"), "8.8.8.8")
        self.assertEqual(
            visits.client_address("127.0.0.1", "1.1.1.1, 8.8.8.8"), "8.8.8.8"
        )
        self.assertEqual(visits.client_address("unknown", "1.1.1.1"), "")

    def test_exclusion_and_monotonic_cursor(self):
        self.send()
        first = self.report()["last_event_id"]
        with sqlite3.connect(server.VISIT_DB) as c:
            c.execute("UPDATE demo_visits SET excluded=1")
        self.assertEqual(self.report()["pageviews"], 0)
        with sqlite3.connect(server.VISIT_DB) as c:
            c.execute("DELETE FROM demo_visits")
        self.assertGreaterEqual(self.report(first)["last_event_id"], first)
        self.send({**self.event, "event_id": str(uuid4())})
        self.assertEqual(self.report(first)["pageviews"], 1)

    def test_ip_not_stored(self):
        self.send()
        with sqlite3.connect(server.VISIT_DB) as c:
            columns = [x[1] for x in c.execute("PRAGMA table_info(demo_visits)")]
        self.assertEqual(
            columns,
            [
                "id",
                "event_id",
                "occurred_at",
                "session_id",
                "page",
                "country",
                "region",
                "city",
                "geo_status",
                "excluded",
            ],
        )


if __name__ == "__main__":
    unittest.main()
