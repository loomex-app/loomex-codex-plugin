# Loomex custom UI design system

All four MCP Apps views—run preparation, workflow authoring, run monitoring and human interaction—use the same design system. The source is the single inline stylesheet and reusable presentation classes in `assets/loomex-app.html`. `src/ui.ts` uses this same template for every resource; no network stylesheet, runtime UI framework or separate per-view theme is needed.

## Tokens

The stylesheet declares three layers in one place:

| Layer | Responsibility |
| --- | --- |
| Primitive | Green/red palette, spacing scale, font families, sizes and radii |
| Semantic | Canvas background/foreground, muted text, border, primary action, destructive action, error surface and focus ring |
| Component | Shell width/padding, section gap, card surface/padding and control height/border |

The shell is 720px wide with 24px padding; narrow screens use 16px padding and stacked cards/actions. System fonts, neutral surfaces, 12px card corners, 9px controls and a 42px minimum control height apply everywhere. Green denotes normal primary actions. Destructive actions remain red. Dark mode changes shared semantic colors, including readable error text, rather than introducing a separate design per view.

## Shared components

| Component | Usage |
| --- | --- |
| `ui-stack`, `ui-grid`, `ui-section` | Vertical sections and responsive card grids |
| `ui-hero`, `request-copy` | Shared title scale and supporting copy |
| `ui-card`, `fieldset` | Review information and grouped questions using the same border, radius, surface and padding |
| `ui-label`, `ui-value`, `ui-caption`, `ui-badge` | Consistent information hierarchy |
| `ui-callout`, `notice`, `#summary` | Guidance, status, error and uncertain-result messages |
| `progress-steps`, `ui-list` | Named workflow stages and bounded summary, decision, review and result lists without invented percentages |
| `ui-disclosure` | Optional exact execution references |
| `.actions` and button variants | Shared footer, primary, secondary, destructive, hover, active, focus and disabled states |
| Form controls | Short/long answers, date, number, yes/no, choices, Other text and ratings |

Keyboard focus has a shared visible ring. Selected choices and ratings use the primary palette. Invalid controls and inline errors use the danger token. Locked answers retain their content and show a disabled state. Mobile visual order follows DOM/keyboard order. Every view sends the standard MCP Apps content-size notification after initialization and whenever the content size changes.

Single-question screens rely on the fieldset legend as the accessible question label. Exact copies of that question are removed from the title, description and prompt, repeated title/description/prompt copy is collapsed even without an input specification, and the question count appears only for batches. Normal question and authoring actions use `Continue`; the read-only action uses `Refresh`. Versioned implementation reviews keep their boolean response unchanged while labeling its choices `Accept` and `Request changes`.

## Presentation contracts

Human interaction and authoring views render optional `humanRequest.presentation` data only when it is the version 1 `progress`, `clarification` or `review` contract. Scalar fields are `question`, `stageLabel` and `summary`; bounded display lists are `changedFiles`, `artifacts`, `verification`, `limitations`, `priorRequirements`, `decisions` and `openQuestions`. Unknown fields such as raw `context.previousOutputs` are ignored. Current questions are removed from the open-question summary when they already appear as fieldset legends. Canonical stage names select the matching progress step using an exact case-insensitive comparison; other safe stage labels appear verbatim as a wrapping badge.

Run monitoring treats `execution.status` as authoritative. Active runs can wait for an update or request cancellation. `completed`, `failed` and `canceled` runs, plus compatible terminal spellings, disable and hide wait, cancellation and reason controls. The monitor shows the safe workflow name, stage, current step, locale-formatted timestamps and elapsed time when present. A version 1 `execution.result` may add summary, changed files, verification, limitations and artifact labels. Exact execution IDs stay in a collapsed reference disclosure.

Large immutable results represented by a response spool are never partially decoded or accumulated in the UI. The `View results` action sends one stable `ui/message` request with one text content block, asking the conversation to read every page through `nextOffset` and verify `checksumSha256`; a host rejection remains visible as an error rather than success. Artifact labels remain plain text unless the authoritative result supplies a separately supported safe link contract; the UI does not turn workspace paths into links or commands.

Safe validation errors may show version 1 issue entries with a one-based step ordinal, fixed message and an allowlisted next-action label. Backend-authored node IDs and names are neither transported in that issue contract nor rendered. The top-level request/support reference remains optional. Error codes, unknown fields, transport details and raw result JSON are not rendered.

## Change rules and validation

Do not add selectors based on `data-mode` to the stylesheet or fork tokens per view. Choose an existing component or add a reusable semantic variant. Keep state and tool behavior separate from presentation: exact preparation bindings, read-only refresh, typed answers, approval decisions and immutable retries remain in the existing handlers. A failed authoritative result locks ordinary mutations until a successful refresh loads current state. Refresh stays available during that lock, while an uncertain mutation retains its separate exact-response retry.

The browser suite compares shared computed styles across all four modes in light, dark and mobile layouts, checks overflow, control targets, keyboard focus and resize notifications, and captures normal/error states. It also covers prompt deduplication, structured progress and acceptance review, typed boolean responses, active and terminal monitoring, paged-result handoff, bounded actionable errors, cancellation, preparation and immutable retry. Set `LOOMEX_DESIGN_SCREENSHOT_DIR` to capture the visual matrix when running `npm run test:ui`.
