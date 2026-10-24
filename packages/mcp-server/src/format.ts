// The document format, written for the agent that has to produce it. This is the
// canvas_create description, so it is the one place agents learn the shape.

export const DOC_FORMAT = `Create a layered document. Returns its outline. Change it afterwards with canvas_patch.
Documents are saved in the Gesso folder (.gesso/<id>.json) after every change and survive restarts; canvas_list shows them. An existing id is refused unless you pass replace: true.

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
Every layer can also take "rotation" (degrees clockwise, around the centre of its frame) and "flip": horizontal|vertical|both. Rotated text and shapes stay live in the PSD.
Layer types and their own fields:
- text: "content", "style" { "font" (a font asset's family), "size", "weight", "tracking", "leading", "fill", "align": start|center|end|justify }, "box" { "kind": "point" | "area", "shrinkToFit" }
- shape: "shape" { "kind": "rect", "radius" } | { "kind": "ellipse" } | { "kind": "path", "d": "<svg path>" }, "fill", "stroke" { "paint", "width" }
- image: "asset", "fit": cover|contain|fill, "focus": [x, y]
- adjustment: "adjustment" { "kind": "curves", "points": [[in, out], …] } | levels | hue-saturation | brightness-contrast
- group: "children" (layers), "isolation": pass-through|isolate
- smart: places a symbol: "symbol" (an ID in doc.symbols); optional "quad": four [x, y] corners (top-left, top-right, bottom-right, bottom-left) that pin it in perspective or rotate it, overriding the frame
Symbols are reusable contents for smart layers; they export as Photoshop smart objects:
"symbols": { "screen": { "size": [1600, 1000], "background": "#FFFFFF", "layers": [ ...layers, positioned within the size... ] } }
Colours are "#RRGGBB" or "#RRGGBBAA"; gradients are { "kind": "linear-gradient", "angle", "stops": [{ "offset", "color" }] }.
Text needs a font asset: call font_list to find installed fonts and copy the asset entry it gives you, or point "uri" at a .ttf/.otf/.ttc file and set "family" (and "postscriptName" so Photoshop finds it; "face" picks a face in a .ttc).`;
