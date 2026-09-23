"""Integration-correctness cases (IC-xx). Each test uses real HTTP against a fresh local stack.

Case IDs match EVALUATION.md. Semantic link quality is evaluated separately (scripts/evaluate.py).
"""
import json
import threading
import uuid

from tests.helpers import StackCase, Client


class Identity(StackCase):
    def test_IC01_exact_repeated_import_has_no_duplicate_effects(self):
        first = self.ok(self.imp("model/A_initial.json"), 201)
        outbox_before = len(self.ok(self.carol.get("/api/projects/ehm/history"))["outbox"])
        again = self.ok(self.imp("model/A_initial.json"), 200)
        self.assertEqual(again["outcome"], "duplicate_no_change")
        self.assertEqual(again["duplicate_of"], first["import_id"])
        self.assertEqual(again["snapshot_id"], first["snapshot_id"])
        self.assertEqual(again["counts"], first["counts"])
        self.assertEqual(len(self.ok(self.carol.get("/api/projects/ehm/history"))["outbox"]), outbox_before)
        # both attempts retained as receipts
        outcomes = [i["outcome"] for i in self.ok(self.carol.get("/api/projects/ehm/imports"))["imports"]
                    if i["source"] == "synthmodeler"]
        self.assertEqual(outcomes, ["accepted_head", "duplicate_no_change"])

    def test_IC02_rename_preserves_identity_and_history(self):
        self.ok(self.imp("model/A_initial.json"))
        before = self.entity("el-GW1")
        b = self.ok(self.imp("model/B_rename_gateway.json"), 201)
        after = self.entity("el-GW1")
        self.assertEqual(before["entity_uid"], after["entity_uid"])
        self.assertNotEqual(before["version_id"], after["version_id"])
        self.assertEqual(after["name"], "Plant Edge Gateway North-1")
        self.assertEqual(b["counts"]["total_logical_entities_in_project"], 12)
        hist = self.ok(self.carol.get(f"/api/projects/ehm/entities/{after['entity_uid']}/history"))["history"]
        self.assertEqual([h["name"] for h in hist], ["Edge Gateway North", "Plant Edge Gateway North-1"])
        snaps = [s["snapshot_id"] for s in self.ok(self.carol.get("/api/projects/ehm/snapshots"))["snapshots"]
                 if s["source"] == "synthmodeler"]
        d = self.ok(self.carol.get(f"/api/projects/ehm/diff?from={snaps[0]}&to={snaps[1]}"))
        self.assertEqual([x["change"] for x in d["data"]], ["renamed_identity_preserved"])
        self.assertEqual(d["structural"] + d["semantic"], [])

    def test_IC03_similar_names_different_projects_no_merge_no_disclosure(self):
        self.ok(self.imp("model/A_initial.json"))
        self.ok(self.imp("model/radar_project.json", who=self.dana, project="radar"), 201)
        ehm = self.entity("el-VS101DE")
        radar_snap = self.ok(self.dana.get("/api/projects/radar/snapshots"))["snapshots"][0]["snapshot_id"]
        radar = next(e for e in self.ok(self.dana.get(f"/api/projects/radar/snapshots/{radar_snap}/elements"))["elements"]
                     if e["source_id"] == "el-VS101DE")
        self.assertEqual(ehm["name"], radar["name"])
        self.assertNotEqual(ehm["entity_uid"], radar["entity_uid"])
        # Cross-project reads look nonexistent, with no content in the error.
        st, body, _ = self.alice.get(f"/api/projects/radar/snapshots/{radar_snap}/elements")
        self.assertEqual(st, 404)
        self.assertNotIn("RS-0009", json.dumps(body))
        st, _, _ = self.dana.get("/api/projects/ehm/snapshots")
        self.assertEqual(st, 404)
        self.assertEqual(self.ok(self.alice.get("/api/projects"))["projects"], ["ehm"])
        # The model proposer only sees ehm elements.
        self.ok(self.imp("model/A_initial.json"))
        run = self.proposals()
        self.assertNotIn(radar["entity_uid"], json.dumps(run))

    def test_IC04_same_revision_different_content_is_quarantined(self):
        self.ok(self.imp("model/A_initial.json"))
        self.ok(self.imp("model/B_rename_gateway.json"))
        head = self.heads()["synthmodeler"]
        st, body, _ = self.imp("model/conflict_same_revision_B.json")
        self.assertEqual(st, 409)
        self.assertEqual(body["outcome"], "quarantined_conflict")
        self.assertEqual(body["diagnostics"][0]["code"], "source_revision_conflict")
        self.assertEqual(self.heads()["synthmodeler"], head)
        self.assertEqual(self.entity("el-GW1")["name"], "Plant Edge Gateway North-1")

    def test_IC05_partial_export_does_not_infer_deletion(self):
        self.ok(self.imp("model/A_initial.json"))
        self.ok(self.imp("model/B_rename_gateway.json"))
        head = self.heads()["synthmodeler"]
        st, body, _ = self.imp("model/partial_sensors_only.json")
        self.assertEqual(st, 202)
        self.assertEqual(body["outcome"], "staged_partial")
        self.assertEqual(body["counts"]["elements_deleted"], 0)
        self.assertEqual(self.heads()["synthmodeler"], head)
        self.assertEqual(self.entity("el-TS101")["state"], "present")
        staged = body["snapshot_id"]
        self.assertIsNone(self.entity("el-TS101", snapshot=staged))  # unseen, not "deleted"

    def test_IC06_explicit_deletion_and_complete_scope_removal_keep_history(self):
        self.ok(self.imp("model/A_initial.json"))
        a_snap = next(h["snapshot_id"] for h in self.ok(self.carol.get("/api/projects/ehm/sources"))["heads"]
                      if h["source"] == "synthmodeler")
        self.ok(self.imp("model/B_rename_gateway.json"))
        d = self.ok(self.imp("model/delta_delete_temperature_sensor.json"), 201)
        self.assertEqual(d["counts"]["elements_deleted"], 1)
        ts = self.entity("el-TS101")
        self.assertEqual(ts["state"], "deleted")
        self.assertEqual(self.entity("el-TS101", snapshot=a_snap)["state"], "present")  # history intact
        rels = self.ok(self.carol.get(f"/api/projects/ehm/snapshots/{d['snapshot_id']}/relationships"))["relationships"]
        self.assertEqual({r["native_id"]: r["state"] for r in rels}["rel-03"], "deleted")

    def test_IC06b_complete_snapshot_removal_flags_possible_replacement_without_merging(self):
        for f in ["A_initial", "B_rename_gateway", "C_remove_serial_field", "D_unit_ms_to_s"]:
            self.ok(self.imp(f"model/{f}.json"))
        snaps = [s["snapshot_id"] for s in self.ok(self.carol.get("/api/projects/ehm/snapshots"))["snapshots"]
                 if s["source"] == "synthmodeler"]
        e = self.ok(self.imp("model/E_replace_sensor.json"), 201)
        self.assertEqual(self.entity("el-VS101NDE")["state"], "deleted")
        self.assertNotEqual(self.entity("el-VS101NDE2")["entity_uid"], self.entity("el-VS101NDE")["entity_uid"])
        d = self.ok(self.carol.get(f"/api/projects/ehm/diff?from={snaps[-1]}&to={e['snapshot_id']}"))
        self.assertEqual(d["identity_review"][0]["removed"], "el-VS101NDE")
        self.assertEqual(d["identity_review"][0]["added"], "el-VS101NDE2")

    def test_IC07_out_of_order_and_missing_parent_never_regress_head(self):
        self.ok(self.imp("model/A_initial.json"))
        self.ok(self.imp("model/B_rename_gateway.json"))
        head = self.heads()["synthmodeler"]
        st, orphan, _ = self.imp("model/delta_missing_parent.json")
        self.assertEqual((st, orphan["outcome"]), (409, "quarantined_missing_parent"))
        st, late, _ = self.imp("model/late_revision_based_on_A.json")
        self.assertEqual((st, late["outcome"]), (409, "rejected_stale_base"))
        self.assertEqual(self.heads()["synthmodeler"], head)
        # Explicit reconciliation is guarded by the expected head.
        st, body, _ = self.carol.post(f"/manage/imports/{late['import_id']}/reconcile",
                                      {"action": "accept_as_head", "expected_head": "7c1e9a"})
        self.assertEqual(st, 412)
        st, body, _ = self.carol.post(f"/manage/imports/{late['import_id']}/reconcile",
                                      {"action": "accept_as_head", "expected_head": head})
        self.assertEqual((st, body["outcome"]), (201, "accepted_head"))
        self.assertEqual(self.heads()["synthmodeler"], "late-4c2d")
        self.assertEqual(self.entity("el-GW1")["name"], "Edge Gateway North")  # content of the late snapshot
        st, again, _ = self.carol.post(f"/manage/imports/{late['import_id']}/reconcile",
                                       {"action": "accept_as_head", "expected_head": "late-4c2d"})
        self.assertEqual((st, again["error"]["code"]), (409, "already_reconciled"))

    def test_IC_duplicate_identity_inside_export_is_quarantined(self):
        st, body, _ = self.imp("model/invalid_duplicate_identity.json")
        self.assertEqual((st, body["outcome"]), (422, "quarantined_invalid"))
        self.assertIn("duplicate_identity", [d["code"] for d in body["diagnostics"]])
        self.assertIsNone(body["source_head_after"])


