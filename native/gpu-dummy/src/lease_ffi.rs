//! All pointers belong to the single Xorg thread. Arrays are fixed-size C ABI.

use crate::lease::Pool;

#[unsafe(no_mangle)]
pub extern "C" fn bp_pool_new() -> *mut Pool {
    Box::into_raw(Box::new(Pool::new()))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bp_pool_free(pool: *mut Pool) {
    if !pool.is_null() {
        // SAFETY: C relinquishes the unique allocation exactly once after callbacks stop.
        drop(unsafe { Box::from_raw(pool) });
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bp_pool_resize(pool: *mut Pool, width: u32, height: u32) -> bool {
    // SAFETY: C supplies a live exclusively accessed pool, or null.
    unsafe { pool.as_mut() }.is_some_and(|pool| pool.resize(width, height))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bp_pool_damage(pool: *mut Pool, x1: i32, y1: i32, x2: i32, y2: i32) {
    // SAFETY: C supplies a live exclusively accessed pool, or null.
    if let Some(pool) = unsafe { pool.as_mut() } {
        pool.damage(x1, y1, x2, y2);
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bp_pool_begin(pool: *mut Pool, output: *mut [u32; 3]) -> bool {
    // SAFETY: live pool and writable nonoverlapping uint32_t[3], or nulls.
    let (Some(pool), Some(output)) = (unsafe { pool.as_mut() }, unsafe { output.as_mut() }) else {
        return false;
    };
    let Some(token) = pool.begin() else {
        return false;
    };
    *output = token;
    true
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bp_pool_end(
    pool: *mut Pool,
    token: *const [u32; 3],
    commit: bool,
) -> bool {
    // SAFETY: live pool and readable nonoverlapping uint32_t[3], or nulls.
    let (Some(pool), Some(token)) = (unsafe { pool.as_mut() }, unsafe { token.as_ref() }) else {
        return false;
    };
    if commit {
        pool.commit(*token)
    } else {
        pool.release(*token)
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bp_pool_rect(
    pool: *const Pool,
    slot: u32,
    cursor: *mut u32,
    output: *mut [u32; 4],
) -> bool {
    // SAFETY: pool, writable cursor and uint32_t[4] are live and nonoverlapping.
    let (Some(pool), Some(cursor), Some(output)) = (
        unsafe { pool.as_ref() },
        unsafe { cursor.as_mut() },
        unsafe { output.as_mut() },
    ) else {
        return false;
    };
    let Some(rect) = pool.rectangle(slot, cursor) else {
        return false;
    };
    *output = rect;
    true
}
