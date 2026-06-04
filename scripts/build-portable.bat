@echo off
set CARGO_TARGET_DIR=E:\.cargo-target
call npx --prefix desktop tauri build
