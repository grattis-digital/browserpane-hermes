# Bundled upscale models

`cnn-2x-s.json` contains the four-layer Anime4K CNN 2× S animation weights
from [WebSR](https://github.com/sb2702/websr), revision
`517fbef96c7d28315cd843ad5d4b10203b0bc8af`, file
`weights/anime4k/cnn-2x-s-an.json` (`@websr/websr` 0.0.16).

The source JSON SHA-256, excluding the final newline added when vendoring, is
`aecd5bf215a8962a13e38a8623433a7477f853ccdaefe8b6274f9aa6828368e0`.
The model is bundled in `app.js`; there is no runtime package loader, CDN or
model-download request. Its coefficients are unchanged.

`cnn-2x-m.json` is the **Quality** candidate from the same pinned revision,
file `weights/anime4k/cnn-2x-m-an.json`. Its source SHA-256, excluding the
vendored final newline, is
`f5833e47a3838c9f14558e413074219898deba8e73b661dcb54f38dca5eadcf7`.
Its coefficients are also unchanged and bundled locally. WebSR maps it to
[Anime4K_Upscale_CNN_x2_M.glsl](https://github.com/bloc97/Anime4K/blob/master/glsl/Upscale/Anime4K_Upscale_CNN_x2_M.glsl).
It retains seven four-channel 3×3 feature maps, then three 1×1 heads combine
positive/negative activations from every feature map into RGB pixel-shuffle
residuals. The adapter fuses those three heads into one GPU dispatch; the seven
feature inputs plus one output use eight storage buffers. Head coefficients
use a uniform buffer, so no raised adapter limits are needed.

Balanced uses the small model's scalar residual; Quality uses separate RGB
residuals. Each independently reads the original framebuffer. Both use the same
75% residual strength and local range limiter; Quality is not extra sharpening
stacked on Balanced. Its seven-pixel receptive radius fits the shared eight-pixel
halo, and the original two-buffer Balanced path remains available.

WebSR identifies the original model as
[Anime4K_Upscale_CNN_x2_S.glsl](https://github.com/bloc97/Anime4K/blob/master/glsl/Upscale/Anime4K_Upscale_CNN_x2_S.glsl).
Both MIT notices are retained here and included in the distributed viewer bundle.
These dependency notices do not replace the project's AGPL licensing.

We reuse the model architecture/math, not WebSR's global-context runtime.
The viewer adapter uses bounded crops, clamped neighbors, guarded ceil dispatch,
reusable pipelines/buffers, one submission per patch and opaque output alpha.
After pixel shuffle, it applies 75% of the residual and clamps each RGB channel
to the four surrounding source samples' range. This viewer-specific limiter
preserves flat areas and reduces ringing; it is not part of the upstream model.

These are animation-trained candidates, not models trained or validated for
browser text. They can alter glyphs/details. Both remain explicitly experimental
and opt-in; use Original pixels for fidelity-critical work.
