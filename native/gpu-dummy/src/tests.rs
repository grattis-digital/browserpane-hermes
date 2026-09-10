use crate::{clock::PresentClock, geometry::geometry};

#[test]
fn geometry_is_exact_bounded_and_overflow_safe() {
    for (w, h) in [(1280, 720), (1365, 767), (1360, 768), (3840, 2160)] {
        assert_eq!(
            geometry(w, h),
            Some((w * 4, u64::from(w) * u64::from(h) * 4))
        );
    }
    for (w, h) in [
        (0, 720),
        (31, 32),
        (8193, 32),
        (8192, 8192),
        (u32::MAX, u32::MAX),
    ] {
        assert!(geometry(w, h).is_none());
    }
}

#[test]
fn frame_clock_has_no_cumulative_rounding_drift() {
    let mut clock = PresentClock::new(1000, 60).unwrap();
    assert_eq!(clock.sample(17_666), (17_666, 0));
    assert_eq!(clock.sample(17_667), (17_667, 1));
    assert_eq!(clock.sample(3_600_001_000), (3_600_001_000, 216_000));
    assert_eq!(clock.sample(1000), (3_600_001_000, 216_000));
}

#[test]
fn deadline_never_fires_early_and_idle_has_no_timer() {
    let mut clock = PresentClock::new(0, 60).unwrap();
    assert_eq!(clock.delay_ms(0), 0);
    assert!(clock.queue(0, 1));
    assert_eq!(clock.delay_ms(0), 17);
    assert_eq!(clock.pop_due(16_666), None);
    assert_eq!(clock.pop_due(16_667), Some((0, 16_667, 1)));
    assert_eq!(clock.pop_due(16_667), None);
    assert_eq!(clock.delay_ms(16_667), 0);
}

#[test]
fn queue_is_bounded_ordered_and_cancellation_is_idempotent() {
    let mut clock = PresentClock::new(0, 60).unwrap();
    for id in 0..256 {
        assert!(clock.queue(id, 1000 - id));
    }
    assert!(!clock.queue(256, 0));
    assert!(!clock.queue(10, 0));
    clock.abort(100);
    clock.abort(100);
    assert!(clock.queue(256, 0));
    assert_eq!(clock.pop_due(0), Some((256, 0, 0)));
    assert_eq!(clock.pop_due(20_000_000), Some((255, 20_000_000, 1200)));
}

#[test]
fn huge_targets_and_epoch_do_not_overflow_or_spin() {
    let mut clock = PresentClock::new(u64::MAX - 10, 120).unwrap();
    assert!(clock.queue(4, u64::MAX));
    assert_eq!(clock.delay_ms(u64::MAX), 1000);
    assert!(clock.pop_due(u64::MAX).is_none());
    for hz in [0, 1, 29, 121, u32::MAX] {
        assert!(PresentClock::new(0, hz).is_none());
    }
}

#[test]
fn fractional_deadlines_remain_exact_at_all_supported_rates() {
    for hz in 30..=120 {
        let mut clock = PresentClock::new(0, hz).unwrap();
        for target in 1..=500 {
            let due = (target * 1_000_000u64).div_ceil(u64::from(hz));
            assert!(clock.queue(target, target));
            assert_eq!(clock.pop_due(due - 1), None);
            assert_eq!(clock.pop_due(due), Some((target, due, target)));
            assert_eq!(clock.delay_ms(due), 0);
        }
    }
}

#[test]
fn opaque_ffi_roundtrip_and_null_rejection() {
    use crate::ffi;
    let clock = ffi::bp_clock_new(100, 60);
    assert!(!clock.is_null());
    let mut output = [0; 3];
    let mut msc = 0;
    // SAFETY: this test owns the live opaque clock exclusively, output arrays
    // do not alias it, and it frees it exactly once after the last call.
    unsafe {
        assert!(ffi::bp_clock_queue(clock, 5, 1));
        assert!(!ffi::bp_clock_pop(clock, 16_766, output.as_mut_ptr()));
        assert!(ffi::bp_clock_pop(clock, 16_767, output.as_mut_ptr()));
        assert_eq!(output, [5, 16_767, 1]);
        assert_eq!(ffi::bp_clock_sample(clock, 16_767, &mut msc), 16_767);
        assert_eq!(msc, 1);
        ffi::bp_clock_free(clock);
    }
    // SAFETY: the documented null branches reject pointers without dereference.
    unsafe {
        assert!(!ffi::bp_clock_queue(std::ptr::null_mut(), 0, 0));
        assert!(!ffi::bp_clock_pop(
            std::ptr::null_mut(),
            0,
            output.as_mut_ptr()
        ));
        assert_eq!(ffi::bp_clock_delay(std::ptr::null_mut(), 0), 0);
        ffi::bp_clock_abort(std::ptr::null_mut(), 0);
        ffi::bp_clock_free(std::ptr::null_mut());
    }
}
