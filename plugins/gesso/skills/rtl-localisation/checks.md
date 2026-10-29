# Checks

- **Direction and alignment:** every RTL text layer has `direction: "rtl"` and is aligned to the right edge. Render at 100%: the letters are joined, with no isolated forms where they should connect.
- **Font coverage:** render warnings mention no missing glyphs, and there are no boxes in the render.
- **The layout is mirrored:** logo, text column and directional icons are on the opposite side to the LTR version. Images and logos aren't mirrored.
- **Preflight** shows no errors.
