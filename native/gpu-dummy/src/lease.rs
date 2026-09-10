//! Bounded, single-display-thread snapshot policy. GPU objects stay in C.
//! Busy slots accumulate damage but cannot be overwritten before release.

pub const TILE: u32 = 64;
const MAX_TILES: usize = 30 * 17;
// Two ACK-owned tile snapshots plus one independently paced video snapshot.
const SLOTS: usize = 3;

#[derive(Clone)]
struct Slot {
    dirty: [bool; MAX_TILES],
    lease: u32,
    generation: u32,
}

pub struct Pool {
    width: u32,
    height: u32,
    generation: u32,
    serial: u32,
    slots: [Slot; SLOTS],
}

impl Pool {
    pub fn new() -> Self {
        Self {
            width: 0,
            height: 0,
            generation: 0,
            serial: 0,
            slots: std::array::from_fn(|_| Slot {
                dirty: [true; MAX_TILES],
                lease: 0,
                generation: 0,
            }),
        }
    }

    pub fn resize(&mut self, width: u32, height: u32) -> bool {
        // Unsupported sizes invalidate capture, never silently crop the display.
        self.width = 0;
        self.height = 0;
        let Some(generation) = self.generation.checked_add(1) else {
            return false;
        };
        self.generation = generation;
        for slot in &mut self.slots {
            slot.dirty.fill(true);
        }
        if !(32..=1920).contains(&width) || !(32..=1080).contains(&height) {
            return false;
        }
        self.width = width;
        self.height = height;
        true
    }

    pub fn damage(&mut self, x1: i32, y1: i32, x2: i32, y2: i32) {
        let x1 = x1.clamp(0, self.width as i32) as u32;
        let y1 = y1.clamp(0, self.height as i32) as u32;
        let x2 = x2.clamp(0, self.width as i32) as u32;
        let y2 = y2.clamp(0, self.height as i32) as u32;
        if x1 >= x2 || y1 >= y2 {
            return;
        }
        let cols = self.width.div_ceil(TILE);
        for row in y1 / TILE..y2.div_ceil(TILE) {
            for col in x1 / TILE..x2.div_ceil(TILE) {
                for slot in &mut self.slots {
                    slot.dirty[(row * cols + col) as usize] = true;
                }
            }
        }
    }

    pub fn begin(&mut self) -> Option<[u32; 3]> {
        if self.width == 0 || self.height == 0 {
            return None;
        }
        let index = self.slots.iter().position(|slot| slot.lease == 0)?;
        let serial = self.serial.checked_add(1)?;
        self.serial = serial;
        let slot = &mut self.slots[index];
        slot.lease = serial;
        slot.generation = self.generation;
        Some([index as u32, serial, self.generation])
    }

    pub fn matches(&self, token: [u32; 3]) -> bool {
        self.slots.get(token[0] as usize).is_some_and(|slot| {
            token[1] != 0 && slot.lease == token[1] && slot.generation == token[2]
        })
    }

    pub fn release(&mut self, token: [u32; 3]) -> bool {
        if !self.matches(token) {
            return false;
        }
        self.slots[token[0] as usize].lease = 0;
        true
    }

    pub fn commit(&mut self, token: [u32; 3]) -> bool {
        // Called synchronously after copying, before accepting another X request.
        if !self.matches(token) || token[2] != self.generation {
            return false;
        }
        self.slots[token[0] as usize].dirty.fill(false);
        true
    }

    pub fn rectangle(&self, slot: u32, cursor: &mut u32) -> Option<[u32; 4]> {
        let slot = self.slots.get(slot as usize)?;
        if slot.lease == 0 || slot.generation != self.generation || self.width == 0 {
            return None;
        }
        let cols = self.width.div_ceil(TILE);
        let count = cols * self.height.div_ceil(TILE);
        while *cursor < count && !slot.dirty[*cursor as usize] {
            *cursor += 1;
        }
        if *cursor >= count {
            return None;
        }
        let start = *cursor;
        let row = start / cols;
        *cursor += 1;
        while *cursor < (row + 1) * cols && slot.dirty[*cursor as usize] {
            *cursor += 1;
        }
        let x = start % cols * TILE;
        let y = row * TILE;
        let right = ((*cursor - row * cols) * TILE).min(self.width);
        Some([x, y, right - x, TILE.min(self.height - y)])
    }
}
