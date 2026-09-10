use crate::lease::Pool;

fn pixels(pool: &Pool, token: [u32; 3]) -> u32 {
    let mut cursor = 0;
    let mut count = 0;
    while let Some([_, _, width, height]) = pool.rectangle(token[0], &mut cursor) {
        count += width * height;
    }
    count
}

#[test]
fn cold_then_sparse_and_idle() {
    let mut pool = Pool::new();
    assert!(pool.resize(1280, 720));
    let first = pool.begin().unwrap();
    assert_eq!(pixels(&pool, first), 1280 * 720);
    assert!(pool.commit(first));
    assert!(pool.release(first));
    pool.damage(2, 3, 26, 27);
    let next = pool.begin().unwrap();
    assert_eq!(pixels(&pool, next), 64 * 64);
    assert!(pool.commit(next));
    assert!(pool.release(next));
    let idle = pool.begin().unwrap();
    assert_eq!(pixels(&pool, idle), 0);
}

#[test]
fn busy_slots_accumulate_without_overwrite() {
    let mut pool = Pool::new();
    pool.resize(1280, 720);
    let first = pool.begin().unwrap();
    pool.commit(first);
    let second = pool.begin().unwrap();
    pool.commit(second);
    let video = pool.begin().unwrap();
    pool.commit(video);
    assert!(pool.begin().is_none());
    pool.damage(10, 10, 11, 11);
    pool.damage(100, 100, 101, 101);
    assert!(pool.release(first));
    let third = pool.begin().unwrap();
    assert_eq!(pixels(&pool, third), 2 * 64 * 64);
    assert!(!pool.release(first));
    assert!(!pool.release([9, 1, 1]));
    assert!(!pool.release([second[0], 0, second[2]]));
    assert!(pool.release(second));
    assert!(pool.release(video));
}

#[test]
fn video_reuses_third_slot_without_advancing_ack_owned_tiles() {
    let mut pool = Pool::new();
    pool.resize(1280, 720);
    let previous = pool.begin().unwrap();
    pool.commit(previous);
    let pending = pool.begin().unwrap();
    pool.commit(pending);
    for i in 0..90 {
        pool.damage(10, 10, 11, 11);
        let video = pool.begin().unwrap();
        assert_eq!(video[0], 2);
        assert_eq!(pixels(&pool, video), if i == 0 { 1280 * 720 } else { 4096 });
        assert!(pool.begin().is_none());
        assert!(pool.commit(video));
        assert!(pool.release(video));
        assert!(pool.matches(previous) && pool.matches(pending));
    }
    assert_eq!(pixels(&pool, previous), 4096);
    assert_eq!(pixels(&pool, pending), 4096);
}

#[test]
fn resize_preserves_old_lease_but_invalidates_contents() {
    let mut pool = Pool::new();
    pool.resize(1280, 720);
    let old = pool.begin().unwrap();
    pool.commit(old);
    pool.resize(1920, 1080);
    assert!(!pool.commit(old));
    assert_eq!(pixels(&pool, old), 0);
    let new = pool.begin().unwrap();
    assert_eq!(pixels(&pool, new), 1920 * 1080);
    assert!(pool.release(old));
    let refreshed = pool.begin().unwrap();
    assert_eq!(pixels(&pool, refreshed), 1920 * 1080);
}

#[test]
fn abort_preserves_damage_and_bounds_clip() {
    let mut pool = Pool::new();
    assert!(!pool.resize(u32::MAX, 1080));
    assert!(pool.begin().is_none());
    pool.resize(65, 65);
    let first = pool.begin().unwrap();
    pool.commit(first);
    pool.release(first);
    pool.damage(64, 64, i32::MAX, i32::MAX);
    pool.damage(-100, -100, -1, -1);
    pool.damage(42, 42, 1, 1);
    let token = pool.begin().unwrap();
    assert_eq!(pixels(&pool, token), 1);
    pool.release(token); // A failed export is not a commit.
    let retry = pool.begin().unwrap();
    assert_eq!(pixels(&pool, retry), 1);
    pool.damage(i32::MIN, i32::MIN, i32::MAX, i32::MAX);
    assert_eq!(pixels(&pool, retry), 65 * 65);
}

#[test]
fn ffi_rejects_nulls() {
    use crate::lease_ffi::*;
    // SAFETY: nulls are explicitly supported by the ABI; no allocation is supplied.
    unsafe {
        bp_pool_free(std::ptr::null_mut());
        assert!(!bp_pool_begin(std::ptr::null_mut(), std::ptr::null_mut()));
        assert!(!bp_pool_resize(std::ptr::null_mut(), 1280, 720));
        assert!(!bp_pool_end(std::ptr::null_mut(), std::ptr::null(), false));
    }
}
