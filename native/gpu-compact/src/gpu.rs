use crate::{config::Config, geometry::Geometry};
use std::{
    ffi::{c_char, c_void},
    marker::PhantomData,
    ptr::NonNull,
    rc::Rc,
};

#[repr(C)]
#[derive(Default)]
pub(crate) struct Times {
    pub wall_ns: u64,
    pub cpu_ns: u64,
    pub metadata_ns: u64,
    pub payload_ns: u64,
    pub stage_query_ns: [u64; 4],
}

#[repr(C)]
struct Shader {
    source: *const c_char,
    length: i32,
}

unsafe extern "C" {
    fn bp_gpu_new(w: i32, h: i32, software: i32, flags: i32, sources: *const Shader)
    -> *mut c_void;
    fn bp_gpu_free(gpu: *mut c_void);
    fn bp_gpu_render(gpu: *mut c_void, scene: i32, frame: i32, index: i32) -> i32;
    fn bp_gpu_prime(gpu: *mut c_void, index: i32) -> i32;
    fn bp_gpu_full(gpu: *mut c_void, index: i32, output: *mut u32, times: *mut Times) -> i32;
    fn bp_gpu_compact(
        gpu: *mut c_void,
        index: i32,
        wrong_candidate: i32,
        valid: i32,
        header: *mut u32,
        payload: *mut u32,
        times: *mut Times,
    ) -> i32;
}

pub(crate) struct Gpu {
    pointer: NonNull<c_void>,
    pub geometry: Geometry,
    pub deduplicate: bool,
    pub profile: bool,
    // EGL context ownership must never cross threads.
    _thread: PhantomData<Rc<()>>,
    pub full: Vec<u32>,
    pub header: Vec<u32>,
    pub payload: Vec<u32>,
}

impl Gpu {
    pub fn new(geometry: Geometry, config: &Config) -> Result<Self, String> {
        let sources = [
            include_str!("../shaders/fixture.comp"),
            include_str!("../shaders/compact.comp"),
            include_str!("../shaders/rows.comp"),
            include_str!("../shaders/motion.comp"),
            include_str!("../shaders/index-clear.comp"),
        ]
        .map(|source| Shader {
            source: source.as_ptr().cast(),
            length: source.len() as i32,
        });
        // SAFETY: immutable static source spans with exact lengths; geometry is
        // constructor-validated and C copies/compiles sources before returning.
        let pointer = unsafe {
            bp_gpu_new(
                geometry.width as i32,
                geometry.height as i32,
                i32::from(config.software),
                config.flags(),
                sources.as_ptr(),
            )
        };
        Ok(Self {
            pointer: NonNull::new(pointer).ok_or("GPU initialization failed")?,
            geometry,
            deduplicate: config.deduplicate,
            profile: config.profile,
            _thread: PhantomData,
            full: vec![0; geometry.pixels()],
            header: vec![0; 3 * geometry.tiles() + 1],
            payload: vec![0; geometry.tiles() * 1024],
        })
    }

    pub fn render(&mut self, scene: i32, frame: i32, index: i32) -> Result<(), String> {
        // SAFETY: context is live and thread-bound; C validates scalar arguments.
        check(unsafe { bp_gpu_render(self.pointer.as_ptr(), scene, frame, index) })
    }

    pub fn prime(&mut self, index: i32) -> Result<(), String> {
        // SAFETY: live thread-bound context; C validates the texture index.
        check(unsafe { bp_gpu_prime(self.pointer.as_ptr(), index) })
    }

    pub fn capture_full(&mut self, index: i32) -> Result<Times, String> {
        let mut times = Times::default();
        // SAFETY: exclusively borrowed, live context and exactly width*height
        // writable u32s. C never retains these pointers.
        check(unsafe {
            bp_gpu_full(
                self.pointer.as_ptr(),
                index,
                self.full.as_mut_ptr(),
                &mut times,
            )
        })?;
        Ok(times)
    }

    pub fn capture_compact(
        &mut self,
        index: i32,
        wrong_candidate: bool,
        valid: bool,
    ) -> Result<Times, String> {
        let mut times = Times::default();
        // SAFETY: unique context; header is 3*tiles+1 words, payload is tiles*1024
        // words. C bounds the GPU count before copying; no pointers escape.
        check(unsafe {
            bp_gpu_compact(
                self.pointer.as_ptr(),
                index,
                i32::from(wrong_candidate),
                i32::from(valid),
                self.header.as_mut_ptr(),
                self.payload.as_mut_ptr(),
                &mut times,
            )
        })?;
        Ok(times)
    }
}

fn check(result: i32) -> Result<(), String> {
    if result == 1 {
        Ok(())
    } else {
        Err("GPU operation failed; experiment invalid".into())
    }
}

impl Drop for Gpu {
    fn drop(&mut self) {
        // SAFETY: unique owner, freed once on the original EGL thread.
        unsafe { bp_gpu_free(self.pointer.as_ptr()) };
    }
}
