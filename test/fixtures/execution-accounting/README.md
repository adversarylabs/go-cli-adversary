# Execution accounting calibration

The model must distinguish selection, starting work, and successful completion.

Vulnerable: runner initializes Result.Selected with the full plan, then returns that result when an onStart callback fails before executing the next item. Caller reports Result.Selected to a sink whose contract counts successfully completed items, even on error. Cite the population, early return, emission and explicit sink contract together.

Clean: report Result.Completed, appended only after execution succeeds, even when a later callback fails. Preserve legitimate partial usage. Also clean: a selection metric explicitly counting the plan, a start metric counting actual starts (including failed work), or a success guard that proves the entire batch completed before reporting.

Do not infer a defect from field/function names, treat every error as zero executed work, or assume a dry-run guard establishes completion. Missing producer or sink evidence means abstain.

These fixtures exercise evidence transport and document the policy. They do not measure live-model recall or precision. Benchmark source remains external.
