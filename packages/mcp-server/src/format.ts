// The document format, written for the agent that has to produce it. This is the
// canvas_create description, so it is the one place agents learn the shape.

export const DOC_FORMAT = `Create a layered document. Returns its outline. Change it afterwards with canvas_patch.

Format (JSON). Layers are listed bottom to top; IDs are short and meaningful ("headline", not "layer1").
{
  "id": "spring-poster",
  "assets": {                       // files the layers use, by ID. Paths are relative to the Gesso folder.
    "photo": { "uri": "photo.jpg", "kind": "image" },
    "bold":  { "uri": "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "kind": "font", "family": "Arial Bold", "postscriptName": "Arial-BoldMT" }
  },
  "artboards": [{
    "id": "post", "name": "Post 4:5",
    "frame": { "x": 0, "y": 0, "w": 1080, "h": 1350 },
    "background": "#FFFFFF",
    "layers": [
      { "id": "bg", "type": "image", "asset": "photo", "fit": "cover", "frame": { "x": 0, "y": 0, "w": 1080, "h": 1350 } },
      { "id": "card", "type": "shape", "shape": { "kind": "rect", "radius": 24 }, "fill": "#FF4F1A",
        "frame": { "anchor": "bottom", "margin": 80, "w": "80%", "h": 300 } },
      { "id": "headline", "type": "text", "content": "Spring Sale", "box": { "kind": "area" },
        "style": { "font": "Arial Bold", "size": 96, "fill": "#111110", "align": "center" },
        "frame": { "anchor": "top", "margin": 120, "w": "90%", "h": 120 } }
    ]
  }]
}

Every layer: "id", "type", "frame"; optional "name", "opacity" (0..1), "blend" ("multiply", "screen", …), "clip" (clip to the layer below), "visible", "mask", "filters" ([{ "kind": "gaussian-blur", "radius" }]), "meta" ({ "role", "description" }).
frame: { "x", "y", "w", "h" } in pixels, or { "anchor": "top-left|top|top-right|left|center|right|bottom-left|bottom|bottom-right", "margin": n or [x, y], "w", "h" } where w/h may be "50%".
Layer types and their own fields:
- text: "content", "style" { "font" (a font asset's family), "size", "weight", "tracking", "leading", "fill", "align": start|center|end|justify }, "box" { "kind": "point" | "area", "shrinkToFit" }
- shape: "shape" { "kind": "rect", "radius" } | { "kind": "ellipse" } | { "kind": "path", "d": "<svg path>" }, "fill", "stroke" { "paint", "width" }
- image: "asset", "fit": cover|contain|fill, "focus": [x, y]
- adjustment: "adjustment" { "kind": "curves", "points": [[in, out], …] } | levels | hue-saturation | brightness-contrast
- group: "children" (layers), "isolation": pass-through|isolate
- smart: "symbol" (an ID in doc.symbols), "quad": four [x, y] corners for perspective
Colours are "#RRGGBB" or "#RRGGBBAA"; gradients are { "kind": "linear-gradient", "angle", "stops": [{ "offset", "color" }] }.
Text needs a font asset: point "uri" at a .ttf/.otf file and set "family" (and "postscriptName" so Photoshop finds it).`;
