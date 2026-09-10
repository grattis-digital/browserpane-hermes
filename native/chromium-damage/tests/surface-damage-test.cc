// Copyright 2026 BrowserPane Hermes contributors
// SPDX-License-Identifier: BSD-3-Clause
#include "ui/gfx/browserpane_surface_damage.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <vector>

#define REQUIRE(expr) do { if (!(expr)) { \
  std::fprintf(stderr, "surface damage assertion at line %d: %s\n", __LINE__, #expr); \
  std::abort(); } } while (false)

using Damage = gfx::BrowserPaneSurfaceDamage;
using Tracker = gfx::BrowserPaneSurfaceDamageTracker;
using Rect = Tracker::Rect;

static Damage Frame(uint64_t sequence, Rect rect = {32, 96, 24, 24}) {
  return {{17, 29}, sequence, 1280, 720, rect};
}

static void Boundaries() {
  Tracker tracker;
  REQUIRE(!tracker.Select(Frame(1), 1280, 720, true));
  tracker.Complete(Frame(1), 1280, 720, true);
  REQUIRE((tracker.Select(Frame(2), 1280, 720, true) == Rect{32, 600, 24, 24}));
  REQUIRE(!tracker.Select(Frame(2), 1280, 720, false));
  REQUIRE(!tracker.Select(Frame(2), 640, 480, true));
  REQUIRE(!tracker.Select(Frame(2, {0, 0, 1280, 720}), 1280, 720, true));
  REQUIRE(!tracker.Select(Frame(2, {0, 0, 0, 0}), 1280, 720, true));
  REQUIRE((tracker.Select(Frame(2, {0, 0, 1, 1}), 1280, 720, true) == Rect{0, 719, 1, 1}));
  REQUIRE((tracker.Select(Frame(2, {1279, 719, 1, 1}), 1280, 720, true) == Rect{1279, 0, 1, 1}));
  for (Rect rect : {Rect{-1, 0, 1, 1}, {0, -1, 1, 1}, {0, 0, -1, 1},
                    {0, 0, 1, -1}, {1280, 0, 1, 1}, {0, 720, 1, 1},
                    {0, 0, 1281, 720}, {0, 0, 1280, 721},
                    {2147483647, 0, 2147483647, 1}}) {
    REQUIRE(!tracker.Select(Frame(2, rect), 1280, 720, true));
    tracker.Complete(Frame(2, rect), 1280, 720, true);
    REQUIRE(!tracker.Select(Frame(3), 1280, 720, true));
    tracker.Complete(Frame(1), 1280, 720, true);
  }
}

static void ProducerTransitions() {
  gfx::BrowserPaneSurfaceDamageGuard guard;
  REQUIRE(guard.ObserveFrame(false, false));  // New producer.
  REQUIRE(!guard.ObserveFrame(false, false));
  REQUIRE(guard.ObserveFrame(false, true));   // Overlay/debug/ink begins.
  REQUIRE(guard.ObserveFrame(false, true));
  REQUIRE(guard.ObserveFrame(false, false));  // Its removal changes pixels too.
  REQUIRE(!guard.ObserveFrame(false, false));
  REQUIRE(guard.ObserveFrame(true, false));   // Resize/scale/color invalidation.
  REQUIRE(!guard.ObserveFrame(false, false));
}

