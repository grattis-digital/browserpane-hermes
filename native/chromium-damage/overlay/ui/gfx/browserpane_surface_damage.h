// Copyright 2026 BrowserPane Hermes contributors
// SPDX-License-Identifier: BSD-3-Clause
// Used by the experimental Chromium patch. No allocation or pixel readback.
#ifndef UI_GFX_BROWSERPANE_SURFACE_DAMAGE_H_
#define UI_GFX_BROWSERPANE_SURFACE_DAMAGE_H_

#include <array>
#include <cstdint>
#include <limits>
#include <optional>

namespace gfx {

// Logical surface changes since the producer's previous DRAW, not buffer-age
// repair. Coordinates are physical pixels with a top-left origin. This is an
// in-process value, not a wire format or authority from a page/CDP client.
struct BrowserPaneSurfaceDamage {
  std::array<uint64_t, 2> producer = {};
  uint64_t sequence = 0;
  int width = 0;
  int height = 0;
  std::array<int, 4> rect = {};
};

// Producer-side transitions into AND out of unsupported composition require
// full damage. Invalidation (reshape/color change) affects the current frame.
class BrowserPaneSurfaceDamageGuard {
 public:
  bool ObserveFrame(bool invalidated, bool incompatible) {
    const bool full = invalidated || incompatible || previous_incompatible_;
    previous_incompatible_ = incompatible;
    return full;
  }

 private:
  bool previous_incompatible_ = true;
};

// Synchronous EGL submission history; never equate drawing with presentation.
// A full successful swap re-establishes the baseline after a skipped draw.
// Missing/invalid metadata, duplicate/reversed sequence or failure invalidates
// it. Destroy/Recreate must call Reset even when dimensions stay unchanged.
class BrowserPaneSurfaceDamageTracker {
 public:
  using Damage = BrowserPaneSurfaceDamage;
  using Rect = std::array<int, 4>;

  std::optional<Rect> Select(const std::optional<Damage>& damage,
                             int width,
                             int height,
                             bool supported) const {
    if (!supported || !Valid(damage, width, height) || !last_ ||
        damage->producer != last_->producer || width != last_->width ||
        height != last_->height ||
        last_->sequence == std::numeric_limits<uint64_t>::max() ||
        damage->sequence != last_->sequence + 1) {
      return std::nullopt;
    }
    const auto& r = damage->rect;
    // Empty is NOT a skipped swap: EGL's zero-rectangle API means full damage.
    // Prefer the ordinary path for empty/full metadata and unknown history.
    if (r[2] == 0 || r[3] == 0 || r == Rect{0, 0, width, height}) {
      return std::nullopt;
    }
    return Rect{r[0], height - r[1] - r[3], r[2], r[3]};
  }

  void Complete(const std::optional<Damage>& damage,
                int width,
                int height,
                bool success) {
    if (!success || !Valid(damage, width, height) ||
        (last_ && damage->producer == last_->producer &&
         damage->sequence <= last_->sequence)) {
      Reset();
      return;
    }
    last_ = damage;
  }

  void Reset() { last_.reset(); }

 private:
  static bool Valid(const std::optional<Damage>& damage, int width, int height) {
    constexpr int kMaxDimension = 16384;
    if (!damage || width <= 0 || height <= 0 || width > kMaxDimension ||
        height > kMaxDimension || damage->width != width ||
        damage->height != height || damage->sequence == 0 ||
        damage->producer == std::array<uint64_t, 2>{}) {
      return false;
    }
    const auto& r = damage->rect;
    // Subtraction after range checks avoids signed overflow on malformed input.
    return r[0] >= 0 && r[0] <= width && r[1] >= 0 && r[1] <= height &&
           r[2] >= 0 && r[2] <= width - r[0] && r[3] >= 0 &&
           r[3] <= height - r[1];
  }

  std::optional<Damage> last_;
};

}  // namespace gfx

#endif  // UI_GFX_BROWSERPANE_SURFACE_DAMAGE_H_
