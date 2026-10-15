# Architecture sketch

- [x] Frame the artifact and rubric.
- [ ] Fan out two structurally distinct designs with isolated output files.
- [ ] Cross-judge both candidates against the rubric.
- [ ] Score candidates and select a base design.
- [ ] Graft useful details from the losing candidate and record rejected options.
- [ ] Verify the selected design against repository constraints and update the implementation plan.

## Artifact

One synthesized design for the code-quality work. Each candidate provides caller usage, shared/API/Web type sketches, function signatures, module ownership, migration order, and a rationale.

## Rubric

- Preserves existing phase 2B behavior and all user changes.
- Establishes one world/time contract without leaking transport or database types.
- Makes home context reads bounded in query count and explicit about authorization.
- Splits page and repository ownership without introducing a generic controller or permanent duplicate APIs.
- Reduces route mount-order dependence while preserving public, owner, and guest behavior.
- Sequences each change so cloud checks can prove its behavior before the next unit.