class Contracts(StackCase):
    def test_IC08_unit_change_is_semantic_even_when_payload_validates(self):
        self.release_a()
        for f in ["B_rename_gateway", "C_remove_serial_field", "D_unit_ms_to_s"]:
            self.ok(self.imp(f"model/{f}.json"))
        self.approve("1.1.0")
        r = self.build("1.1.0")
        self.assertEqual(r["status"], "blocked_generation")
        um = [d for d in r["diagnostics"] if d["code"] == "unit_mismatch"]
        self.assertEqual((um[0]["class"], um[0]["source_unit"], um[0]["contract_unit"]), ("semantic", "s", "ms"))
        self.assertEqual(r["source_diff_vs_active"]["semantic"][0]["change"], "unit_changed")
        v = self.checks(r["release_id"])
        run = v["consumer_test_runs"][-1]
        self.assertTrue(run["schema_check"]["passed"], "JSON Schema still validates")
        self.assertFalse(run["passed"])
        failed = [ch for p in run["results"]["profiles"] for ch in p["checks"] if not ch["passed"]]
        self.assertTrue(any("sampleIntervalMs plausible" in ch["check"] for ch in failed))
        # Explicit, reviewed conversion fixes it; provenance records the conversion.
        self.approve("1.2.0")
        r2 = self.build("1.2.0")
        self.assertEqual(r2["status"], "candidate")
        self.assertEqual(r2["manifest"]["contract"]["digest"], r["manifest"]["contract"]["digest"])
        v2 = self.checks(r2["release_id"])
        self.assertEqual(v2["status"], "tested_pass")
        item = self.ok(self.svc.get(f"/api/releases/{r2['release_id']}/resources/sensors"))["items"][0]
        self.assertEqual(item["sampleIntervalMs"], 500)
        self.assertEqual(item["_provenance"]["conversions"][0]["rule"], "s_to_ms")

    def test_IC08b_relationship_direction_change_is_surfaced(self):
        self.release_a()
        self.ok(self.imp("model/B_rename_gateway.json"))
        self.ok(self.imp("model/B2_reverse_connects_direction.json"))
        r = self.build("1.0.0")
        codes = {d["code"]: d for d in r["diagnostics"]}
        self.assertEqual(codes["relation_direction_mismatch"]["class"], "semantic")
        self.assertEqual(r["status"], "blocked_generation")

    def test_IC09_missing_instance_value_is_data_not_schema(self):
        self.release_a()
        self.ok(self.imp("model/B_rename_gateway.json"))
        self.ok(self.imp("model/B3_missing_instance_value.json"))
        r = self.build("1.0.0")
        codes = [d["code"] for d in r["diagnostics"]]
        self.assertIn("instance_value_missing", codes)
        self.assertNotIn("definition_missing", codes)
        miss = next(d for d in r["diagnostics"] if d["code"] == "instance_value_missing")
        self.assertEqual((miss["class"], miss["entity"], miss["field"]), ("data", "el-VS102DE", "serialNumber"))
        self.assertEqual(r["contract_diff_vs_active"]["changes"], [])

    def test_IC10_removed_required_definition_fails_and_active_release_stays(self):
        a = self.release_a()
        self.ok(self.imp("model/B_rename_gateway.json"))
        self.ok(self.imp("model/C_remove_serial_field.json"))
        r = self.build("1.0.0")
        dm = [d for d in r["diagnostics"] if d["code"] == "definition_missing"]
        self.assertEqual(dm[0]["source_property"], "Sensor.serialNumber")
        self.assertEqual(dm[0]["class"], "structural")
        v = self.checks(r["release_id"])
        self.assertEqual(v["status"], "blocked_generation")  # checks ran; status keeps the generation block
        self.assertFalse(v["consumer_test_runs"][-1]["passed"])
        failed = [ch["check"] for p in v["consumer_test_runs"][-1]["results"]["profiles"] for ch in p["checks"]
                  if not ch["passed"]]
        self.assertTrue(any("required fields" in f for f in failed))
        st, body, _ = self.activate(r["release_id"])
        self.assertEqual((st, body["error"]["code"]), (409, "activation_blocked"))
        self.assertEqual(self.active(), a)
        page = self.ok(self.svc.get("/api/current/ehm/resources/sensors"))
        self.assertEqual(page["releaseId"], a)
        self.assertFalse(page["source"]["isCurrentHead"])
        self.assertEqual(page["source"]["headsBehind"], 2)

    def test_IC11_new_field_needs_declared_consumer_tests(self):
        self.release_a()
        self.ok(self.carol.post("/manage/projections", self.carol.projection("equipment-health_1.3.0_bad_version.json")))
        self.approve("1.3.0")
        bad = self.build("1.3.0")
        self.assertIn("contract_version_reused_with_different_shape", [d["code"] for d in bad["diagnostics"]])
        self.approve("2.0.0")
        r = self.build("2.0.0")
        self.assertEqual(r["status"], "candidate")
        ch = r["contract_diff_vs_active"]["changes"]
        self.assertEqual([(c["change"], c["field"]) for c in ch], [("field_added", "calibrationOffset")])
        v = self.checks(r["release_id"])
        prof = {p["profile"]: p["passed"] for p in v["consumer_test_runs"][-1]["results"]["profiles"]}
        self.assertEqual(prof, {"dashboard": True, "archive-export": False})
        self.assertEqual(v["status"], "tested_fail")

    def test_IC11b_new_enum_value_is_checked_against_contract(self):
        self.release_a()
        self.ok(self.imp("model/B_rename_gateway.json"))
        self.ok(self.imp("model/B4_new_enum_value.json"))
        r = self.build("1.0.0")
        ev = next(d for d in r["diagnostics"] if d["code"] == "enum_value_outside_contract")
        self.assertEqual(ev["values"], ["acoustic"])
        v = self.checks(r["release_id"])
        self.assertFalse(v["consumer_test_runs"][-1]["schema_check"]["passed"])

    def test_hostile_projection_labels_are_rejected(self):
        st, body, _ = self.carol.post("/manage/projections", self.carol.projection("hostile_labels.json"))
        self.assertEqual((st, body["error"]["code"]), (422, "invalid_projection"))
        errs = " ".join(body["error"]["details"]["errors"])
        self.assertIn("resource name", errs)
        self.assertIn("'from' must be", errs)

    def test_unreviewed_projection_cannot_be_built(self):
        self.ok(self.imp("model/A_initial.json"))
        st, body, _ = self.carol.post("/manage/projects/ehm/releases", {"projection_id": "equipment-health",
                                                                        "version": "1.1.0"})
        self.assertEqual((st, body["error"]["code"]), (409, "projection_not_reviewed"))

    def test_pagination_stays_on_the_selected_release(self):
        a = self.release_a()
        page = self.ok(self.svc.get("/api/current/ehm/resources/sensors?limit=2"))
        self.assertTrue(page["next"].startswith(f"/api/releases/{a}/"))
        self.ok(self.imp("model/B_rename_gateway.json"))
        r = self.build("1.0.0"); self.checks(r["release_id"]); self.ok(self.activate(r["release_id"]))
        page2 = self.ok(self.svc.get(page["next"]))
        self.assertEqual(page2["releaseId"], a)
        self.assertEqual(len(page["items"]) + len(page2["items"]), 4)


