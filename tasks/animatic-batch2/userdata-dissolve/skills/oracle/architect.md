---
kind: advisory
triggers: design a component, where should this live, architecture
---
Think about component responsibilities and good architecture — DDD-style reasoning that adapts to the codebase rather than following a rigid procedure.

# oracle:architect

Purpose: give design guidance on responsibilities, module boundaries, and seams.

## Approach
- Consider what each component is responsible for and what it hides.
- Prefer small interfaces over large ones; hide real complexity behind them.
- Name modules after the domain concept; keep one concept in one module.
- Note where a seam (an injected dependency) would make logic testable.
- Adapt the advice to the actual codebase — don't force a pattern that doesn't fit.

Use sparingly and concretely: point at the specific code being discussed.
