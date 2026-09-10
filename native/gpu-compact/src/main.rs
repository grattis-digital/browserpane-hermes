//! Finite, synthetic GPU component experiment. No X11, browser, network or
//! production capture hook. All pixel oracles run outside measured spans.
mod config;
mod geometry;
mod gpu;
mod oracle;

use config::Config;
use geometry::Geometry;
use gpu::Gpu;

fn main() {
    if let Err(error) = run() {
        eprintln!("INVALID_EXPERIMENT: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let config = Config::parse(&args[1..])?;
    if !config.software && std::env::var("BPANE_GPU_COMPACT_PILOT").as_deref() != Ok("1") {
        return Err("hardware test requires explicit pilot gate".into());
    }
    // Odd edges/resize get separate fresh contexts; no previous-sized history.
    let sizes = if config.software {
        vec![(67, 73, 8), (487, 251, 8)]
    } else {
        vec![(1279, 719, 4), (1280, 720, 32)]
    };
    for (width, height, frames) in sizes {
        let geometry = Geometry::new(width, height)?;
        let mut gpu = Gpu::new(geometry, &config)?;
        for scene in 0..10 {
            scenario(&mut gpu, scene, frames)?;
        }
    }
    println!("{{\"complete\":true,\"scope\":\"synthetic-gpu-content-index\",\"pixelErrors\":0}}");
    Ok(())
}

fn scenario(gpu: &mut Gpu, scene: i32, frames: i32) -> Result<(), String> {
    let source_scene = if scene == 7 { 2 } else { scene };
    for index in [0, 2] {
        gpu.render(source_scene, 0, index)?;
        gpu.prime(index)?;
    }
    let checkpoint = oracle::fixture(gpu.geometry, source_scene, 0);
    let mut previous = checkpoint.clone();
    for frame in 1..=frames {
        let source_frame = if scene == 7 && frame % 2 == 0 {
            0
        } else {
            frame
        };
        gpu.render(source_scene, source_frame, frame % 2)?;
        // Every positive reuse candidate is discovered on GPU, not supplied.
        // The negative case deliberately overrides discovery with a wrong value.
        let valid = frame != 1;
        let (full, compact) = if frame % 2 == 0 {
            let compact = gpu.capture_compact(frame % 2, scene == 5, valid)?;
            (gpu.capture_full(frame % 2)?, compact)
        } else {
            let full = gpu.capture_full(frame % 2)?;
            (full, gpu.capture_compact(frame % 2, scene == 5, valid)?)
        };
        let count = gpu.header[0] as usize;
        if count > gpu.geometry.tiles() {
            return Err("GPU count exceeds capacity".into());
        }
        let expected = oracle::fixture(gpu.geometry, source_scene, source_frame as u32);
        let reconstructed = oracle::reconstruct(
            gpu.geometry,
            &previous,
            &checkpoint,
            &gpu.header,
            &gpu.payload[..count * 1024],
            valid,
        )?;
        if gpu.full != expected || reconstructed != expected {
            return Err(format!("pixel oracle failed: scene={scene} frame={frame}"));
        }
        let moves = gpu.header[1..=gpu.geometry.tiles()]
            .iter()
            .filter(|&&value| value == 1)
            .count();
        println!(
            "{{\"width\":{},\"height\":{},\"scene\":{scene},\"frame\":{frame},\"measured\":{},\"fullFirst\":{},\"dirtyTiles\":{count},\"moveTiles\":{moves},\"readbackBytes\":{},\"fullNs\":{},\"fullCpuNs\":{},\"compactNs\":{},\"compactCpuNs\":{},\"metadataNs\":{},\"payloadNs\":{},\"deduplicate\":{},\"profileStages\":{},\"stageQueryNs\":{:?}}}",
            gpu.geometry.width,
            gpu.geometry.height,
            frames == 32 && frame > 8,
            frame % 2 != 0,
            (3 * gpu.geometry.tiles() + 1) * 4 + count * 4096,
            full.wall_ns,
            full.cpu_ns,
            compact.wall_ns,
            compact.cpu_ns,
            compact.metadata_ns,
            compact.payload_ns,
            gpu.deduplicate,
            gpu.profile,
            compact.stage_query_ns
        );
        previous = expected;
    }
    Ok(())
}