class Links(StackCase):
    def _setup(self):
        self.release_a()
        return self.proposals()

    def test_IC12_permission_revoked_between_proposal_and_commit(self):
        run = self._setup()
        p = self.find_prop(run, "MR-1001", "el-VS101DE")
        self.ok(self.admin.post("/manage/grants", {"user": "alice", "project": "ehm", "permission": "link:approve",
                                                   "action": "revoke"}))
        st, body, _ = self.accept(p)
        self.assertEqual((st, body["error"]["code"]), (403, "forbidden"))
        self.assertEqual(self.ok(self.alice.get("/api/projects/ehm/links"))["links"], [])
        st, body, _ = self.accept(p, who=self.bob)  # viewer never had it
        self.assertEqual(st, 403)

    def test_IC13_stale_etag_and_changed_source_require_new_review(self):
        run = self._setup()
        p = self.find_prop(run, "MR-1004", "el-GW1")
        st, body, _ = self.accept(p, etag='"not-the-etag"')
        self.assertEqual((st, body["error"]["code"]), (412, "precondition_failed"))
        st, body, _ = self.alice.post(f"/manage/proposals/{p['proposal_id']}/decision",
                                      {"decision": "accept", "reason": "x", "expected_model_revision": "7c1e9a",
                                       "expected_record_revision": "m-20260901"})
        self.assertEqual(st, 428)
        self.ok(self.imp("model/B_rename_gateway.json"))  # gateway renamed after the proposal
        st, body, _ = self.accept(p)  # client still holds the old view
        self.assertEqual((st, body["error"]["code"]), (409, "stale_dependency"))
        self.assertIn("target_version_changed", body["error"]["details"]["issues"])
        self.assertEqual(self.ok(self.alice.get("/api/projects/ehm/links"))["links"], [])
        cur = self.ok(self.alice.get(f"/api/proposals/{p['proposal_id']}"))
        self.assertEqual(cur["disposition"], "stale_needs_review")
        st, reb, _ = self.alice.post(f"/manage/proposals/{p['proposal_id']}/rebase", headers={"If-Match": cur["etag"]})
        self.assertEqual(st, 201)
        newp = self.ok(self.alice.get(f"/api/proposals/{reb['proposal_id']}"))
        self.assertEqual(newp["freshness"]["status"], "current")
        self.assertEqual(newp["disposition"], "unresolved")
        res = self.ok(self.accept(newp, reason="Record says 'Edge gateway north'; GW1 is the only north gateway."))
        self.assertEqual(res["authority"], "reviewer_accepted")

    def test_IC13b_deleted_target_cannot_be_rebased(self):
        self.ok(self.imp("model/A_initial.json"))
        run = self.proposals()
        p = self.find_prop(run, "MR-1003", "el-VS101NDE")
        for f in ["B_rename_gateway", "C_remove_serial_field", "D_unit_ms_to_s", "E_replace_sensor"]:
            self.ok(self.imp(f"model/{f}.json"))
        cur = self.ok(self.alice.get(f"/api/proposals/{p['proposal_id']}"))
        self.assertIn("target_deleted_or_absent", cur["freshness"]["issues"])
        st, body, _ = self.alice.post(f"/manage/proposals/{p['proposal_id']}/rebase", headers={"If-Match": cur["etag"]})
        self.assertEqual((st, body["error"]["code"]), (409, "target_deleted"))

    def test_IC14_concurrent_head_update_during_acceptance(self):
        outcomes = set()
        for i in range(6):
            self.tearDown(); self.setUp()
            run = self._setup()
            p = self.find_prop(run, "MR-1001", "el-VS101DE")
            res = {}
            t1 = threading.Thread(target=lambda: res.__setitem__("accept", self.accept(p)))
            t2 = threading.Thread(target=lambda: res.__setitem__("import", self.imp("model/B_rename_gateway.json")))
            for t in ((t1, t2) if i % 2 else (t2, t1)):
                t.start()
            t1.join(); t2.join()
            self.assertEqual(res["import"][0], 201)
            links = self.ok(self.alice.get("/api/projects/ehm/links"))["links"]
            if res["accept"][0] == 200:
                self.assertEqual(len(links), 1)
                # committed while A was head: the audit shows accept before head advance
                outcomes.add("accept_then_import")
            else:
                self.assertEqual(res["accept"][1]["error"]["code"], "stale_dependency")
                self.assertEqual(links, [])
                outcomes.add("import_then_accept_rejected")
        self.assertTrue(outcomes)  # every run landed in exactly one valid ordering

    def test_IC14b_two_concurrent_accepts_one_wins(self):
        run = self._setup()
        p = self.find_prop(run, "MR-1005", "el-TS101")
        res = []
        ts = [threading.Thread(target=lambda: res.append(self.accept(p))) for _ in range(2)]
        [t.start() for t in ts]; [t.join() for t in ts]
        codes = sorted(r[0] for r in res)
        self.assertEqual(codes[0], 200)
        self.assertIn(codes[1], (409, 412))
        self.assertEqual(len(self.ok(self.alice.get("/api/projects/ehm/links"))["links"]), 1)

    def test_IC15_same_key_different_request_is_rejected(self):
        run = self._setup()
        p1 = self.find_prop(run, "MR-1001", "el-VS101DE")
        p2 = self.find_prop(run, "MR-1005", "el-TS101")
        self.ok(self.accept(p1, key="op-123"))
        st, body, _ = self.accept(p2, key="op-123")
        self.assertEqual((st, body["error"]["code"]), (422, "idempotency_key_mismatch"))
        self.assertEqual(len(self.ok(self.alice.get("/api/projects/ehm/links"))["links"]), 1)

    def test_IC16a_lost_http_ack_retry_returns_prior_result(self):
        run = self._setup()
        p = self.find_prop(run, "MR-1001", "el-VS101DE")
        st1, b1, h1 = self.accept(p, key="accept-mr1001")
        st2, b2, h2 = self.accept(p, key="accept-mr1001")  # client never saw the first answer
        self.assertEqual((st1, st2), (200, 200))
        self.assertEqual(b1["link_id"], b2["link_id"])
        self.assertEqual(h2.get("Idempotent-Replay"), "true")
        self.assertEqual(len(self.ok(self.alice.get("/api/projects/ehm/links"))["links"]), 1)
        events = [e for e in self.ok(self.alice.get("/api/projects/ehm/history"))["outbox"] if e["type"] == "link.accepted"]
        self.assertEqual(len(events), 1)
        # A caller who lost read access cannot replay to see the result.
        self.ok(self.admin.post("/manage/grants", {"user": "alice", "project": "ehm", "permission": "read",
                                                   "action": "revoke"}))
        st3, _, _ = self.accept(p, key="accept-mr1001")
        self.assertEqual(st3, 404)

    def test_IC18_forged_instructions_and_invalid_citations_gain_no_authority(self):
        run = self._setup()
        by = {(p["record"]["id"], (p["target"] or {}).get("source_id")): p for p in run["proposals"]}
        forged = next(p for p in run["proposals"] if p["record"]["id"] == "MR-1006" and p["target"] is None
                      and p["validation"] == "reference_outside_permitted_set")
        notes = {n["code"] for n in forged["validation_notes"]}
        self.assertIn("ignored_model_field", notes)
        self.assertIn("target_not_in_permitted_elements", notes)
        self.assertEqual(by[("MR-1001", "el-GW1")]["validation"], "invalid_citation")
        self.assertEqual(by[("MR-1002", "el-P101")]["validation"], "unsupported_predicate")
        for bad in (forged, by[("MR-1001", "el-GW1")]):
            st, body, _ = self.accept(bad)
            self.assertEqual((st, body["error"]["code"]), (409, "not_acceptable"))
        grants = self.ok(self.alice.get("/api/whoami"))["grants"]
        self.assertNotIn("mallory", json.dumps(grants))
        st, _, _ = Client(self.stack.wb_url, "demo-mallory").get("/api/whoami")
        self.assertEqual(st, 401)
        self.assertEqual(self.ok(self.alice.get("/api/projects/ehm/links"))["links"], [])

    def test_ambiguous_candidates_are_flagged_and_resolved_by_review(self):
        run = self._setup()
        de = self.find_prop(run, "MR-1003", "el-VS101DE")
        nde = self.find_prop(run, "MR-1003", "el-VS101NDE")
        for p in (de, nde):
            self.assertIn("competing_candidates_for_record", {n["code"] for n in p["validation_notes"]})
        self.assertEqual(nde["evidence"][1]["record_id"], "N-2")
        self.ok(self.alice.post(f"/manage/proposals/{de['proposal_id']}/decision",
                                {"decision": "reject", "reason": "N-2 says the NDE unit was recalibrated."},
                                headers={"If-Match": de["etag"]}))
        self.ok(self.accept(nde, reason="N-2: recalibration was on the NDE unit (serial ending 4472)."))
        links = self.ok(self.alice.get("/api/projects/ehm/links"))["links"]
        self.assertEqual([l["target_source_id"] for l in links], ["el-VS101NDE"])
        rejected = self.ok(self.alice.get(f"/api/proposals/{de['proposal_id']}"))
        self.assertEqual(rejected["disposition"], "rejected")  # retained for evaluation

    def test_live_mode_failure_is_visible_and_not_replaced_by_fixture(self):
        self.release_a()
        run = self.proposals(mode="live")
        self.assertEqual(run["status"], "failed")
        self.assertTrue(run["error"])
        self.assertEqual(run["proposals"], [])


