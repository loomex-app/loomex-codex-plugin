# Typed human responses

Fetch `loomex_interaction_get` for the exact pending request. Validate request/run and organization identities against the selected run. Use the complete structuredContent.data.humanRequest including inputSpec and responseSchema; text summaries are bounded previews.

In a UI-capable host, call `loomex_interaction_view` once. It shows one question at a time, preserves drafts and presents an editable preview before explicit submission. Pause monitoring while awaiting the user; never repeatedly open the unanswered card. Headlessly collect explicit answers and preview them before submission. Submit only after the user confirms the answer set; a bare answer-command invocation does not answer anything.

inputSpec owns text, stable IDs, type, choices, Other behavior and rating bounds. responseSchema owns payload structure. Support text, long_text, date, rating, boolean, radio and checkbox in single or mixed batches. Dates are YYYY-MM-DD; ratings respect supplied integer bounds; false is an explicit value, not missing. Other requires its text. Send stable question/option IDs and values, not labels as identifiers. Never invent defaults or collect secrets.

Use `loomex_interaction_respond` for typed answers and `loomex_interaction_decide` for the user's approval/rejection. Approval is a distinct decision, not a generic form response. UI submissions own their mutation; do not repeat them from chat. Verify the accepted receipt identifies the intended request/run and has a resolved status without an error; otherwise reconcile through reads, retaining the same sealed answer/key.

After an accepted response, or exact authoritative reconciliation proving acceptance, resume the same run using [monitoring](monitoring.md), unless the user explicitly asked for answer-only behavior. Handoff failure does not revoke acceptance. Already resolved or terminal requests cannot receive another answer; report current state and use read-only continuation.
