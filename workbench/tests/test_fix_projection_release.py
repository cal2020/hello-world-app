"""Regression tests for projection/release findings (cluster C2). Each test names the finding index it covers."""
import copy
import json
import os
import sqlite3
import tempfile
import unittest
import uuid

from lucidwb.db import Database
from lucidwb.projection import contract_diff, generate_contract
from scripts.client import FIX
from tests.helpers import StackCase


def fixture(rel):
    return json.loads((FIX / rel).read_text())


def projection(version, base="equipment-health_1.0.0.json", **top):
    p = fixture("projections/" + base)
    p["version"] = version
    p.update(top)
    return p


class ProjectionReleaseFixes(StackCase):
    def register(self, body, who=None):
        return (who or self.carol).post("/manage/projections", body)

    def review(self, body, who=None, decision="approve"):
        return (who or self.carol).post(
            f"/manage/projects/{body['project']}/projections/{body['projection_id']}/{body['version']}/review",
            {"decision": decision, "reason": "reviewed in test"})

    def build_body(self, body, who=None):
        """Register, approve and build a projection in its own project."""
        self.ok(self.register(body, who), 201)
        self.ok(self.review(body, who))
        return self.ok((who or self.carol).post(f"/manage/projects/{body['project']}/releases", {
            "projection_id": body["projection_id"], "version": body["version"]}), 201)

    def rejected(self, body):
        st, b, _ = self.register(body)
        self.assertEqual((st, (b.get("error") or {}).get("code")), (422, "invalid_projection"), b)
        return " ".join(b["error"]["details"]["errors"])

    def child_of_a(self):
        doc = fixture("model/A_initial.json")
        doc["revision"], doc["parent_revision"] = "r2", "7c1e9a"
        return doc

    def import_child(self, doc):
        self.ok(self.imp("model/A_initial.json"))
        body = self.ok(self.carol.post("/manage/projects/ehm/imports", raw=json.dumps(doc).encode()), 201)
        self.assertEqual(body["outcome"], "accepted_head", body)

    def grant_dana_review(self):
        self.ok(self.admin.post("/manage/grants", {"action": "grant", "user": "dana", "project": "radar",
                                                   "permission": "projection:review"}))

    # ------------------------------------------------------------ 7
    def test_f07_projection_versions_are_scoped_per_project(self):
        self.grant_dana_review()
        # setUp registered ehm equipment-health 1.0.0-2.0.0. The same id and version in radar is another
        # projection: registering it neither conflicts nor tells dana which versions ehm has.
        radar = projection("1.0.0", project="radar")
        del radar["resources"]["gateways"]["fields"]["firmware"]
        self.assertEqual(self.ok(self.register(radar, self.dana), 201)["status"], "draft")
        # Taking a version ehm has not used yet leaves it available to ehm.
        self.ok(self.register(projection("3.0.0", project="radar"), self.dana), 201)
        ehm3 = projection("3.0.0")
        self.ok(self.register(ehm3), 201)
        self.assertEqual(self.ok(self.review(ehm3))["status"], "approved")
        # Reviews are addressed within a project; dana cannot see ehm's projection.
        st, body, _ = self.review(ehm3, self.dana)
        self.assertEqual((st, body["error"]["code"]), (404, "not_found"))
        listed = self.ok(self.dana.get("/api/projects/radar/projections"))["projections"]
        self.assertEqual(sorted((p["version"], p["status"]) for p in listed), [("1.0.0", "draft"), ("3.0.0", "draft")])
        # A release serves its own project's projection, and activation checks that projection's review.
        self.ok(self.imp("model/radar_project.json", who=self.dana, project="radar"), 201)
        self.ok(self.review(radar, self.dana))
        rel = self.ok(self.dana.post("/manage/projects/radar/releases",
                                     {"projection_id": "equipment-health", "version": "1.0.0"}), 201)
        gw = self.ok(self.dana.get(f"/api/releases/{rel['release_id']}/resources/gateways"))["items"][0]
        self.assertEqual(gw["sourceId"], "el-GWR")
        self.assertNotIn("firmware", gw)
        self.ok(self.review(radar, self.dana, decision="reject"))
        st, body, _ = self.dana.post(f"/manage/releases/{rel['release_id']}/activate",
                                     {"expected_active_release_id": None, "reason": "test"},
                                     headers={"Idempotency-Key": str(uuid.uuid4())})
        self.assertEqual(st, 409, body)
        self.assertIn("projection_no_longer_approved", [p["code"] for p in body["error"]["details"]["problems"]])

    # ------------------------------------------------------------ 8
    def test_f08_contract_version_reuse_is_checked_per_project(self):
        self.grant_dana_review()
        self.ok(self.imp("model/radar_project.json", who=self.dana, project="radar"), 201)
        self.ok(self.imp("model/A_initial.json"))
        # radar builds its own shape under ehm's contract id, version 2, first ...
        squat = projection("1.0.0", projection_id="radar-view", project="radar",
                           contract={"id": "equipment-health-api", "version": "2"})
        self.assertEqual(self.build_body(squat, self.dana)["status"], "candidate")
        # ... which does not block ehm's contract v2.
        self.approve("2.0.0")
        r = self.build("2.0.0")
        self.assertEqual((r["status"], r["diagnostics"]), ("candidate", []))
        # A radar build does not learn whether ehm published a version either: ehm has v1 with the 1.0.0 shape.
        self.build("1.0.0")
        probe = projection("1.1.0", base="equipment-health_2.0.0.json", projection_id="radar-view", project="radar",
                           contract={"id": "equipment-health-api", "version": "1"})
        r = self.build_body(probe, self.dana)
        self.assertEqual((r["status"], r["diagnostics"]), ("candidate", []))

    def test_f08_blocked_build_does_not_claim_its_contract_version(self):
        self.ok(self.imp("model/A_initial.json"))
        bad = projection("5.0.0", contract={"id": "equipment-health-api", "version": "7"})
        bad["resources"]["gateways"]["fields"]["site"] = {"from": "properties.nosuch", "type": "string",
                                                          "required": False}
        self.assertEqual(self.build_body(bad)["status"], "blocked_generation")
        r = self.build_body(projection("5.1.0", contract={"id": "equipment-health-api", "version": "7"}))
        self.assertEqual((r["status"], r["diagnostics"]), ("candidate", []))
        # A candidate does claim it: a third shape under v7 is still refused.
        other = projection("5.2.0", contract={"id": "equipment-health-api", "version": "7"})
        del other["resources"]["gateways"]["fields"]["firmware"]
        self.assertIn("contract_version_reused_with_different_shape",
                      [d["code"] for d in self.build_body(other)["diagnostics"]])

    # ------------------------------------------------------------ 20
    def test_f20_identifiers_and_versions_must_match_exactly(self):
        def variant(mutate):
            p = projection("4.0.0")
            mutate(p)
            return p

        def rename_gateways(p):
            p["resources"]["gateways\n"] = p["resources"].pop("gateways")
            p["resources"]["sensors"]["relations"]["gateway"]["target_resource"] = "gateways\n"

        s = lambda p: p["resources"]["sensors"]  # noqa: E731
        cases = {
            "contract version newline": (lambda p: p["contract"].update(version="1\n"), "contract"),
            "contract version leading zero": (lambda p: p["contract"].update(version="01"), "contract"),
            "contract id newline": (lambda p: p["contract"].update(id="equipment-health-api\n"), "contract"),
            "from newline": (lambda p: s(p)["fields"]["name"].update({"from": "name\n"}), "'from' must be"),
            "resource newline": (rename_gateways, "resource name"),
            "field newline": (lambda p: s(p)["fields"].update({"tag\n": s(p)["fields"].pop("name")}), "field name"),
            "predicate newline": (lambda p: s(p)["relations"]["gateway"].update(predicate="connectsTo\n"), "predicate"),
            "projection id newline": (lambda p: p.update(projection_id="equipment-health\n"), "projection_id"),
            "version newline": (lambda p: p.update(version="4.0.0\n"), "version"),
        }
        for label, (mutate, message) in cases.items():
            with self.subTest(label):
                self.assertIn(message, self.rejected(variant(mutate)))
        self.ok(self.register(projection("4.0.0")), 201)

    # ------------------------------------------------------------ 21
    def test_f21_relation_names_cannot_shadow_identity_or_fields(self):
        for name in ("id", "sourceId", "versionId", "name"):
            with self.subTest(name):
                p = projection("4.0.0")
                rels = p["resources"]["sensors"]["relations"]
                rels[name] = rels.pop("gateway")
                self.assertIn(f"sensors.{name}", self.rejected(p))

    # ------------------------------------------------------------ 22
    def test_f22_relation_refs_must_have_the_target_resource_type(self):
        doc = self.child_of_a()
        doc["relationships"].append({"id": "rel-12", "type": "satisfies", "source": "el-GW1", "target": "el-REQ2"})
        self.import_child(doc)
        p = projection("4.0.0", contract={"id": "equipment-health-api", "version": "9"})
        p["resources"]["requirements"] = {
            "element_type": "Requirement", "fields": {"name": {"from": "name", "type": "string", "required": True}},
            "relations": {"satisfiedBy": {"predicate": "satisfies", "direction": "incoming",
                                          "target_resource": "sensors", "cardinality": "many"}}}
        r = self.build_body(p)
        self.assertEqual(r["status"], "blocked_generation")
        bad = [d for d in r["diagnostics"] if d["code"] == "relation_target_type_mismatch"]
        self.assertEqual([(d["entity"], d["relation"], d["target"], d["target_type"], d["expected_type"]) for d in bad],
                         [("el-REQ2", "satisfiedBy", "el-GW1", "Gateway", "Sensor")])
        items = self.ok(self.carol.get(f"/api/releases/{r['release_id']}/resources/requirements"))["items"]
        self.assertEqual({i["sourceId"]: [x["sourceId"] for x in i["satisfiedBy"]] for i in items},
                         {"el-REQ1": ["el-VS101DE"], "el-REQ2": []})

    # ------------------------------------------------------------ 23
    def test_f23_cardinality_one_with_several_targets_is_blocking(self):
        doc = self.child_of_a()
        gw2 = copy.deepcopy(next(e for e in doc["elements"] if e["id"] == "el-GW1"))
        gw2["id"], gw2["name"] = "el-GW2", "Edge Gateway South"
        doc["elements"].append(gw2)
        doc["relationships"].append({"id": "rel-12", "type": "connectsTo", "source": "el-VS101NDE", "target": "el-GW2"})
        self.import_child(doc)
        r = self.build("1.0.0")
        self.assertEqual(r["status"], "blocked_generation")
        ex = [d for d in r["diagnostics"] if d["code"] == "relation_cardinality_exceeded"]
        self.assertEqual([(d["class"], d["entity"], d["relation"], d["targets"]) for d in ex],
                         [("data", "el-VS101NDE", "gateway", ["el-GW1", "el-GW2"])])
        items = self.ok(self.carol.get(f"/api/releases/{r['release_id']}/resources/sensors"))["items"]
        # Deterministic: the first relationship by source ID (rel-02) is served.
        self.assertEqual(next(i for i in items if i["sourceId"] == "el-VS101NDE")["gateway"]["sourceId"], "el-GW1")

    # ------------------------------------------------------------ 24
    def test_f24_resource_names_cannot_collide_with_generated_schemas(self):
        for names in (["error"], ["ref"], ["provenance"], ["source-selection"], ["gateways-page"], ["gw-1", "gw1"]):
            with self.subTest(names):
                p = projection("4.0.0")
                for n in names:
                    p["resources"][n] = copy.deepcopy(p["resources"]["gateways"])
                self.assertIn("collides", self.rejected(p))
        # A name that collides with nothing ('gateway-page' alone) is fine, and the diff sees its schema.
        old = projection("4.0.0")
        old["resources"]["gateway-page"] = old["resources"].pop("gateways")
        old["resources"]["sensors"]["relations"]["gateway"]["target_resource"] = "gateway-page"
        old["resources"]["gateway-page"]["fields"]["firmware"]["required"] = True
        self.ok(self.register(old), 201)
        new = copy.deepcopy(old)
        del new["resources"]["gateway-page"]["fields"]["firmware"]
        changes = contract_diff(generate_contract(old), generate_contract(new))["changes"]
        self.assertEqual([(c["change"], c["schema"], c["field"]) for c in changes],
                         [("field_removed", "GatewayPage", "firmware")])

    # ------------------------------------------------------------ 40
    def test_f40_malformed_projection_members_are_rejected_not_500(self):
        def variant(mutate):
            p = projection("4.0.0")
            mutate(p)
            return p

        s = lambda p: p["resources"]["sensors"]  # noqa: E731
        fields = lambda p: s(p)["fields"]  # noqa: E731
        cases = {
            "resources list": lambda p: p.update(resources=[]),
            "resource string": lambda p: p["resources"].update(gateways="Gateway"),
            "fields list": lambda p: s(p).update(fields=[]),
            "field string": lambda p: fields(p).update(name="name"),
            "convert string": lambda p: fields(p)["sampleIntervalMs"].update(convert="s_to_ms"),
            "convert rule list": lambda p: fields(p)["sampleIntervalMs"].update(convert={"rule": ["s_to_ms"]}),
            "relations list": lambda p: s(p).update(relations=[]),
            "relation string": lambda p: s(p)["relations"].update(gateway="gateways"),
            "target list": lambda p: s(p)["relations"]["gateway"].update(target_resource=["gateways"]),
            "cardinality typo": lambda p: s(p)["relations"]["gateway"].update(cardinality="single"),
            "type object": lambda p: fields(p)["name"].update(type=[{}]),
            "type empty": lambda p: fields(p)["name"].update(type=[]),
            "enum int": lambda p: fields(p)["measurand"].update(enum=5),
            "enum string": lambda p: fields(p)["measurand"].update(enum="vibration"),
            "enum wrong type": lambda p: fields(p)["measurand"].update(enum=["vibration", 3]),
            "enum object": lambda p: fields(p)["measurand"].update(enum=[{"a": 1}]),
            "unit list": lambda p: fields(p)["sampleIntervalMs"].update(unit=["ms"]),
            "version list": lambda p: p.update(version=["4.0.0"]),
            "version not numeric": lambda p: p.update(version="v1"),
            "contract version bool": lambda p: p["contract"].update(version=True),
        }
        for label, mutate in cases.items():
            with self.subTest(label):
                self.rejected(variant(mutate))

    # ------------------------------------------------------------ 41
    def test_f41_build_reports_unusable_source_definitions(self):
        doc = self.child_of_a()
        doc["definitions"]["types"]["Sensor"]["properties"] = None  # the importer accepts a null properties map
        self.import_child(doc)
        r = self.build("1.0.0")
        self.assertEqual(r["status"], "blocked_generation")
        self.assertEqual(sorted(d["field"] for d in r["diagnostics"] if d["code"] == "definition_missing"),
                         ["measurand", "mountPosition", "sampleIntervalMs", "serialNumber"])
        # Definitions stored before the importer validated them (e.g. on an old volume) are diagnosed, not a 500.
        c = self.stack.app.db.read()
        sid = c.execute("SELECT snapshot_id FROM source_head WHERE project='ehm' AND source='synthmodeler'").fetchone()[0]
        defs = fixture("model/A_initial.json")["definitions"]
        defs["types"]["Sensor"]["properties"]["serialNumber"] = "string"
        defs["types"]["Sensor"]["properties"]["measurand"]["enum"] = [["vibration"], "acoustic", "pressure"]
        with self.stack.app.db.tx() as w:
            w.execute("UPDATE source_snapshot SET definitions_json=? WHERE snapshot_id=?", (json.dumps(defs), sid))
        r = self.build("1.0.0")
        self.assertEqual(r["status"], "blocked_generation")
        diags = {d["code"]: d for d in r["diagnostics"]}
        self.assertEqual((diags["definition_invalid"]["field"], diags["definition_invalid"]["class"]),
                         ("serialNumber", "structural"))
        self.assertEqual(diags["enum_value_outside_contract"]["values"], ["acoustic", ["vibration"]])

    # ------------------------------------------------------------ 42
    def test_f42_non_integer_limit_is_400(self):
        rid = self.release_a()
        for path in (f"/api/releases/{rid}/resources/sensors", "/api/current/ehm/resources/sensors"):
            for limit in ("abc", "1.5"):
                with self.subTest(path=path, limit=limit):
                    st, body, _ = self.svc.get(f"{path}?limit={limit}")
                    self.assertEqual((st, body["error"]["code"]), (400, "invalid_input"))
            self.assertEqual(len(self.ok(self.svc.get(f"{path}?limit=2"))["items"]), 2)

    # ------------------------------------------------------------ 43
    def test_f43_missing_required_relation_is_blocking(self):
        doc = self.child_of_a()
        vsx = copy.deepcopy(next(e for e in doc["elements"] if e["id"] == "el-VS101NDE"))
        vsx["id"], vsx["name"] = "el-VSX", "Vibration Sensor X"
        vsx["properties"]["serialNumber"] = "VS-9999"
        doc["elements"].append(vsx)
        self.import_child(doc)
        r = self.build("1.0.0")
        self.assertEqual(r["status"], "blocked_generation")
        miss = [d for d in r["diagnostics"] if d["code"] == "relation_missing"]
        self.assertEqual([(d["class"], d["entity"], d["relation"]) for d in miss], [("data", "el-VSX", "gateway")])
        # A reversed relationship type explains every missing relation; it is reported once, as the root cause.
        p = projection("4.0.0", contract={"id": "equipment-health-api", "version": "9"})
        p["resources"]["sensors"]["relations"]["gateway"]["direction"] = "incoming"
        codes = [d["code"] for d in self.build_body(p)["diagnostics"]]
        self.assertIn("relation_direction_mismatch", codes)
        self.assertNotIn("relation_missing", codes)

    # ------------------------------------------------------------ 44
    def test_f44_reordered_type_and_enum_are_the_same_shape(self):
        self.release_a()
        p = projection("12.0.0")
        f = p["resources"]["sensors"]["fields"]
        f["mountPosition"]["type"] = ["null", "string"]
        f["measurand"]["enum"] = list(reversed(f["measurand"]["enum"]))
        r = self.build_body(p)
        self.assertEqual((r["status"], r["diagnostics"]), ("candidate", []))
        self.assertEqual(r["contract_diff_vs_active"]["changes"], [])
        # A real enum change is still reported.
        p = projection("12.1.0", contract={"id": "equipment-health-api", "version": "3"})
        p["resources"]["sensors"]["fields"]["measurand"]["enum"].append("acoustic")
        changes = self.build_body(p)["contract_diff_vs_active"]["changes"]
        self.assertEqual([(c["change"], c["field"]) for c in changes], [("enum_changed", "measurand")])


