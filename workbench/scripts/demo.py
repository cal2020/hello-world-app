"""Five-minute demonstration, scripted against the real HTTP API.

  .venv/bin/python scripts/run.py --reset      # terminal 1
  .venv/bin/python scripts/demo.py --pause     # terminal 2 (Enter between steps)

Without a running stack, `--self-host` starts a private stack in a temp dir (used to record
examples/demo_transcript.txt). The UI at http://127.0.0.1:8780/ shows the same state.
"""
import argparse
import json
import pathlib
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from scripts.client import Client  # noqa: E402
from scripts.seed import seed  # noqa: E402

OUT = []


def say(*a):
    line = " ".join(str(x) for x in a)
    OUT.append(line)
    print(line)


def step(title, pause):
    if pause:
        input("\n[Enter] ")
    say("\n" + "=" * 78 + f"\n{title}\n" + "=" * 78)


def must(resp, *codes):
    st, body, hdr = resp
    if codes and st not in codes:
        say(f"  !! unexpected HTTP {st}: {json.dumps(body)[:400]}")
        raise SystemExit(1)
    return st, body, hdr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8780")
    ap.add_argument("--pause", action="store_true")
    ap.add_argument("--self-host", action="store_true")
    ap.add_argument("--export", help="directory to write example artifacts and the transcript")
    a = ap.parse_args()
    stack = None
    if a.self_host:
        from lucidwb.stack import Stack
        import os
        os.environ["LWB_QUIET"] = "1"
        stack = Stack(tempfile.mkdtemp(prefix="lwb-demo-"), wb_port=0, consumer_port=0)
        a.base = stack.wb_url
    carol, alice = Client(a.base, "demo-carol"), Client(a.base, "demo-alice")
    svc = Client(a.base, "demo-svc-consumer")
    cons = Client(a.base + "/consumer", None)  # consumer dashboard state, proxied by the workbench

    def wait_consumer(pred, timeout=8):
        end = time.time() + timeout
        while time.time() < end:
            s = must(cons.get("/state"), 200)[1]
            if pred(s):
                return s
            time.sleep(0.3)
        return must(cons.get("/state"), 200)[1]

    step("0. Baseline: projections registered (1.0.0 reviewed), CMMS records imported", a.pause)
    seed(a.base)
    say("  simulated identities: carol=release manager, alice=reviewer/approver (not production auth)")

    step("1. Import model A -> build contract -> consumer checks -> activate -> consumer reads HTTP", a.pause)
    _, imp, _ = must(carol.import_fixture("model/A_initial.json"), 201)
    say(f"  import {imp['import_id']}: {imp['outcome']}  revision={imp['revision']}  counts={imp['counts']}")
    say(f"  warnings kept, not flattened: {sorted({d['code'] for d in imp['diagnostics']})}")
    _, rel_a, _ = must(carol.post("/manage/projects/ehm/releases", {"projection_id": "equipment-health", "version": "1.0.0"}), 201)
    say(f"  candidate {rel_a['release_id']} status={rel_a['status']} contract={rel_a['manifest']['contract']['digest'][:12]}")
    _, v, _ = must(carol.post(f"/manage/releases/{rel_a['release_id']}/consumer-checks"), 200)
    run = v["consumer_test_runs"][-1]
    say(f"  consumer checks: {v['status']}  profiles={[(p['profile'], p['passed']) for p in run['results']['profiles']]}  schema={run['schema_check']['passed']}")
    _, act, _ = must(carol.post(f"/manage/releases/{rel_a['release_id']}/activate",
                                {"expected_active_release_id": None, "reason": "initial release"}), 200)
    say(f"  activated pointer_seq={act['pointer_seq']}  outbox event seq={act['event']['seq']}")
    _, page, hdr = must(svc.get("/api/current/ehm/resources/sensors?limit=2"), 200)
    say(f"  GET /api/current/ehm/resources/sensors -> releaseId={page['releaseId']} source={page['source']}")
    say(f"    next (pinned to the same release): {page['next']}")
    it = page["items"][0]
    say(f"    item: {it['sourceId']} id={it['id']} sampleIntervalMs={it['sampleIntervalMs']} provenance.revision={it['_provenance']['sourceRevision']}")
    s = wait_consumer(lambda s: (s["stream"] or {}).get("pinned_release") == rel_a["release_id"])
    say(f"  consumer pinned_release={s['stream']['pinned_release']} revision={s['stream']['pinned_revision']} sensors={len(s['sensors'])}")

    step("2. Import A again: identical revision and content", a.pause)
    _, again, _ = must(carol.import_fixture("model/A_initial.json"), 200)
    say(f"  outcome={again['outcome']} duplicate_of={again['duplicate_of']} (original receipt retained)")
    say(f"  counts unchanged: {again['counts'] == imp['counts']}  -> {again['counts']}")

    step("3. Propose links; inspect evidence; resolve an ambiguous candidate; bind review to exact revisions", a.pause)
    _, det, _ = must(alice.post("/manage/projects/ehm/proposal-runs", {"method": "deterministic"}), 201)
    say(f"  deterministic baseline: {len(det['proposals'])} candidates "
        f"{[(p['record']['id'], p['target']['source_id']) for p in det['proposals']]}")
    _, fx, _ = must(alice.post("/manage/projects/ehm/proposal-runs", {"method": "model", "mode": "fixture"}), 201)
    say(f"  {fx['label']}")
    for p in fx["proposals"]:
        tgt = (p["target"] or {}).get("source_id")
        say(f"    {p['record']['id']:8} -> {str(tgt):14} validation={p['validation']:32} conf={p['confidence']}")
    amb = [p for p in fx["proposals"] if p["record"]["id"] == "MR-1003"]
    de = next(p for p in amb if p["target"]["source_id"] == "el-VS101DE")
    nde = next(p for p in amb if p["target"]["source_id"] == "el-VS101NDE")
    for e in nde["evidence"]:
        say(f"    MR-1003/NDE evidence {e['record_id']}[{e['start']}:{e['end']}] \"{e['quote']}\" valid={e['valid']}")
    must(alice.post(f"/manage/proposals/{de['proposal_id']}/decision",
                    {"decision": "reject", "reason": "N-2 says the NDE unit was recalibrated."},
                    headers={"If-Match": de["etag"]}), 200)
    fr = nde["freshness"]
    _, acc, _ = must(alice.post(f"/manage/proposals/{nde['proposal_id']}/decision",
                                {"decision": "accept", "reason": "N-2: NDE unit, serial ending 4472.",
                                 "expected_model_revision": fr["model_head"], "expected_record_revision": fr["record_head"]},
                                headers={"If-Match": nde["etag"], "Idempotency-Key": "demo-accept-mr1003"}), 200)
    say(f"  accepted MR-1003 -> el-VS101NDE as {acc['authority']} link {acc['link_id']} "
        f"(bound to model {fr['model_head']} / records {fr['record_head']}); DE candidate rejected and retained")
    gw = next(p for p in fx["proposals"] if p["record"]["id"] == "MR-1004")
    say(f"  MR-1004 -> el-GW1 left open for review (etag {gw['etag']})")

    step("4. Import B (rename) and C (field removed); stale write rejected; incompatible candidate blocked", a.pause)
    ent_before = next(e for e in must(carol.get(f"/api/projects/ehm/snapshots/{imp['snapshot_id']}/elements"), 200)[1]["elements"]
                      if e["source_id"] == "el-GW1")
    _, b, _ = must(carol.import_fixture("model/B_rename_gateway.json"), 201)
    ent_after = next(e for e in must(carol.get(f"/api/projects/ehm/snapshots/{b['snapshot_id']}/elements"), 200)[1]["elements"]
                     if e["source_id"] == "el-GW1")
    say(f"  B: '{ent_before['name']}' -> '{ent_after['name']}'  same entity_uid: {ent_before['entity_uid'] == ent_after['entity_uid']} "
        f"({ent_after['entity_uid']}); logical entities still {b['counts']['total_logical_entities_in_project']}")
    st, body, _ = alice.post(f"/manage/proposals/{gw['proposal_id']}/decision",
                             {"decision": "accept", "reason": "Edge gateway north = GW1",
                              "expected_model_revision": gw["freshness"]["model_head"],
                              "expected_record_revision": gw["freshness"]["record_head"]},
                             headers={"If-Match": gw["etag"], "Idempotency-Key": "demo-accept-mr1004"})
    say(f"  accept MR-1004 approved against revision {gw['freshness']['model_head']}: HTTP {st} {body['error']['code']} "
        f"issues={body['error']['details']['issues']}")
    _, c, _ = must(carol.import_fixture("model/C_remove_serial_field.json"), 201)
    _, rel_c, _ = must(carol.post("/manage/projects/ehm/releases", {"projection_id": "equipment-health", "version": "1.0.0"}), 201)
    blocking = [(d["code"], d["class"], d.get("source_property") or d.get("field")) for d in rel_c["diagnostics"]]
    say(f"  C candidate {rel_c['release_id']} status={rel_c['status']} diagnostics={blocking[:2]}")
    say(f"  source diff vs active: structural={[x['change']+':'+x.get('property','') for x in rel_c['source_diff_vs_active']['structural']]}")
    _, vc, _ = must(carol.post(f"/manage/releases/{rel_c['release_id']}/consumer-checks"), 200)
    fails = [ch["check"] + " " + ch["detail"] for p in vc["consumer_test_runs"][-1]["results"]["profiles"] for ch in p["checks"] if not ch["passed"]]
    say(f"  consumer checks failed ({len(fails)}), e.g. {fails[0]}")
    st, body, _ = carol.post(f"/manage/releases/{rel_c['release_id']}/activate",
                             {"expected_active_release_id": rel_a["release_id"], "reason": "try"})
    say(f"  activate -> HTTP {st} {body['error']['code']} problems={[p['code'] for p in body['error']['details']['problems']]}")
    _, page, _ = must(svc.get("/api/current/ehm/resources/sensors"), 200)
    say(f"  consumer still served {page['releaseId']} revision={page['source']['revision']} "
        f"isCurrentHead={page['source']['isCurrentHead']} headsBehind={page['source']['headsBehind']}")

    step("5. Explicit compatible projection 1.1.0 -> retest -> activate; lost ack after consumer commit", a.pause)
    must(carol.post("/manage/projections/equipment-health/1.1.0/review",
                    {"decision": "approve", "reason": "Map serialNumber to renamed assetSerial; shape unchanged."}), 200)
    _, rel_d, _ = must(carol.post("/manage/projects/ehm/releases", {"projection_id": "equipment-health", "version": "1.1.0"}), 201)
    say(f"  candidate {rel_d['release_id']} status={rel_d['status']} contract digest unchanged: "
        f"{rel_d['manifest']['contract']['digest'] == rel_a['manifest']['contract']['digest']}  contract diff={rel_d['contract_diff_vs_active']['changes']}")
    _, vd, _ = must(carol.post(f"/manage/releases/{rel_d['release_id']}/consumer-checks"), 200)
    say(f"  consumer checks: {vd['status']}")
    for _ in range(10):  # flush anything already queued so the fault hits the activation event
        if not must(carol.post("/manage/outbox/deliver"), 200)[1]["outcomes"]:
            break
    must(carol.post("/manage/outbox/pause"), 200)
    must(carol.post("/manage/consumer/faults", {"drop_ack_after_commit": 1}), 200)
    _, act, _ = must(carol.post(f"/manage/releases/{rel_d['release_id']}/activate",
                                {"expected_active_release_id": rel_a["release_id"], "reason": "C with compatible projection"},
                                headers={"Idempotency-Key": "demo-activate-c"}), 200)
    eid = act["event"]["event_id"]
    say(f"  activated {rel_d['release_id']}; event {eid} seq={act['event']['seq']}")
    for i in range(6):
        outs = must(carol.post("/manage/outbox/deliver"), 200)[1]["outcomes"]
        for o in outs:
            say(f"    delivery seq={o['seq']} {o['type']:22} attempt={o['attempt']} -> {o['outcome']}")
        if any(o["event_id"] == eid and o["outcome"] == "acknowledged" for o in outs):
            break
    must(carol.post("/manage/outbox/resume"), 200)
    s = must(cons.get("/state"), 200)[1]
    rec = next(e for e in s["received_events"] if e["event_id"] == eid)
    say(f"  consumer: deliveries of {eid}={rec['deliveries']}  committed effects={s['effect_count_by_event'][eid]}  "
        f"pinned_release={s['stream']['pinned_release']} revision={s['stream']['pinned_revision']}")
    _, page, _ = must(svc.get("/api/current/ehm/resources/sensors?limit=1"), 200)
    say(f"  current -> {page['releaseId']} revision={page['source']['revision']} isCurrentHead={page['source']['isCurrentHead']} "
        f"serialNumber={page['items'][0]['serialNumber']}")
    st, rep, hdr = carol.post(f"/manage/releases/{rel_d['release_id']}/activate",
                              {"expected_active_release_id": rel_a["release_id"], "reason": "C with compatible projection"},
                              headers={"Idempotency-Key": "demo-activate-c"})
    say(f"  client retry of the activation with the same key -> HTTP {st} Idempotent-Replay={hdr.get('Idempotent-Replay')} pointer_seq={rep['pointer_seq']}")

    if a.export:
        d = pathlib.Path(a.export); d.mkdir(parents=True, exist_ok=True)
        (d / "openapi_equipment-health-api_v1.json").write_text(json.dumps(
            must(carol.get(f"/api/releases/{rel_d['release_id']}/openapi.json"), 200)[1], indent=2) + "\n")
        (d / "release_manifest_example.json").write_text(json.dumps(
            must(carol.get(f"/api/releases/{rel_d['release_id']}"), 200)[1]["manifest"], indent=2) + "\n")
        (d / "blocked_release_C_view.json").write_text(json.dumps(
            must(carol.get(f"/api/releases/{rel_c['release_id']}"), 200)[1], indent=2) + "\n")
        (d / "sensors_response_example.json").write_text(json.dumps(
            must(svc.get("/api/current/ehm/resources/sensors?limit=2"), 200)[1], indent=2) + "\n")
        (d / "demo_transcript.txt").write_text(
            "RECORDED run of scripts/demo.py --self-host (not a live run). Synthetic data.\n" + "\n".join(OUT) + "\n")
    if stack:
        stack.close()


if __name__ == "__main__":
    main()
