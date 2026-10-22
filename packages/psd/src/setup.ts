import { initializeCanvas } from "ag-psd";

// ag-psd defaults to browser canvases. Gesso is headless and always passes raw
// pixel data, so plain buffers stand in for ImageData and canvases are refused.
type CreateImageData = NonNullable<Parameters<typeof initializeCanvas>[2]>;

initializeCanvas(
  () => {
    throw new Error("Gesso uses raw image data; ag-psd should not need a canvas");
  },
  undefined,
  ((width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" })) as unknown as CreateImageData,
);
