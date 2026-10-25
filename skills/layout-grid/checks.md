# Checks

- **Everything sits on the grid.** Each layer's frame x and width line up with column edges, within 1 px. Check against the guides in a render at 0.5.
- **Margins are equal** on all sides, or deliberately different (a bigger bottom margin is classic in print).
- **The guides are gone before export.** No layers tagged `guide` remain visible (`canvas_get` with `".guide"`).
