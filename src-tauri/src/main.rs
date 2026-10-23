// A release build on Windows is a window app, without a console window beside it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nimbus_lib::run();
}
