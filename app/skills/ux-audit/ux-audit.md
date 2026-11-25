# UX Audit

Audit Cascade's own user interface and report usability problems as a ranked findings list. You are auditing the app you run inside, on behalf of its users: creative professionals, many of them NOT technical, who use Cascade for hours at a time to take a production from script to assembled film.

## When to run this skill

Run it when the user asks for a UX review, UI audit, usability check, heuristic evaluation, or design critique of any Cascade screen or flow - or when the user says "audit this screen" / "audit the current view."

## Two standing facts that shape every audit

1. The classic storyboard view and the node view are two views of the SAME underlying work. Anything that behaves differently between them, or is possible in one and impossible in the other without a clear reason, is a finding.
2. Cascade drives paid AI generation through outside providers (Higgsfield, OpenArt). Anywhere a click can spend the user's money or credits, unclear labeling, missing cost information, or a missing confirmation is automatically Severity 3 or higher.

## How you gather evidence

Work ONLY from screenshots of the app's real interface, viewed with view_image. Never audit from memory of what the interface probably looks like, and never invent a screen.

1. Agree the scope with the user first: which views or flow, and what the user is trying to accomplish there. If the user says "the whole app," audit ONE flow per run, in pipeline order (open/create project, script, characters, storyboard, node view for one shot, generation, review, assembly, export, Settings) and say which flow this run covers.
2. For each view in scope, capture a screenshot using the app's screenshot capability, then view_image it before writing anything about it. If you can switch views yourself, do so. If you cannot, ask the user to open the next view and tell you when it is ready - do not proceed on assumptions.
3. Cover states, not just the happy path. For each view, also try to capture: the empty state (nothing there yet - an empty or brand-new project), the working/loading state (during a generation, if one can be triggered safely WITHOUT spending credits - if it cannot, note that the state was not audited rather than spending the user's money), and any error state the user can show you. A missing or confusing state you DO observe is a finding; a state you could not observe is listed under "Not covered," never guessed at.
4. Keep each screenshot tied to its view name and state so findings can cite them (for example: "node view, project with shots, after generation").

## Audit categories

Evaluate every captured view against all six categories.

### 1. Usability heuristics (Nielsen's 10)
- Visibility of system status: does the user always know what is happening - especially during generation, which can take minutes? Progress, a way to cancel, and "what happens next" must be visible.
- Match with the real world: language a filmmaker understands, not developer or provider jargon. Model names and technical terms must be explained, or hidden behind friendly labels, where a non-technical user meets them.
- User control and freedom: undo, cancelling a running generation, and backing out of any flow without losing work.
- Consistency and standards: same action, same name, same place, everywhere - above all between classic view and node view.
- Error prevention: destructive or paid actions are confirmed or reversible; invalid inputs are caught BEFORE a paid generation starts.
- Recognition over recall: the user should not have to remember tags, prompt syntax, or which provider does what - the interface shows the options.
- Flexibility and efficiency: shortcuts and bulk actions for repeat work.
- Minimalist design: production screens are dense by nature; anything competing with the work itself needs a reason.
- Error recovery: error messages in plain language that say what happened, what was NOT lost, and what to do next - never a raw provider or system error pasted into the UI.
- Help: discoverable help at the point of confusion, not only in outside documentation.

### 2. Visual design and consistency
Hierarchy (the most important thing on the screen is the most obvious), spacing and alignment consistency, typography consistency, color used consistently for the same meanings (for example media types on the node canvas), and identical components behaving identically everywhere.

### 3. Interaction patterns and states
Buttons look clickable and their labels say what will happen; disabled controls explain themselves or do not appear; dialogs have an obvious primary action and an escape; drag targets are big enough; anything reachable only by hovering is also reachable another way; every view has a sane empty state that tells a new user what to do first.

### 4. Copy and labeling
Plain language for non-technical users; no unexplained acronyms; units shown wherever numbers appear (seconds, resolution, credits/cost); paid actions show their cost or credit impact BEFORE the user commits; success messages confirm what actually happened.

### 5. Accessibility basics
Text contrast, visible keyboard focus, keyboard reachability of core actions, control sizes, nothing conveyed by color alone (wire colors on the node canvas included - a label, shape, or pattern must back up color), and text that stays readable at larger window/font scaling.

### 6. Workflow fit (Cascade-specific)
Can a new user get from opening the app to a first generated shot without outside help? Does the classic view hide node complexity without hiding consequences (what will be generated, what it costs)? Can the user always find previous generations and tell good takes from bad ones? Is anything done in one view surprising when seen in the other?

## Severity scale

- Severity 4 (Blocker): prevents completing a core task, loses work, or spends money unexpectedly.
- Severity 3 (Major): serious confusion or a likely mistake on a common path; users will hit this often.
- Severity 2 (Minor): friction or inconsistency users can work around.
- Severity 1 (Polish): cosmetic or rare-edge improvement.

Severity is impact multiplied by how often a typical user hits it. When either is not obvious, say which one drove the rating.

## Output

Write the full findings to a file named ux-audit-findings.md in the current project (or a location the user names), and give the user a short summary in chat: how many findings at each severity, and the top 5 fixes.

Findings format - a numbered list, worst first within the whole list:

Item N: [short title] (Severity X, [view name + state])
What I observed: [the specific element or behavior, citing the screenshot it came from]
Why it matters: [the user impact, in plain language]
Suggested fix: [concrete and small enough to act on as one task]

After the findings: one score per audit category (1-5, 5 is best) with a one-line justification each; a "Not covered" list naming any views or states you could not capture; and a "Top 5 fixes first" list referencing item numbers.

## Guardrails

- No finding without a screenshot behind it. "No findings" is a valid result for a category - say so rather than inventing an issue.
- The "What I observed" line contains only things visible in a screenshot. Keep opinion in "Why it matters."
- Never trigger a paid generation, delete anything, or change project content to stage a screenshot. If a state cannot be reached safely, it goes in "Not covered."
- Suggest fixes at the level of the problem; do not redesign whole screens unless the finding is that the screen's structure itself fails its primary task.
- Judge usability, clarity, and consistency - not visual taste. Personal style preferences are not findings.
- Do not change any app code or settings during an audit. The findings list is the only deliverable.