static void History() {
  Tracker tracker;
  tracker.Complete(Frame(1), 1280, 720, true);
  REQUIRE(!tracker.Select(Frame(3), 1280, 720, true)); // Draw 2 skipped on GPU.
  tracker.Complete(Frame(3), 1280, 720, true);         // Full swap repairs it.
  REQUIRE(tracker.Select(Frame(4), 1280, 720, true));
  tracker.Complete(Frame(4), 1280, 720, false);
  REQUIRE(!tracker.Select(Frame(5), 1280, 720, true));
  tracker.Complete(Frame(5), 1280, 720, true);
  tracker.Complete(std::nullopt, 1280, 720, true);
  REQUIRE(!tracker.Select(Frame(6), 1280, 720, true));
  tracker.Complete(Frame(6), 1280, 720, true);
  tracker.Reset(); // Same-size surface recreation, not just resize.
  REQUIRE(!tracker.Select(Frame(7), 1280, 720, true));
  tracker.Complete(Frame(7), 1280, 720, true);
  for (uint64_t sequence : {uint64_t{7}, uint64_t{6}}) {
    REQUIRE(!tracker.Select(Frame(sequence), 1280, 720, true));
    tracker.Complete(Frame(sequence), 1280, 720, true);
    REQUIRE(!tracker.Select(Frame(sequence + 1), 1280, 720, true));
    tracker.Complete(Frame(7), 1280, 720, true);
  }
  auto replacement = Frame(8);
  replacement.producer = {31, 43};
  REQUIRE(!tracker.Select(replacement, 1280, 720, true));
  tracker.Complete(replacement, 1280, 720, true);
  replacement.sequence++;
  REQUIRE(tracker.Select(replacement, 1280, 720, true));
  replacement.producer = {};
  tracker.Complete(replacement, 1280, 720, true);
  REQUIRE(!tracker.Select(Frame(10), 1280, 720, true));
  const auto last = std::numeric_limits<uint64_t>::max();
  tracker.Complete(Frame(last), 1280, 720, true);
  REQUIRE(!tracker.Select(Frame(0), 1280, 720, true));
  tracker.Complete(Frame(0), 1280, 720, true);
  REQUIRE(!tracker.Select(Frame(1), 1280, 720, true));
}

static void Dimensions() {
  Tracker tracker;
  for (int dimension : {-1, 0, 16385, 2147483647}) {
    auto frame = Frame(1);
    frame.width = dimension;
    tracker.Complete(frame, dimension, 720, true);
    frame.sequence++;
    REQUIRE(!tracker.Select(frame, dimension, 720, true));
  }
  auto first = Frame(1);
  first.width = 1920; first.height = 1080;
  tracker.Complete(first, 1920, 1080, true);
  auto resized = Frame(2);
  REQUIRE(!tracker.Select(resized, 1280, 720, true));
  tracker.Complete(resized, 1280, 720, true);
  REQUIRE(tracker.Select(Frame(3), 1280, 720, true));
}

// Independent framebuffer oracle: skipped draws and failed swaps must not
// permit a subsequent selective presentation to leave unreported stale pixels.
// This exercises the actual policy header, not an alternate implementation.
static void PixelHistory() {
  Tracker tracker;
  constexpr int width = 128, height = 96;
  std::vector<unsigned> drawn(width * height), presented(width * height);
  unsigned selective = 0, full = 0;
  for (uint64_t sequence = 1; sequence <= 2000; sequence++) {
    const int x = static_cast<int>((sequence * 37) % (width - 8));
    const int y = static_cast<int>((sequence * 19) % (height - 8));
    for (int j = y; j < y + 8; j++)
      for (int i = x; i < x + 8; i++) drawn[j * width + i] = static_cast<unsigned>(sequence);
    Damage packet{{5, 7}, sequence, width, height, {x, y, 8, 8}};
    if (sequence % 11 == 0) continue; // Drawn, but never passed to EGL.
    if (sequence % 17 == 0) tracker.Reset();
    auto selected = tracker.Select(packet, width, height, true);
    if (sequence % 23 == 0) {
      tracker.Complete(packet, width, height, false);
      continue; // Error: no blind second swap and no assumed presentation.
    }
    if (selected) {
      selective++;
      const int top = height - (*selected)[1] - (*selected)[3];
      for (int j = top; j < top + (*selected)[3]; j++)
        for (int i = (*selected)[0]; i < (*selected)[0] + (*selected)[2]; i++)
          presented[j * width + i] = drawn[j * width + i];
    } else {
      full++;
      presented = drawn;
    }
    tracker.Complete(packet, width, height, true);
    REQUIRE(presented == drawn);
  }
  REQUIRE(selective > 1000 && full > 200);
  std::printf("surface_damage_policy_pixels=passed selective=%u full=%u steps=2000\n", selective, full);
}

int main() {
  static_assert(sizeof(Tracker) <= 96, "Policy must remain bounded");
  Boundaries(); ProducerTransitions(); History(); Dimensions(); PixelHistory();
  std::puts("surface_damage_policy=passed chromium_runtime=not_qualified");
}