class Delivery(StackCase):
    def test_IC16b_lost_ack_after_consumer_commit_yields_one_effect(self):
        self.ok(self.imp("model/A_initial.json"))
        r = self.build("1.0.0"); self.checks(r["release_id"])
        self.deliver_all()
        self.ok(self.consumer.post("/faults", {"drop_ack_after_commit": 1}))
        act = self.ok(self.activate(r["release_id"]))
        eid = act["event"]["event_id"]
        first = self.stack.app.worker.deliver_pass(force=True)
        self.assertEqual(first[0]["outcome"], "no_acknowledgment")
        second = self.stack.app.worker.deliver_pass(force=True)
        self.assertEqual(second[0]["outcome"], "acknowledged")
        s = self.cstate()
        self.assertEqual(s["effect_count_by_event"][eid], 1)
        rec = next(e for e in s["received_events"] if e["event_id"] == eid)
        self.assertEqual(rec["deliveries"], 2)
        self.assertEqual(s["stream"]["pinned_release"], r["release_id"])

    def test_IC17_duplicate_older_and_gapped_events(self):
        a = self.release_a()
        self.deliver_all()
        s0 = self.cstate()
        hist = self.ok(self.carol.get("/api/projects/ehm/history"))["outbox"]
        act_ev = next(e for e in hist if e["type"] == "release.activated")
        dup = self.ok(self.carol.post(f"/manage/outbox/{act_ev['event_id']}/redeliver"))
        self.assertEqual(dup["outcome"]["outcome"], "acknowledged")
        s1 = self.cstate()
        self.assertEqual(s1["effect_count_by_event"][act_ev["event_id"]], 1)
        self.assertEqual(len(s1["effects"]), len(s0["effects"]))
        # An older event with a new ID must not roll the consumer back.
        old = {"event_id": "evt_forged_old", "project": "ehm", "seq": 1, "type": "release.activated",
               "payload": {"release_id": "rel_old"}}
        st, body, _ = self.consumer.post("/events", old)
        self.assertEqual(body["handling"], "stale_ignored")
        self.assertEqual(self.cstate()["stream"]["pinned_release"], a)
        # A gap forces resynchronization from the pinned active release.
        self.ok(self.imp("model/B_rename_gateway.json"))
        r = self.build("1.0.0"); self.checks(r["release_id"]); self.ok(self.activate(r["release_id"]))
        hist = self.ok(self.carol.get("/api/projects/ehm/history"))["outbox"]
        last = max(hist, key=lambda e: e["seq"])
        body = {"event_id": last["event_id"], "project": "ehm", "seq": last["seq"], "type": last["type"],
                "payload": last["payload"]}
        st, out, _ = self.consumer.post("/events", body)  # skip the intermediate events
        self.assertEqual(out["handling"], "gap_resync")
        s2 = self.cstate()
        self.assertEqual(s2["stream"]["pinned_release"], r["release_id"])
        self.assertEqual(s2["stream"]["resyncs"], 1)
        self.deliver_all()  # the skipped events now arrive late: acknowledged, ignored
        s3 = self.cstate()
        self.assertEqual(s3["stream"]["pinned_release"], r["release_id"])
        self.assertTrue(all(v == 1 for v in s3["effect_count_by_event"].values()))

    def test_IC19_failed_activation_and_rollback_keep_current_permissions(self):
        a = self.release_a()
        self.ok(self.imp("model/B_rename_gateway.json"))
        b = self.build("1.0.0"); self.checks(b["release_id"]); self.ok(self.activate(b["release_id"]))
        self.ok(self.imp("model/C_remove_serial_field.json"))
        c = self.build("1.0.0"); self.checks(c["release_id"])
        st, body, _ = self.activate(c["release_id"])
        self.assertEqual(st, 409)
        self.assertEqual(self.active(), b["release_id"])
        self.ok(self.admin.post("/manage/grants", {"user": "bob", "project": "ehm", "permission": "read",
                                                   "action": "revoke"}))
        st, body, _ = self.carol.post("/manage/projects/ehm/rollback",
                                      {"expected_active_release_id": b["release_id"], "reason": "test rollback"})
        self.assertEqual((st, body["active_release_id"]), (200, a))
        page = self.ok(self.svc.get("/api/current/ehm/resources/gateways"))
        self.assertEqual(page["source"]["revision"], "7c1e9a")
        self.assertFalse(page["source"]["isCurrentHead"])
        self.assertEqual(page["source"]["headRevision"], "31d8e0")  # newer imports were not erased
        st, _, _ = self.bob.get("/api/current/ehm/resources/gateways")
        self.assertEqual(st, 404)  # revoked permission stays revoked after rollback

    def test_restart_persists_state_and_delivers_pending_events(self):
        a = self.release_a()
        var = self.var
        self.stack.close()
        from lucidwb.stack import Stack
        self.stack = Stack(var, wb_port=0, consumer_port=0, start_worker=False)
        c = Client(self.stack.wb_url, "demo-svc-consumer")
        page = self.ok(c.get("/api/current/ehm/resources/sensors"))
        self.assertEqual(page["releaseId"], a)
        self.consumer = Client(self.stack.consumer_url, None)
        outs = self.deliver_all()
        self.assertTrue(any(o["type"] == "release.activated" for o in outs))
        self.assertEqual(self.cstate()["stream"]["pinned_release"], a)


