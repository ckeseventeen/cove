"""Run real Store regression tests (replaces the pre-fix SQL reproduction)."""
import pathlib
import subprocess
root = pathlib.Path(__file__).resolve().parents[1]
subprocess.run([str(pathlib.Path.home()/'.cargo/bin/cargo'),'test','--offline','--manifest-path',str(root/'src-tauri/Cargo.toml'),'store::tests'],check=True)