class ProjectionKeyMigration(unittest.TestCase):
    """A database written before projections were keyed per project is upgraded in place (finding 7)."""
    OLD = """
    CREATE TABLE projection_definition (
      projection_id TEXT NOT NULL, version TEXT NOT NULL, project TEXT NOT NULL, body_json TEXT NOT NULL,
      digest TEXT NOT NULL, status TEXT NOT NULL, reviewed_by TEXT, review_reason TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (projection_id, version)
    );
    INSERT INTO projection_definition VALUES ('equipment-health', '1.0.0', 'ehm', '{}', 'd1', 'approved', 'carol',
      'ok', 't');
    """

    def test_f07_old_projection_key_is_upgraded_in_place(self):
        path = os.path.join(tempfile.mkdtemp(prefix="lwb-migrate-"), "old.db")
        old = sqlite3.connect(path)
        old.executescript(self.OLD)
        old.close()
        c = Database(path).connect()
        pk = sorted((r["pk"], r["name"]) for r in c.execute("PRAGMA table_info(projection_definition)") if r["pk"])
        self.assertEqual([n for _, n in pk], ["project", "projection_id", "version"])
        self.assertEqual(tuple(c.execute("SELECT project, status FROM projection_definition").fetchone()),
                         ("ehm", "approved"))
        c.execute("INSERT INTO projection_definition VALUES ('equipment-health', '1.0.0', 'radar', '{}', 'd2', "
                  "'draft', NULL, NULL, 't')")
        with self.assertRaises(sqlite3.IntegrityError):
            c.execute("INSERT INTO projection_definition VALUES ('equipment-health', '1.0.0', 'radar', '{}', 'd3', "
                      "'draft', NULL, NULL, 't')")
        Database(path)  # opening an upgraded database again is a no-op


if __name__ == "__main__":
    unittest.main()
