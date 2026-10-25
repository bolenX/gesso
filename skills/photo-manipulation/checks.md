# Checks

Compare the composite with the plate alone (`compare` with `hide`), then check:

- **Light direction.** Highlights on the placed subject come from the plate's light side. A light wrap brightens the subject's edges against bright backgrounds.
- **Edges.** At 200%, no halo of the old background shows. An inner shadow (edge integration) is subtle: lower its opacity if you can see the outline.
- **Atmosphere.** Distant planes are lighter and lower in contrast than near ones (`luminance.contrast` per region). The foreground keeps its contrast.
- **Grain.** The placed elements and the plate share one grain: `noise` within about 20% across regions.
- **Palette.** After matching, the placed elements' average colour (`color.lab`) sits near the plate's. A final shared grade ties everything together.
