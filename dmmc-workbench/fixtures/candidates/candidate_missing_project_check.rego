# Simulated model-generated candidate (fixture). Plausible-looking but omits the
# cross-project rule (R3) and the revoked-subject rule (R4). Quarantined: it is only
# ever evaluated against the independent tests in a temporary directory.
package mtel.authz

grants := {"operator": {"read"}, "maintainer": {"read", "write"}}

default decision := {"allow": false, "reasons": ["default-deny"]}

decision := {"allow": true, "reasons": ["granted"]} if {
	input.resource.type == "telemetry"
	input.action in grants[input.subject.role]
	not locked_write
}

locked_write if {
	input.action == "write"
	input.resource.locked == true
}
