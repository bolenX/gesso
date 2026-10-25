# Checks

- **No overflow.** Render warnings mention no clipped text, and each text frame shows all its lines at 100%.
- **Sizes stay above the floor.** Each text layer's rendered size is at or above its `minSize`, and above the preflight minimum for the format.
- **Breaks read naturally:** no single-word last lines, no breaks inside names or prices.
