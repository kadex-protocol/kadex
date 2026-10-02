#![cfg(feature = "integration")]
//! BLOCKED — see Blocker #6 in docs/implementation-plan.md.
//!
//! These tests are correct and compile, but cannot run on this toolchain:
//! Anchor 1.2 hardcodes `--arch v3`, and the litesvm versions that load
//! SBPF v3 require a newer rustc than platform-tools pins. Run with
//! `cargo test -p mock-amm --features integration` once that is resolved.

use litesvm::LiteSVM;

/// The Anchor 1.2 template pins litesvm 0.10, which predates SBPF v3 and
/// rejects every binary this toolchain produces. This test exists so that
/// failure mode is one obvious red line rather than ten confusing ones.
#[test]
fn litesvm_can_load_our_sbf_binary() {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/mock_amm.so"));
    svm.add_program(mock_amm::id(), bytes)
        .expect("litesvm rejected our SBF binary - check the litesvm version against the SBPF arch");
}
