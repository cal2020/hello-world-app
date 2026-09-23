"""Seed baseline state: projections (1.0.0 approved; later versions as drafts) and CMMS records.
Does NOT import model fixture A; the demo does that live.  Usage: python scripts/seed.py [base_url]"""
import sys

sys.path.insert(0, __file__.rsplit("/scripts/", 1)[0])
from scripts.client import Client  # noqa: E402


def seed(base):
    carol = Client(base, "demo-carol")
    for f in ["equipment-health_1.0.0.json", "equipment-health_1.1.0.json", "equipment-health_1.2.0.json",
              "equipment-health_2.0.0.json"]:
        st, body, _ = carol.post("/manage/projections", carol.projection(f))
        assert st in (200, 201), body
    st, body, _ = carol.post("/manage/projections/equipment-health/1.0.0/review",
                             {"decision": "approve", "reason": "Baseline dashboard projection reviewed with consumer team."})
    assert st == 200, body
    st, body, _ = carol.import_fixture("records/cmms_main.json")
    assert st in (200, 201), body
    return body


if __name__ == "__main__":
    print(seed(sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8780"))
