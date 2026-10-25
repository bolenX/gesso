# Checks

Before handing over files:

- **Preflight every artboard.** Run `canvas_inspect` with `preflight: true`. There should be no errors, and no text under the minimum size. No images should be enlarged past their pixels.
- **Print.** Soft-proof with `canvas_render` `proof: "cmyk"` (or the printer's profile). Compare with the RGB render for colours that dull. Rich blacks and brand colours should still read.
- **Exports.**
  - Open the manifest. Check every artboard and slice is listed, with the expected size and format.
  - JPEGs are RGB unless print asked for CMYK.
  - TIFF masters are lossless.
- **Batch runs.** Spot-check the first, the last and one middle output. The variable text fits, and the images are the right ones.
- **PSD.** Filters Photoshop also has stay live smart filters, and distorted layers become smart objects with live content. Warped layers become smart objects with a custom warp. The export warnings name what was baked into pixels instead: filters Photoshop has no match for, layers both distorted and warped, and type on a path. Tell the user if anything they need to edit was baked.
