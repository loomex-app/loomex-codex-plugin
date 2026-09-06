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
| `ui-disclosure` | Optional exact execution references |
| `.actions` and button variants | Shared footer, primary, secondary, destructive, hover, active, focus and disabled states |
| Form controls | Short/long answers, date, number, yes/no, choices, Other text and ratings |

Keyboard focus has a shared visible ring. Selected choices and ratings use the primary palette. Invalid controls and inline errors use the danger token. Locked answers retain their content and show a disabled state. Mobile visual order follows DOM/keyboard order. Every view sends the standard MCP Apps content-size notification after initialization and whenever the content size changes.

## Change rules and validation

Do not add selectors based on `data-mode` to the stylesheet or fork tokens per view. Choose an existing component or add a reusable semantic variant. Keep state and tool behavior separate from presentation: exact preparation bindings, read-only refresh, typed answers, approval decisions and immutable retries remain in the existing handlers.

The browser suite compares shared computed styles across all four modes in light, dark and mobile layouts, checks overflow, control targets, keyboard focus and resize notifications, and captures normal/error states. Existing interaction, cancellation, preparation and retry tests remain release gates. Set `LOOMEX_DESIGN_SCREENSHOT_DIR` to capture the visual matrix when running `npm run test:ui`.
