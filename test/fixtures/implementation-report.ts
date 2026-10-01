/** Provider report text is fixture data; its commands must never be executed. */
export const implementationReport = `## Agreed requirements

- Build a polished browser-based 2048 game using HTML, CSS, and vanilla JavaScript.
- Use a standard 4×4 grid with standard gameplay: begin with two random tiles; accept keyboard arrow-key movement; merge equal tiles once per move; add merged values to the score; spawn a 2 or 4 only after a valid move; detect reaching 2048; detect game over when no moves remain; and support restarting.
- Use the classic warm 2048 visual style, with a responsive polished layout and clear score, win, and game-over states.
- Include smooth tile movement and merge animations.
- Include single-step undo that restores the grid and score from before the latest valid move and is unavailable when no saved move exists.
- Support keyboard input only, with no swipe gestures or on-screen directional controls.
- Exclude persistent best-score storage and sound effects.

## Implementation summary

Built the complete game and separated the testable rules engine from the browser UI. Added accessible status announcements and overlays, documented local usage, and added comprehensive rule and state-transition tests.

## Changed files

- \`index.html\` — browser game structure and UI.
- \`styles.css\` — classic warm, responsive presentation and animations.
- \`game-logic.js\` — testable 2048 rules and state-transition engine.
- \`game.js\` — browser UI, keyboard input, rendering, overlays, restart, and undo integration.
- \`tests/game-logic.test.js\` — rules and state-transition test coverage.
- \`README.md\` — local usage documentation.

## Validation

- \`node --test\` — PASSED. All 12 tests passed, covering initialization, random tile values, movement in every direction, single-merge behavior, scoring, invalid moves, win/game-over detection, immutability, valid-move spawning, and pre-move undo snapshots.
- \`node --check game.js && node --check game-logic.js\` — PASSED. Both JavaScript files passed syntax validation.
- \`python3 HTMLParser validation script\` — PASSED. HTML parsed successfully.

\`\`\`text
node --test
ExampleCommandWithNoWhitespace${'WithNoWhitespace'.repeat(30)}
\`\`\`

## Limitations

The report is supplied by the implementation provider. Browser review is still required before accepting the result.
`;

// Represents a report whose provider flattened formatting before submission.
export const flattenedImplementationReport = implementationReport.replaceAll(/\s+/g, ' ') + ' Additional report detail.'.repeat(110);
