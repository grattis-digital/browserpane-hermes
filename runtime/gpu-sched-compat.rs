//! Experimental Linux/glibc interposer, NOT an X11 or GPU driver.
//! Mesa's optional SCHED_BATCH hint targets a worker TID; Chromium's GPU
//! sandbox rejects that syscall. Decline only that hint with EPERM instead.
//! No syscall filter, device permission, or sandbox check is weakened.
//! Requires the explicit v3d backend; only the Chromium process tree preloads it.
#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
compile_error!("This experimental adapter supports Linux/glibc only");

use std::ffi::{c_char, c_int, c_void};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};

#[repr(C)]
pub struct SchedParam {
    sched_priority: c_int,
}

type SetSched = unsafe extern "C" fn(usize, c_int, *const SchedParam) -> c_int;
static NEXT: OnceLock<Option<SetSched>> = OnceLock::new();
static WARNED: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "linux")]
#[link(name = "dl")]
extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn getenv(name: *const c_char) -> *const c_char;
    fn write(fd: c_int, buf: *const c_void, count: usize) -> isize;
}

fn decline_hint(enabled: bool, policy: c_int, priority: Option<c_int>) -> bool {
    enabled && policy == 3 /* Linux SCHED_BATCH */ && priority == Some(0)
}

/// Same pointer validity requirements as glibc's pthread_setschedparam.
/// pthread APIs return error codes directly, without changing errno.
#[cfg(target_os = "linux")]
#[no_mangle]
pub unsafe extern "C" fn pthread_setschedparam(
    thread: usize,
    policy: c_int,
    param: *const SchedParam,
) -> c_int {
    let setting = getenv(b"BPANE_GPU_SKIP_BATCH_SCHED\0".as_ptr().cast());
    let enabled = !setting.is_null() && *setting == b'1' as c_char && *setting.add(1) == 0;
    let priority = if enabled && policy == 3 && !param.is_null() {
        Some((*param).sched_priority)
    } else {
        None
    };
    if decline_hint(enabled, policy, priority) {
        if !WARNED.swap(true, Ordering::Relaxed) {
            let message = b"browserpane GPU compatibility: declined optional SCHED_BATCH hint (EPERM)\n";
            write(2, message.as_ptr().cast(), message.len());
        }
        return 1; // EPERM, not a forged success.
    }
    let next = NEXT.get_or_init(|| {
        // RTLD_NEXT is ((void *) -1) on Linux/glibc.
        let symbol = dlsym(
            (-1_isize) as *mut c_void,
            b"pthread_setschedparam\0".as_ptr().cast(),
        );
        if symbol.is_null() {
            None
        } else {
            Some(std::mem::transmute::<*mut c_void, SetSched>(symbol))
        }
    });
    match next {
        Some(call) => call(thread, policy, param),
        None => 38, // ENOSYS: fail closed if the real function cannot be found.
    }
}

#[cfg(test)]
mod tests {
    use super::decline_hint;

    #[test]
    fn only_opted_in_batch_hint_is_declined() {
        assert!(decline_hint(true, 3, Some(0)));
        assert!(!decline_hint(false, 3, Some(0)));
        assert!(!decline_hint(true, 3, None));
        assert!(!decline_hint(true, 3, Some(1)));
        for policy in [0, 1, 2, 5, 6, -1] {
            assert!(!decline_hint(true, policy, Some(0)));
        }
    }
}
