//! Handing things to the system: a web address to the browser, a file to its default app, and a
//! file shown in Finder or Explorer.
use std::path::Path;

use crate::error::{NimbusError, Result};

fn failed() -> NimbusError {
    NimbusError::Validation("系统应用未能打开该文件".into())
}

#[cfg(not(windows))]
mod system {
    use std::process::Command;

    use super::*;

    pub fn open_url(url: &str) -> Result<()> {
        Command::new("/usr/bin/open").arg(url).spawn()?;
        Ok(())
    }

    pub fn open_path(path: &Path) -> Result<()> {
        let status = Command::new("/usr/bin/open").arg(path).status()?;
        status.success().then_some(()).ok_or_else(failed)
    }

    pub fn reveal(path: &Path) -> Result<()> {
        let status = Command::new("/usr/bin/open").arg("-R").arg(path).status()?;
        status.success().then_some(()).ok_or_else(failed)
    }
}

#[cfg(windows)]
mod system {
    use std::{
        os::windows::{ffi::OsStrExt, process::CommandExt},
        process::Command,
        ptr::{null, null_mut},
    };

    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

    use super::*;

    fn shell_open(target: &std::ffi::OsStr) -> Result<()> {
        let verb: Vec<u16> = "open\0".encode_utf16().collect();
        let file: Vec<u16> = target.encode_wide().chain(std::iter::once(0)).collect();
        let result = unsafe { ShellExecuteW(null_mut(), verb.as_ptr(), file.as_ptr(), null(), null(), SW_SHOWNORMAL) };
        // Anything above 32 means it opened.
        if result as isize > 32 {
            Ok(())
        } else {
            Err(failed())
        }
    }

    pub fn open_url(url: &str) -> Result<()> {
        shell_open(std::ffi::OsStr::new(url))
    }

    pub fn open_path(path: &Path) -> Result<()> {
        shell_open(path.as_os_str())
    }

    pub fn reveal(path: &Path) -> Result<()> {
        // Explorer reads "/select," and the quoted path as one argument, so it goes in unescaped.
        Command::new("explorer.exe").raw_arg(format!("/select,\"{}\"", path.display())).spawn()?;
        Ok(())
    }
}

/// Open a web address in the default browser.
pub fn open_url(url: &str) -> Result<()> {
    system::open_url(url)
}

/// Open a file with its default app.
pub fn open_path(path: &Path) -> Result<()> {
    system::open_path(path)
}

/// Show a file selected in Finder or Explorer.
pub fn reveal(path: &Path) -> Result<()> {
    system::reveal(path)
}
