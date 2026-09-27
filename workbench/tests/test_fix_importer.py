"""Regression tests for importer findings (cluster C1). Each test names the finding index it covers."""
import copy
import json
import os
import sqlite3
import tempfile
import unittest

from lucidwb.db import Database
from scripts.client import FIX
from tests.helpers import StackCase


def fixture(rel):
    return json.loads((FIX / rel).read_text())


class ImporterFixes(StackCase):
    def post(self, doc, raw=None):
        return self.carol.post("/manage/projects/ehm/imports", raw=raw or json.dumps(doc).encode())

    def imports(self):
        return self.ok(self.carol.get("/api/projects/ehm/imports"))["imports"]

    def model_snapshots(self):
        return [s["snapshot_id"] for s in self.ok(self.carol.get("/api/projects/ehm/snapshots"))["snapshots"]
                if s["source"] == "synthmodeler"]

    def diff(self, a, b):
        return self.ok(self.carol.get(f"/api/projects/ehm/diff?from={a}&to={b}"))

    def child_of_a(self, revision="r2"):
        doc = fixture("model/A_initial.json")
        doc["revision"], doc["parent_revision"] = revision, "7c1e9a"
        return doc

    # ------------------------------------------------------------ 0
    def test_f00_delta_without_definitions_uses_parent_definitions(self):
        self.ok(self.imp("model/A_initial.json"))
        a = fixture("model/A_initial.json")
        el = copy.deepcopy(next(e for e in a["elements"] if e["id"] == "el-VS101DE"))
        el["properties"]["sampleInterval"] = 250
        delta = {"format": a["format"], "source": "synthmodeler", "project": "ehm", "revision": "d-nodefs",
                 "parent_revision": "7c1e9a", "kind": "delta", "scope": {"kind": "complete"}, "elements": [el]}
        body = self.ok(self.post(delta), 201)
        self.assertEqual(body["outcome"], "accepted_head")
        self.assertNotIn("unknown_element_type", [d["code"] for d in body["diagnostics"]])
        vs = self.entity("el-VS101DE")
        self.assertEqual(vs["properties"]["sampleInterval"], 250)
        self.assertEqual(vs["properties"]["serialNumber"], "VS-4471")
        self.assertEqual(vs["unrecognized_keys"], [])
        a_sid, d_sid = self.model_snapshots()
        changes = [(c["change"], c.get("property")) for c in self.diff(a_sid, d_sid)["data"]]
        self.assertEqual(changes, [("property_value", "sampleInterval")])

    # ------------------------------------------------------------ 1
    def test_f01_empty_property_definition_does_not_break_diff(self):
        self.ok(self.imp("model/A_initial.json"))
        b = self.child_of_a("r-notes")
        b["definitions"]["types"]["Pump"]["properties"]["notes"] = {}
        self.ok(self.post(b), 201)
        c = self.child_of_a("r-no-notes")
        c["parent_revision"] = "r-notes"
        self.ok(self.post(c), 201)
        a_sid, b_sid, c_sid = self.model_snapshots()
        self.assertIn({"change": "property_definition_added", "type": "Pump", "property": "notes"},
                      self.diff(a_sid, b_sid)["structural"])
        self.assertIn({"change": "property_definition_removed", "type": "Pump", "property": "notes"},
                      self.diff(b_sid, c_sid)["structural"])

    # ------------------------------------------------------------ 12
    def test_f12_resending_bytes_accepted_by_reconciliation_is_a_duplicate(self):
        self.ok(self.imp("model/A_initial.json"))
        self.ok(self.imp("model/B_rename_gateway.json"))
        st, late, _ = self.imp("model/late_revision_based_on_A.json")
        self.assertEqual((st, late["outcome"]), (409, "rejected_stale_base"))
        rec = self.ok(self.carol.post(f"/manage/imports/{late['import_id']}/reconcile",
                                      {"action": "accept_as_head", "expected_head": "f02b44"}), 201)
        again = self.ok(self.imp("model/late_revision_based_on_A.json"), 200)
        self.assertEqual(again["outcome"], "duplicate_no_change")
        self.assertEqual(again["duplicate_of"], rec["import_id"])
        self.assertEqual(again["snapshot_id"], rec["snapshot_id"])
        self.assertEqual(self.heads()["synthmodeler"], "late-4c2d")

    # ------------------------------------------------------------ 13
    def test_f13_unbased_records_import_can_be_accepted_as_head(self):
        doc = fixture("records/cmms_main.json")
        doc["revision"], doc["parent_revision"] = "m-20261001", None
        st, body, _ = self.post(doc)
        self.assertEqual((st, body["outcome"]), (409, "quarantined_unbased"))
        rec = self.ok(self.carol.post(f"/manage/imports/{body['import_id']}/reconcile",
                                      {"action": "accept_as_head", "expected_head": "m-20260901"}), 201)
        self.assertEqual(rec["outcome"], "accepted_head")
        self.assertEqual(self.heads()["cmms"], "m-20261001")
        again = self.ok(self.post(doc), 200)  # identical bytes again: duplicate, not a conflict (finding 12)
        self.assertEqual(again["outcome"], "duplicate_no_change")

    # ------------------------------------------------------------ 14
    def test_f14_wrongly_typed_fields_are_quarantined_and_recorded(self):
        def model(mutate):
            doc = fixture("model/A_initial.json")
            mutate(doc)
            return doc

        def records(mutate):
            doc = fixture("records/cmms_main.json")
            doc["revision"], doc["parent_revision"] = "m-20261001", "m-20260901"
            mutate(doc)
            return doc

        cases = {
            "relationship without type": (model(lambda d: d["relationships"][0].pop("type")),
                                          "/relationships/0/type"),
            "scope as string": (model(lambda d: d.update(scope="complete")), None),
            "element name as object": (model(lambda d: d["elements"][0].update(name={"en": "Pump"})),
                                       "/elements/0/name"),
            "element owner as object": (model(lambda d: d["elements"][0].update(owner={"pkg": 1})),
                                        "/elements/0/owner"),
            "properties as list": (model(lambda d: d["elements"][0].update(properties=["tag"])),
                                   "/elements/0/properties"),
            "relationship id as int": (model(lambda d: d["relationships"][0].update(id=17)), None),
            "relationship endpoint as object": (model(lambda d: d["relationships"][0].update(source={"id": 1})),
                                                "/relationships/0/source"),
            "revision as object": (model(lambda d: d.update(revision={"r": 1})), None),
            "parent as number": (model(lambda d: d.update(parent_revision=7)), "/parent_revision"),
            "definitions as list": (model(lambda d: d.update(definitions=[])), "/definitions"),
            "type definition as list": (model(lambda d: d["definitions"]["types"].update(Pump=[])),
                                        "/definitions/types/Pump"),
            "property definition as null": (
                model(lambda d: d["definitions"]["types"]["Pump"]["properties"].update(tag=None)),
                "/definitions/types/Pump/properties/tag"),
            "elements as object": (model(lambda d: d.update(elements={})), "/elements"),
            "format as object": (model(lambda d: d.update(format={"f": 1})), None),
            "mixed record ids": (records(lambda d: d["records"][0].update(id=1001)), None),
            "record kind as object": (records(lambda d: d["records"][0].update(kind={"k": 1})), "/records/0/kind"),
        }
        before = len(self.imports())
        for name, (doc, pointer) in cases.items():
            with self.subTest(name):
                st, body, _ = self.post(doc)
                self.assertIn(st, (400, 422), body)
                self.assertTrue(body["outcome"].startswith(("quarantined_", "rejected_")), body)
                if pointer:
                    self.assertIn(pointer, [d.get("pointer") for d in body["diagnostics"]])
        self.assertEqual(len(self.imports()), before + len(cases))
        self.assertNotIn("synthmodeler", self.heads())

    def test_f14_structured_multiplicity_is_stored_json_encoded(self):
        doc = fixture("model/A_initial.json")
        doc["relationships"][0]["multiplicity"] = {"lower": 0, "upper": "*"}
        body = self.ok(self.post(doc), 201)
        row = self.stack.app.db.read().execute(
            "SELECT multiplicity FROM relationship_version rv JOIN snapshot_relationship sr "
            "ON sr.version_id=rv.version_id WHERE sr.snapshot_id=? AND rv.native_id='rel-01'",
            (body["snapshot_id"],)).fetchone()
        self.assertEqual(json.loads(row["multiplicity"]), {"lower": 0, "upper": "*"})

    # ------------------------------------------------------------ 15
    def test_f15_element_without_type_is_quarantined(self):
        doc = fixture("model/A_initial.json")
        doc["elements"][0].pop("type")
        st, body, _ = self.post(doc)
        self.assertEqual((st, body["outcome"]), (422, "quarantined_invalid"))
        self.assertIn({"code": "invalid_field", "pointer": "/elements/0/type", "expected": "non-empty string"},
                      body["diagnostics"])
        self.assertNotIn("synthmodeler", self.heads())
        dangling = self.stack.app.db.read().execute(
            "SELECT COUNT(*) FROM snapshot_element se LEFT JOIN element_version ev ON ev.version_id=se.version_id "
            "WHERE ev.version_id IS NULL").fetchone()[0]
        self.assertEqual(dangling, 0)

    # ------------------------------------------------------------ 16
    def test_f16_diff_reports_type_owner_unrecognized_and_json_type_changes(self):
        self.ok(self.imp("model/A_initial.json"))
        b = self.child_of_a()
        b["definitions"]["types"]["Motor"] = {"properties": {"tag": {"type": "string"}}}
        els = {e["id"]: e for e in b["elements"]}
        els["el-P102"].update(type="Motor", owner="pkg-decommissioned")
        els["el-VS101DE"]["properties"]["calibrationOffset"] = False
        els["el-DIAG1"]["x-vendor-geometry"] = {"w": 1024, "h": 600}
        self.ok(self.post(b), 201)
        a_sid, b_sid = self.model_snapshots()
        data = self.diff(a_sid, b_sid)["data"]
        got = {(d["change"], d["source_id"]): d for d in data}
        self.assertEqual((got[("type_changed", "el-P102")]["from"], got[("type_changed", "el-P102")]["to"]),
                         ("Pump", "Motor"))
        self.assertEqual(got[("owner_changed", "el-P102")]["to"], "pkg-decommissioned")
        cal = got[("property_value", "el-VS101DE")]
        self.assertEqual((cal["property"], cal["from"], cal["to"]), ("calibrationOffset", 0, False))
        self.assertEqual(got[("unrecognized_content_changed", "el-DIAG1")]["keys"], ["x-vendor-geometry"])

    # ------------------------------------------------------------ 17
    def test_f17_staged_partial_does_not_block_the_complete_revision(self):
        self.ok(self.imp("model/A_initial.json"))
        partial = fixture("model/partial_sensors_only.json")
        partial["revision"], partial["parent_revision"] = "r2", "7c1e9a"
        st, staged, _ = self.post(partial)
        self.assertEqual((st, staged["outcome"]), (202, "staged_partial"))
        complete = self.ok(self.post(self.child_of_a("r2")), 201)
        self.assertEqual(complete["outcome"], "accepted_head")
        self.assertEqual(self.heads()["synthmodeler"], "r2")
        self.assertEqual(self.ok(self.post(partial), 200)["snapshot_id"], staged["snapshot_id"])
        self.assertEqual(self.ok(self.post(self.child_of_a("r2")), 200)["snapshot_id"], complete["snapshot_id"])
        # A delta based on r2 builds on the complete snapshot, not on the staged view.
        delta = fixture("model/delta_delete_temperature_sensor.json")
        delta["parent_revision"] = "r2"
        d = self.ok(self.post(delta), 201)
        self.assertEqual(d["counts"]["elements_present"], 11)

    # ------------------------------------------------------------ 18
    def test_f18_source_format_cannot_change(self):
        self.ok(self.imp("model/A_initial.json"))
        rec = fixture("records/cmms_main.json")
        rec.update(source="synthmodeler", revision="oops-1", parent_revision="7c1e9a")
        st, body, _ = self.post(rec)
        self.assertEqual((st, body["outcome"]), (409, "rejected_format_mismatch"))
        self.assertEqual(body["diagnostics"][0]["code"], "format_mismatch")
        model = self.child_of_a("m-model")
        model.update(source="cmms", parent_revision="m-20260901")
        st, body, _ = self.post(model)
        self.assertEqual((st, body["outcome"]), (409, "rejected_format_mismatch"))
        self.assertEqual(self.heads(), {"synthmodeler": "7c1e9a", "cmms": "m-20260901"})

    # ------------------------------------------------------------ 19
    def test_f19_unknown_relationship_record_and_top_level_content_is_kept_and_flagged(self):
        a = fixture("model/A_initial.json")
        a["relationships"][0]["properties"] = {"cableType": "shielded", "lengthM": 12}
        body = self.ok(self.post(a), 201)
        self.assertIn({"code": "unrecognized_relationship_key", "id": "rel-01", "key": "properties"},
                      body["diagnostics"])
        c = self.stack.app.db.read()
        rv = c.execute("SELECT rv.unrecognized_json FROM relationship_version rv JOIN snapshot_relationship sr "
                       "ON sr.version_id=rv.version_id WHERE sr.snapshot_id=? AND rv.native_id='rel-01'",
                       (body["snapshot_id"],)).fetchone()
        self.assertEqual(json.loads(rv[0]), {"properties": {"cableType": "shielded", "lengthM": 12}})
        top = c.execute("SELECT unrecognized_json FROM source_snapshot WHERE snapshot_id=?",
                        (body["snapshot_id"],)).fetchone()[0]
        self.assertEqual(json.loads(top), {"x_exporter_note": a["x_exporter_note"]})
        a["relationships"][0]["properties"]["lengthM"] = 40
        st, body, _ = self.post(a)
        self.assertEqual((st, body["outcome"]), (409, "quarantined_conflict"))

        rec = fixture("records/cmms_main.json")
        rec["records"][0]["performed_at"] = "2026-08-30"
        st, body, _ = self.post(rec)  # same revision as the seeded records, extra content
        self.assertEqual((st, body["outcome"]), (409, "quarantined_conflict"))
        rec["revision"], rec["parent_revision"] = "m-20261001", "m-20260901"
        body = self.ok(self.post(rec), 201)
        self.assertIn({"code": "unrecognized_record_key", "id": "MR-1001", "key": "performed_at"}, body["diagnostics"])
        row = c.execute("SELECT unrecognized_json FROM external_record WHERE snapshot_id=? AND record_id='MR-1001'",
                        (body["snapshot_id"],)).fetchone()
        self.assertEqual(json.loads(row[0]), {"performed_at": "2026-08-30"})

    # ------------------------------------------------------------ 25 (input side)
    def test_f25_non_finite_numbers_are_quarantined(self):
        raw = (FIX / "model/A_initial.json").read_text()
        before = len(self.imports())
        for token in ("NaN", "Infinity", "-Infinity", "1e400"):
            with self.subTest(token):
                st, body, _ = self.post(None, raw=raw.replace('"retentionDays": 90', f'"retentionDays": {token}')
                                        .encode())
                self.assertEqual((st, body["outcome"]), (422, "quarantined_invalid"))
                self.assertEqual(body["diagnostics"][0]["code"], "non_finite_number")
                self.assertEqual(body["diagnostics"][0]["pointers"], ["/elements/7/properties/retentionDays"])
        self.assertEqual(len(self.imports()), before + 4)
        self.assertNotIn("synthmodeler", self.heads())

    # ------------------------------------------------------------ 38
    def test_f38_deletions_are_validated_and_reported_in_the_receipt(self):
        self.ok(self.imp("model/A_initial.json"))
        self.ok(self.imp("model/B_rename_gateway.json"))
        delta = fixture("model/delta_delete_temperature_sensor.json")
        delta["deletions"] = "el-TS101"
        st, body, _ = self.post(delta)
        self.assertEqual((st, body["outcome"]), (422, "quarantined_invalid"))
        self.assertIn("/deletions", [d.get("pointer") for d in body["diagnostics"]])
        self.assertEqual(self.entity("el-TS101")["state"], "present")
        delta["deletions"] = ["el-TS101", "no-such-id"]
        body = self.ok(self.post(delta), 201)
        unknown = {"code": "deletion_of_unknown_id", "id": "no-such-id"}
        self.assertIn(unknown, body["diagnostics"])
        listed = next(i for i in self.imports() if i["import_id"] == body["import_id"])
        self.assertIn(unknown, listed["diagnostics"])

    # ------------------------------------------------------------ 39
    def test_f39_deletion_id_shared_by_element_and_relationship_is_ambiguous(self):
        a = fixture("model/A_initial.json")
        a["relationships"].append({"id": "el-REQ1", "type": "satisfies", "source": "el-GW1", "target": "el-REQ1"})
        self.ok(self.post(a), 201)
        delta = fixture("model/delta_delete_temperature_sensor.json")
        delta.update(parent_revision="7c1e9a", deletions=["el-REQ1"])
        st, body, _ = self.post(delta)
        self.assertEqual((st, body["outcome"]), (422, "quarantined_invalid"))
        self.assertEqual(body["diagnostics"][0]["code"], "ambiguous_deletion_id")
        self.assertEqual(self.entity("el-REQ1")["state"], "present")
        self.assertEqual(self.heads()["synthmodeler"], "7c1e9a")