class Metamorphic(StackCase):
    def test_reordered_rows_and_whitespace_are_the_same_revision(self):
        import pathlib
        from scripts.client import FIX
        self.ok(self.imp("model/A_initial.json"))
        doc = json.loads((FIX / "model/A_initial.json").read_text())
        doc["elements"].reverse(); doc["relationships"].reverse()
        st, body, _ = self.carol.post("/manage/projects/ehm/imports", raw=json.dumps(doc).encode())
        self.assertEqual((st, body["outcome"]), (200, "duplicate_no_change"))

    def test_unrelated_permitted_note_does_not_change_established_links(self):
        self.release_a()
        run = self.proposals()
        self.ok(self.accept(self.find_prop(run, "MR-1001", "el-VS101DE")))
        from scripts.client import FIX
        doc = json.loads((FIX / "records/cmms_main.json").read_text())
        doc["revision"], doc["parent_revision"] = "m-20260902", "m-20260901"
        doc["records"].append({"id": "N-9", "kind": "note", "asset_ref": None, "text": "Coffee machine descaled."})
        self.ok(self.carol.post("/manage/projects/ehm/imports", raw=json.dumps(doc).encode()), 201)
        links = self.ok(self.alice.get("/api/projects/ehm/links"))["links"]
        self.assertEqual([(l["target_source_id"], l["status"], l["current_target_status"]) for l in links],
                         [("el-VS101DE", "active", "target_present")])

    def test_unrecognized_content_is_preserved_but_not_exposed(self):
        self.release_a()
        gw = self.entity("el-GW1")
        self.assertEqual(gw["unrecognized_keys"], ["properties"])
        diag = self.entity("el-DIAG1")
        self.assertIn("x-vendor-geometry", diag["unrecognized_keys"])
        page = self.ok(self.svc.get("/api/current/ehm/resources/gateways"))
        self.assertNotIn("x_cableColor", json.dumps(page))
        imports = self.ok(self.carol.get("/api/projects/ehm/imports"))["imports"]
        a = next(i for i in imports if i["revision"] == "7c1e9a")
        codes = {d["code"] for d in a["diagnostics"]}
        self.assertTrue({"unknown_element_type", "unrecognized_property", "unrecognized_top_level_key"} <= codes)

    def test_null_empty_zero_and_missing_stay_distinct(self):
        self.release_a()
        items = {i["sourceId"]: i for i in self.ok(self.svc.get("/api/current/ehm/resources/sensors"))["items"]}
        self.assertIsNone(items["el-TS101"]["mountPosition"])
        self.assertEqual(items["el-VS102DE"]["mountPosition"], "")
        self.assertEqual(self.entity("el-VS101DE")["properties"]["calibrationOffset"], 0)
        self.assertNotIn("calibrationOffset", self.entity("el-VS101NDE")["properties"])
