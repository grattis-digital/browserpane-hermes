# Project mark

`logo.png` is the original project mark, created with the built-in image generation
tool using the imagegen skill. It combines a winged browser pane with human and
agent imagery. It is a raster PNG on a white background, not a vector asset or
an official Raspberry Pi, Nous Research, or upstream BrowserPane logo.

The first versions rendered a checkerboard instead of actual transparency. The
final asset deliberately uses an opaque white background. It was visually reviewed
and copied from the generator output without manual image manipulation. No CLI
fallback was used. The screenshot in `docs/images/` is separately captured from a
real disposable remote browser and is not AI-generated.

## Initial prompt

```
Use case: logo-brand
Asset type: original project logo mark for the open-source BrowserPane Hermes Raspberry Pi bundle.
Primary request: Design a compact, distinctive emblem combining a browser window / tiled pane with a subtle wing motif suggesting Hermes and a shared human-and-agent session. It should feel friendly, technically precise, and credible on an open-source GitHub README. Create an original symbol, not a remix of any existing brand logo.
Style/medium: crisp flat vector-like logo rendered as a high-resolution PNG; strong silhouette, simple geometry, balanced negative space, readable at small sizes.
Composition/framing: one centered emblem, generous even padding, square canvas. No wordmark or typography.
Color palette: rich raspberry accent with deep ink outlines and a small teal accent, suitable on light or dark README backgrounds.
Scene/backdrop: genuinely transparent background, preserve alpha; no backdrop, checkerboard, mockup, device photograph or decorative scene.
Constraints: no text, no watermark, no existing Raspberry Pi fruit logo, no Nous Research or Hermes fashion logos, no official affiliation implied, no gradients or 3D effects.
```

## Final refinement prompt

```
Use case: logo-brand. Create the final original BrowserPane Hermes emblem from the reference: a browser window with a raspberry-colored left wing and human/robot panes in dark navy and teal. Preserve the shape and arrangement. IMPORTANT BACKGROUND CHANGE: replace ALL checkerboard pixels with one perfectly uniform opaque PURE WHITE #ffffff background. No transparency, no checkerboard, no pattern, no gray border, no texture, no shadows. Make the mark occupy about 80% of the square canvas width, centered with 10% white padding. Crisp flat solid color vector-style fills, no gradients, no text or typography.
```
