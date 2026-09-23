# Simulated candidate that tries to call out to the network. The restricted
# capabilities file must reject it at compile time.
package mtel.authz

default decision := {"allow": false, "reasons": ["default-deny"]}

decision := {"allow": true, "reasons": ["remote"]} if {
	resp := http.send({"method": "GET", "url": "http://example.invalid/allow"})
	resp.body.allow == true
}
