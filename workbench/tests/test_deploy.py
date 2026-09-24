"""Deployment gate: access code, login cookie, health check, consumer proxy, internal calls under the gate."""
import http.client
import os
import urllib.parse

from tests.helpers import StackCase, Client

CODE = "gate-test-code"


class Gate(StackCase):
    def setUp(self):
        os.environ["LWB_ACCESS_CODE"] = CODE  # internal clients (seed, checks, consumer) send it too
        os.environ["LWB_COOKIE_SECURE"] = "0"
        super().setUp()

    def tearDown(self):
        super().tearDown()
        os.environ.pop("LWB_ACCESS_CODE", None)
        os.environ.pop("LWB_COOKIE_SECURE", None)

    def raw(self, method, path, body=None, headers=None):
        u = urllib.parse.urlparse(self.stack.wb_url)
        c = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, dict(r.getheaders()), data

    def test_without_code_everything_but_healthz_is_refused(self):
        self.assertEqual(self.raw("GET", "/healthz")[0], 200)
        st, h, _ = self.raw("GET", "/")
        self.assertEqual((st, h["Location"]), (303, "/login"))
        st, _, body = self.raw("GET", "/api/whoami", headers={"Authorization": "Bearer demo-carol"})
        self.assertEqual(st, 401)
        self.assertIn(b"access_required", body)
        st, _, _ = self.raw("POST", "/manage/projects/ehm/imports", body=b"{}",
                            headers={"Authorization": "Bearer demo-admin"})
        self.assertEqual(st, 401)
        self.assertEqual(self.raw("GET", "/consumer/state")[0], 303)

    def test_login_cookie_grants_access_and_wrong_code_does_not(self):
        st, _, _ = self.raw("POST", "/login", body=b"code=wrong",
                            headers={"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(st, 401)
        st, h, _ = self.raw("POST", "/login", body=f"code={CODE}".encode(),
                            headers={"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(st, 303)
        cookie = h["Set-Cookie"].split(";")[0]
        self.assertIn("HttpOnly", h["Set-Cookie"])
        self.assertNotIn(CODE, cookie)  # the cookie is an HMAC, not the code
        st, _, _ = self.raw("GET", "/api/whoami", headers={"Cookie": cookie, "Authorization": "Bearer demo-carol"})
        self.assertEqual(st, 200)
        st, _, body = self.raw("GET", "/consumer/", headers={"Cookie": cookie})
        self.assertEqual(st, 200)
        self.assertIn(b"mock consumer", body)
        st, _, _ = self.raw("GET", "/api/whoami", headers={"Cookie": "lwb_access=forged",
                                                           "Authorization": "Bearer demo-carol"})
        self.assertEqual(st, 401)

    def test_internal_checks_and_delivery_work_behind_the_gate(self):
        a = self.release_a()  # build -> schema check + consumer verify (both call back into the workbench)
        self.deliver_all()
        self.assertEqual(self.cstate()["stream"]["pinned_release"], a)
        self.assertEqual(self.ok(self.carol.get("/consumer/state"))["stream"]["pinned_release"], a)
