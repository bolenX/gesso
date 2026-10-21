# Skills

A skill is not a macro. Each one pairs a recipe with craft judgement and a visual check loop. The primitives a skill needs set the engine roadmap.

```
skills/<name>/
  SKILL.md       # when to use, workflow, judgement calls, failure modes
  recipe.json    # parameterised patch template
  checks.md      # what to verify in the render before finishing
  examples/      # before/after docs with golden renders
```

A skill ships in a release only when its examples pass. The full catalogue and the waves it ships in are in [docs/spec-v0.1.md](../docs/spec-v0.1.md#skill-catalogue).
