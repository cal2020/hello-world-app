# Independent cases written from requirements.md (R1-R7), not derived from authz.rego.
package mtel.authz_test

import data.mtel.authz

base := {
	"subject": {"id": "u1", "role": "operator", "project": "proj-mtel", "revoked": false},
	"action": "read",
	"resource": {"type": "telemetry", "project": "proj-mtel", "locked": false},
}

with_role(role) := object.union(base, {"subject": object.union(base.subject, {"role": role})})

req(role, action) := object.union(with_role(role), {"action": action})

# R1
test_operator_read_allowed if authz.decision.allow with input as req("operator", "read")

# R2
test_maintainer_read_allowed if authz.decision.allow with input as req("maintainer", "read")

test_maintainer_write_allowed if authz.decision.allow with input as req("maintainer", "write")

# R7 wrong role / unknown role / unknown action / wrong resource type
test_operator_write_denied if not authz.decision.allow with input as req("operator", "write")

test_provider_integration_write_denied if not authz.decision.allow with input as req("provider-integration", "write")

test_unknown_action_denied if not authz.decision.allow with input as req("maintainer", "delete")

test_wrong_resource_type_denied if {
	r := object.union(req("maintainer", "read"), {"resource": {"type": "audit-log", "project": "proj-mtel", "locked": false}})
	not authz.decision.allow with input as r
}

# R3
test_cross_project_denied if {
	r := object.union(req("maintainer", "read"), {"resource": {"type": "telemetry", "project": "proj-other", "locked": false}})
	not authz.decision.allow with input as r
	"cross-project" in authz.decision.reasons with input as r
}

# R4
test_revoked_subject_denied if {
	r := object.union(req("maintainer", "read"), {"subject": {"id": "u1", "role": "maintainer", "project": "proj-mtel", "revoked": true}})
	not authz.decision.allow with input as r
}

# R5 explicit deny precedence over a grant
test_locked_write_denied_for_maintainer if {
	r := object.union(req("maintainer", "write"), {"resource": {"type": "telemetry", "project": "proj-mtel", "locked": true}})
	not authz.decision.allow with input as r
	"explicit-deny:locked-resource" in authz.decision.reasons with input as r
}

test_locked_read_still_allowed if {
	r := object.union(req("operator", "read"), {"resource": {"type": "telemetry", "project": "proj-mtel", "locked": true}})
	authz.decision.allow with input as r
}

# R6 missing attributes
test_missing_role_denied if {
	r := {"subject": {"id": "u1", "project": "proj-mtel", "revoked": false}, "action": "read", "resource": base.resource}
	not authz.decision.allow with input as r
}

test_missing_resource_project_denied if {
	# built explicitly: object.union merges nested objects and would keep resource.project
	r := {"subject": base.subject, "action": "read", "resource": {"type": "telemetry", "locked": false}}
	not authz.decision.allow with input as r
}

test_missing_revoked_flag_denied if {
	r := {"subject": {"id": "u1", "role": "operator", "project": "proj-mtel"}, "action": "read", "resource": base.resource}
	not authz.decision.allow with input as r
}

test_empty_input_denied if not authz.decision.allow with input as {}
