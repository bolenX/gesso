import { expect, it } from "vitest";
import { outline } from "../src/index.js";
import { promo } from "./fixtures.js";

it("renders the compact outline", () => {
  expect(outline(promo)).toMatchInlineSnapshot(`
    "promo-01  rev 12
    ▣ post-4x5  1080×1350
      ├ backdrop       shape   role=background
      ├ card           shape   role=container [clip-base] center
      │ ↳ card-photo     image   clip multiply "Model portrait, warm light" center
      └ headline       text    role=headline "Summer Edit" bottom-left"
  `);
});
