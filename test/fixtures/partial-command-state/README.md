# partial-command-state

Vulnerable: install promises no state changes on failure, commits an installation row reserving a unique name, then separately updates a reference; reference conflict returns error without rollback, and a retry rejects the reserved name. Cite the promise, both writes, and retry failure.
Clean: content-addressed download cache survives a failed reference update by design; retry reuses content and binds the ref safely. Do not delete shared blobs, and do not report the mere existence of a write before an error.

These are review-policy calibration cases, not a measured model-recall claim.
