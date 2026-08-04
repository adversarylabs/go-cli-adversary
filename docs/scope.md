# go/cli — mission and scope

Source of truth for what this adversary is *for*.

- **Package:** `go-cli`
- **Factory routing:** human PR comments are attributed to this adversary only when they match **In scope**.
- **Languages / surfaces:** Go CLI

## Mission

Review Go CLIs for configuration, cancellation, diagnostics, and exit behavior.

## In scope (fair miss if humans raised it and we did not)

- Flag/env config predictability
- Signal/cancellation handling in CLIs
- Exit codes and user-visible diagnostics
- Context plumbing in command handlers

## Out of scope (not a miss for this adversary)

- Library-only concurrency without CLI surface
- Non-Go

## Factory grading rule

- **In scope + human raised it + this adversary did not surface it** → real miss → suggested issue for **this** package
- **Out of scope** → do not grade as a miss for this adversary
- **Better fit for another adversary** → route there; do not double-count as a miss here
- **Unclear** → prefer out-of-scope for grading
