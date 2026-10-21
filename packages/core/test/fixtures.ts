import type { Doc } from "../src/index.js";

/** The promo-01 document from the spec's outline example. */
export const promo: Doc = {
  id: "promo-01",
  revision: 12,
  assets: {
    portrait: { uri: "file://assets/portrait.jpg", kind: "image", width: 2400, height: 3000 },
  },
  artboards: [
    {
      id: "post-4x5",
      name: "Post 4:5",
      frame: { x: 0, y: 0, w: 1080, h: 1350 },
      preset: "instagram-portrait",
      layers: [
        {
          id: "backdrop",
          name: "Backdrop",
          type: "shape",
          meta: { role: "background" },
          frame: { x: 0, y: 0, w: 1080, h: 1350 },
          shape: { kind: "rect" },
          fill: "#F3EDE4",
        },
        {
          id: "card",
          name: "Card",
          type: "shape",
          meta: { role: "container" },
          frame: { anchor: "center", w: "80%", h: "70%" },
          shape: { kind: "rect", radius: 24 },
          fill: "#FFFFFF",
        },
        {
          id: "card-photo",
          name: "Card photo",
          type: "image",
          clip: true,
          blend: "multiply",
          meta: { description: "Model portrait, warm light" },
          frame: { anchor: "center", w: "80%", h: "70%" },
          asset: "portrait",
          fit: "cover",
        },
        {
          id: "headline",
          name: "Headline",
          type: "text",
          meta: { role: "headline" },
          frame: { anchor: "bottom-left", margin: 64 },
          content: "Summer Edit",
          style: { font: "Inter", size: 96, weight: 700 },
        },
      ],
    },
  ],
};
