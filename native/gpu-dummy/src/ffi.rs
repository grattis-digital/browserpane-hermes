//! Narrow ABI: opaque Rust-owned clock; no Xorg structure layout crosses it.

use crate::{clock::PresentClock, geometry::geometry};

#[unsafe(no_mangle)]
pub extern "C" fn bp_geometry(width: u32, height: u32) -> u64 {
    geometry(width, height).map_or(0, |(_, bytes)| bytes)
}

#[unsafe(no_mangle)]
pub extern "C" fn bp_clock_new(epoch_us: u64, hz: u32) -> *mut PresentClock {
    PresentClock::new(epoch_us, hz)
        .map_or(std::ptr::null_mut(), |clock| Box::into_raw(Box::new(clock)))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bp_clock_free(clock: *mut PresentClock) {
    if !clock.is_null() {
        // SAFETY: C relinquishes the unique pointer returned by bp_clock_new once,
        // after cancelling its timer. No callback may retain or access it afterward.
        drop(unsafe { Box::from_raw(clock) });
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bp_clock_sample(clock: *mut PresentClock, now: u64, msc: *mut u64) -> u64 {
    // SAFETY: the adapter supplies a live exclusively accessed clock and a writable
    // uint64_t; null pointers are rejected. Calls never alias clock memory as output.
    let (Some(clock), Some(msc)) = (unsafe { clock.as_mut() }, unsafe { msc.as_mut() }) else {
        return 0;
    };
    let (ust, count) = clock.sample(now);
    *msc = count;
    ust
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bp_clock_queue(clock: *mut PresentClock, id: u64, target: u64) -> bool {
    // SAFETY: the adapter owns this live pointer on the single Xorg thread.
    unsafe { clock.as_mut() }.is_some_and(|clock| clock.queue(id, target))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bp_clock_abort(clock: *mut PresentClock, id: u64) {
    // SAFETY: the adapter owns this live pointer on the single Xorg thread.
    if let Some(clock) = unsafe { clock.as_mut() } {
        clock.abort(id);
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bp_clock_delay(clock: *mut PresentClock, now: u64) -> u32 {
    // SAFETY: the adapter owns this live pointer on the single Xorg thread.
    unsafe { clock.as_mut() }.map_or(0, |clock| clock.delay_ms(now))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bp_clock_pop(
    clock: *mut PresentClock,
    now: u64,
    output: *mut u64,
) -> bool {
    if output.is_null() {
        return false;
    }
    // SAFETY: same opaque pointer ownership contract as bp_clock_sample.
    let Some(clock) = (unsafe { clock.as_mut() }) else {
        return false;
    };
    let Some((id, ust, msc)) = clock.pop_due(now) else {
        return false;
    };
    // SAFETY: C passes a writable nonoverlapping uint64_t[3], valid for this call.
    unsafe { std::ptr::copy_nonoverlapping([id, ust, msc].as_ptr(), output, 3) };
    true
}
