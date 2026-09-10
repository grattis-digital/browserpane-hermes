//! Synthetic vblank follows monotonic time, never VNC-client activity or polling.

const CAPACITY: usize = 256;

#[derive(Clone, Copy)]
struct Event {
    id: u64,
    target: u64,
}

pub(crate) struct PresentClock {
    epoch_us: u64,
    last_us: u64,
    hz: u32,
    events: [Option<Event>; CAPACITY],
}

impl PresentClock {
    pub(crate) fn new(epoch_us: u64, hz: u32) -> Option<Self> {
        (30..=120).contains(&hz).then_some(Self {
            epoch_us,
            last_us: epoch_us,
            hz,
            events: [None; CAPACITY],
        })
    }

    pub(crate) fn sample(&mut self, now_us: u64) -> (u64, u64) {
        // A regressing clock cannot send an event early or decrease MSC.
        self.last_us = self.last_us.max(now_us);
        let elapsed = u128::from(self.last_us - self.epoch_us);
        let msc = (elapsed * u128::from(self.hz) / 1_000_000) as u64;
        (self.last_us, msc)
    }

    pub(crate) fn queue(&mut self, id: u64, target: u64) -> bool {
        if self.events.iter().flatten().any(|event| event.id == id) {
            return false;
        }
        match self.events.iter_mut().find(|entry| entry.is_none()) {
            Some(slot) => {
                *slot = Some(Event { id, target });
                true
            }
            None => false,
        }
    }

    pub(crate) fn abort(&mut self, id: u64) {
        for slot in &mut self.events {
            if slot.is_some_and(|event| event.id == id) {
                *slot = None;
                return;
            }
        }
    }

    pub(crate) fn pop_due(&mut self, now_us: u64) -> Option<(u64, u64, u64)> {
        let (ust, msc) = self.sample(now_us);
        let (index, _) = self
            .events
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| entry.map(|event| (index, event)))
            .filter(|(_, event)| event.target <= msc)
            .min_by_key(|(_, event)| event.target)?;
        let event = self.events[index].take()?;
        Some((event.id, ust, msc))
    }

    pub(crate) fn delay_ms(&mut self, now_us: u64) -> u32 {
        let (ust, _) = self.sample(now_us);
        let Some(target) = self.events.iter().flatten().map(|event| event.target).min() else {
            return 0; // No idle timer: an idle display should not wake at 60 Hz.
        };
        let due = u128::from(target)
            .saturating_mul(1_000_000)
            .div_ceil(u128::from(self.hz))
            + u128::from(self.epoch_us);
        let delay = due.saturating_sub(u128::from(ust)).div_ceil(1000);
        // Xorg timers use milliseconds; a finite recheck also bounds huge targets.
        delay.clamp(1, 1000) as u32
    }
}
