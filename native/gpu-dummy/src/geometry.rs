/// Maximum root allocation is 64 MiB; dimensions can be exact, not CVT-rounded.
pub(crate) fn geometry(width: u32, height: u32) -> Option<(u32, u64)> {
    if !(32..=8192).contains(&width) || !(32..=8192).contains(&height) {
        return None;
    }
    let stride = width.checked_mul(4)?;
    let bytes = u64::from(stride).checked_mul(u64::from(height))?;
    (bytes <= 64 * 1024 * 1024).then_some((stride, bytes))
}
