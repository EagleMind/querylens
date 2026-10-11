//! Release builds of the desktop app use the Windows GUI subsystem, which starts
//! without a console: attach to the terminal that launched us so CLI output shows.

#[cfg(windows)]
pub fn attach() {
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    unsafe extern "system" {
        fn AttachConsole(process_id: u32) -> i32;
    }
    // Fails harmlessly when a console is already attached (debug builds) or when
    // there is no parent console (stdio pipes, e.g. the MCP server).
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(not(windows))]
pub fn attach() {}
