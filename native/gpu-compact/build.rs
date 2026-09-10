use std::process::Command;

fn main() {
    let output = std::env::var("OUT_DIR").expect("Cargo supplies OUT_DIR");
    for source in ["context", "capture", "motion", "profile"] {
        let status = Command::new("cc")
            .args([
                "-std=c11",
                "-D_GNU_SOURCE",
                "-O2",
                "-Wall",
                "-Wextra",
                "-Werror",
                "-c",
            ])
            .arg(format!("abi/{source}.c"))
            .args(["-o", &format!("{output}/{source}.o")])
            .status()
            .expect("C compiler");
        assert!(status.success(), "C adapter must compile");
        println!("cargo:rerun-if-changed=abi/{source}.c");
    }
    let status = Command::new("ar")
        .args([
            "crs",
            &format!("{output}/libcompact.a"),
            &format!("{output}/context.o"),
            &format!("{output}/capture.o"),
            &format!("{output}/motion.o"),
            &format!("{output}/profile.o"),
        ])
        .status()
        .expect("archiver");
    assert!(status.success());
    println!("cargo:rerun-if-changed=abi/compact.h");
    println!("cargo:rustc-link-search=native={output}");
    for name in ["static=compact", "epoxy", "gbm"] {
        println!("cargo:rustc-link-lib={name}");
    }
}