class SchemaMigration(unittest.TestCase):
    """Databases written before the fixes (e.g. on a mounted volume) are upgraded in place (findings 17, 19)."""
    OLD = """
    CREATE TABLE source_snapshot (
      snapshot_id TEXT PRIMARY KEY, source TEXT NOT NULL, project TEXT NOT NULL, revision TEXT NOT NULL,
      parent_revision TEXT, kind TEXT NOT NULL, completeness TEXT NOT NULL, scope_json TEXT NOT NULL,
      raw_digest TEXT NOT NULL, normalized_digest TEXT NOT NULL, adapter_version TEXT NOT NULL,
      status TEXT NOT NULL, definitions_json TEXT NOT NULL, import_id TEXT NOT NULL, created_at TEXT NOT NULL,
      warnings_json TEXT NOT NULL,
      UNIQUE (source, project, revision)
    );
    CREATE TABLE relationship_version (
      version_id TEXT PRIMARY KEY, rel_uid TEXT NOT NULL, native_id TEXT, predicate TEXT NOT NULL,
      source_uid TEXT NOT NULL, target_uid TEXT NOT NULL, multiplicity TEXT, authority TEXT NOT NULL,
      input_versions_json TEXT NOT NULL, content_digest TEXT NOT NULL
    );
    CREATE TABLE external_record (
      snapshot_id TEXT NOT NULL, record_id TEXT NOT NULL, record_version TEXT NOT NULL, kind TEXT NOT NULL,
      asset_ref TEXT, text TEXT NOT NULL, PRIMARY KEY (snapshot_id, record_id)
    );
    INSERT INTO source_snapshot VALUES ('snap_old', 's', 'p', 'R', NULL, 'snapshot', 'partial', '{}', 'r', 'n',
      'a', 'staged_partial', '{}', 'imp_old', 't', '[]');
    INSERT INTO external_record VALUES ('snap_rec', 'MR-1', 'rv_1', 'note', NULL, 'text');
    """

    def test_old_database_is_upgraded_in_place(self):
        path = os.path.join(tempfile.mkdtemp(prefix="lwb-migrate-"), "old.db")
        old = sqlite3.connect(path)
        old.executescript(self.OLD)
        old.close()
        c = Database(path).connect()
        for table in ("source_snapshot", "relationship_version", "external_record"):
            self.assertIn("unrecognized_json", [r["name"] for r in c.execute(f"PRAGMA table_info({table})")])
        self.assertEqual(tuple(c.execute("SELECT revision, unrecognized_json FROM source_snapshot").fetchone()),
                         ("R", "{}"))
        # The complete snapshot of R can now sit next to the staged partial view of R, but not twice.
        row = ("snap_new", "s", "p", "R", None, "snapshot", "complete", "{}", "r", "n", "a", "head", "{}",
               "imp_new", "t", "[]", "{}")
        c.execute("INSERT INTO source_snapshot VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", row)
        with self.assertRaises(sqlite3.IntegrityError):
            c.execute("INSERT INTO source_snapshot VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      ("snap_dup",) + row[1:6] + ("delta",) + row[7:])
        Database(path)  # opening an upgraded database again is a no-op
