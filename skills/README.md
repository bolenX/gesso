# Skills

A skill is not a macro. Each one pairs craft judgement with recipes and a visual check loop.

```
skills/<name>/
  SKILL.md       # when to use, workflow, judgement calls, failure modes (front matter: name, description)
  recipe.json    # parameterised patches that skill_apply fills in (optional)
  checks.md      # what to verify before finishing, with canvas_inspect measurements
  examples/      # documents with recipe steps and checks, run by the test suite
```

Gesso serves every skill whose front matter isn't `status: placeholder` in two ways:
- as an MCP prompt, which is a slash command in most agents
- through `skill_read`, which returns SKILL.md, the recipes with their parameters, and checks.md

They also ship in [the Gesso plugin](../plugins/gesso), copied there by `node scripts/sync-plugin.mjs`, and `npx skills add bolenX/gesso` installs them on their own. Either way, they drive Gesso's tools, so the agent needs the Gesso server too ([install.md](../docs/install.md)).

## Recipes

`recipe.json` holds named recipes, each a description, its parameters, and patch ops with placeholders:

```json
{
  "recipes": {
    "vignette": {
      "description": "Darkens the edges to draw the eye in.",
      "params": {
        "artboard": { "type": "artboard", "description": "The artboard" },
        "above": { "type": "layer", "description": "Put it just above this layer" },
        "amount": { "type": "number", "default": 0.5, "description": "Opacity, 0..1" }
      },
      "ops": [{ "op": "insert", "after": "#{{above}}", "layer": { "id": "vignette", "opacity": "{{amount}}", "frame": { "x": 0, "y": 0, "w": "{{artboard.w}}", "h": "{{artboard.h}}" } } }]
    }
  }
}
```

### Placeholders

- **`"{{name}}"`** is a parameter. Alone in a string it keeps its type: a number, a list or an object. A `layer` parameter stands for its id, and `{{name.frame}}` reads the layer's frame. An `artboard` parameter gives its `w` and `h`.
- **`"{{= expr}}"`** is arithmetic on numbers: `+ - * /`, parentheses, and `min`, `max`, `round`, `abs`, `floor` and `ceil`.
- **`"forEach": "<selector>"`** repeats an op for each matching layer, as `{{each}}`.
- **`"repeat": n`** repeats an op n times, with `{{i}}` counting from 0.

`skill_apply` applies a recipe as one revision.

## Examples

Each recipe needs an example in `examples/`, and a skill ships only when its examples pass (`packages/mcp-server/test/skills.test.ts`).

### The starting document

An example starts from one of:
- `layers`: synthetic photos from `packages/mcp-server/test/fixtures/photos.ts`, stacked bottom to top
- `doc`: an inline document

### Steps and checks

**Steps** are recipe calls, or raw `ops`. Steps marked `setup` build the scene and count as part of "before".

**Checks** compare the before and after renders:

| Check | Passes when |
| --- | --- |
| `metric` on a `region` | a measure (`noise`, `luminance.mean`, `color.lab.2`…) is `less`/`more` than a ratio of before, `max`/`min` an absolute value, or within `keep` of before |
| `sample` | the colour difference at a point is within `deltaE` bounds |
| `preflight` | the layout has at most `maxErrors` errors and `maxWarnings` warnings |
| `field` | a layer's field equals a value |
| `count` | a selector matches a number of layers |
