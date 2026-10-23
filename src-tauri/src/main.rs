// A release build on Windows is a window app, without a console window beside it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// MinGW links its own default manifest beside Cove's (build.rs), and ld reports keeping Cove's
// as ".rsrc merge failure: multiple non-default manifests". Only that toolchain says it.
#![cfg_attr(all(windows, target_env = "gnu"), allow(linker_messages))]

fn main() {
    nimbus_lib::run();
}
