//! Rust policy and bounded Present event ownership for an experimental Xorg DDX.
//! Xorg's versioned C structures stay in `abi/`; no Rust dependency or GPU kernel
//! driver is introduced. All callbacks belong to Xorg's single event-loop thread.

mod clock;
mod ffi;
mod geometry;
mod lease;
mod lease_ffi;

#[cfg(test)]
mod lease_tests;

#[cfg(test)]
mod tests;
