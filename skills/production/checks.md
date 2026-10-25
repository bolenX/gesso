# Checks

Before handing over files:

- **Preflight every artboard.** Run `canvas_inspect` with `preflight: true`. There should be no errors, and no text under the minimum size. No images should be enlarged past their pixels.
- **Print.** Soft-proof with `canvas_render` `proof: "cmyk"` (or the printer's profile). Compare with the RGB render for colours that dull. Rich blacks and brand colours should still read.
- **Exports.**
  - Open the manifest. Check every artboard and slice is listed, with the expected size and format.
  - JPEGs are RGB unless print asked for CMYK.
  - TIFF masters are lossless.
- **Batch runs.** Spot-check the first, the last and one middle output. The variable text fits, and the images are the right ones.
- **PSD.** The export warnings say what was baked into pixels (smart filters, warps). Tell the user if anything they need to edit was baked.
