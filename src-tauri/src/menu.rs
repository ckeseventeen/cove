//! The macOS menu bar. Custom items emit `menu-action` events handled by the web windows.
use tauri::{
    menu::{AboutMetadata, IsMenuItem, Menu, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Wry,
};

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let item = |id: &str, text: &str, accelerator: Option<&str>| {
        let mut builder = tauri::menu::MenuItemBuilder::with_id(id, text);
        if let Some(accelerator) = accelerator {
            builder = builder.accelerator(accelerator);
        }
        builder.build(app)
    };
    let separator = || PredefinedMenuItem::separator(app);

    let about = PredefinedMenuItem::about(
        app,
        Some("关于 Cove"),
        Some(AboutMetadata {
            name: Some("Cove".into()),
            version: Some(app.package_info().version.to_string()),
            comments: Some("你的私人媒体空间".into()),
            ..Default::default()
        }),
    )?;
    let settings = item("cove.settings", "设置…", Some("CmdOrCtrl+,"))?;
    let services = PredefinedMenuItem::services(app, Some("服务"))?;
    let hide = PredefinedMenuItem::hide(app, Some("隐藏 Cove"))?;
    let hide_others = PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?;
    let show_all = PredefinedMenuItem::show_all(app, Some("全部显示"))?;
    let quit = PredefinedMenuItem::quit(app, Some("退出 Cove"))?;
    let app_menu = Submenu::with_items(
        app,
        "Cove",
        true,
        &[
            &about,
            &separator()?,
            &settings,
            &separator()?,
            &services,
            &separator()?,
            &hide,
            &hide_others,
            &show_all,
            &separator()?,
            &quit,
        ],
    )?;

    let add_storage = item("cove.add-storage", "添加存储…", Some("CmdOrCtrl+N"))?;
    let new_folder = item("cove.new-folder", "新建文件夹", Some("Shift+CmdOrCtrl+N"))?;
    let new_playlist = item("cove.new-playlist", "新建播放列表", Some("Alt+CmdOrCtrl+N"))?;
    let close = PredefinedMenuItem::close_window(app, Some("关闭窗口"))?;
    let file_menu = Submenu::with_items(
        app,
        "文件",
        true,
        &[&add_storage, &new_folder, &new_playlist, &separator()?, &close],
    )?;

    let undo = PredefinedMenuItem::undo(app, Some("撤销"))?;
    let redo = PredefinedMenuItem::redo(app, Some("重做"))?;
    let cut = PredefinedMenuItem::cut(app, Some("剪切"))?;
    let copy = PredefinedMenuItem::copy(app, Some("拷贝"))?;
    let paste = PredefinedMenuItem::paste(app, Some("粘贴"))?;
    let select_all = PredefinedMenuItem::select_all(app, Some("全选"))?;
    let find = item("cove.find", "查找", Some("CmdOrCtrl+F"))?;
    let edit_menu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &undo,
            &redo,
            &separator()?,
            &cut,
            &copy,
            &paste,
            &select_all,
            &separator()?,
            &find,
        ],
    )?;

    let home = item("cove.go.home", "首页", Some("CmdOrCtrl+1"))?;
    let movies = item("cove.go.movies", "影视", Some("CmdOrCtrl+2"))?;
    let music = item("cove.go.music", "音乐", Some("CmdOrCtrl+3"))?;
    let documents = item("cove.go.documents", "文档", Some("CmdOrCtrl+4"))?;
    let back = item("cove.back", "返回", Some("CmdOrCtrl+["))?;
    let forward = item("cove.forward", "前进", Some("CmdOrCtrl+]"))?;
    let sidebar = item("cove.toggle-sidebar", "显示/隐藏边栏", Some("Ctrl+CmdOrCtrl+S"))?;
    let lyrics = item("cove.show-lyrics", "歌词", Some("Alt+CmdOrCtrl+L"))?;
    let queue = item("cove.show-queue", "待播清单", Some("Alt+CmdOrCtrl+U"))?;
    let fullscreen = PredefinedMenuItem::fullscreen(app, Some("进入全屏幕"))?;
    let view_menu = Submenu::with_items(
        app,
        "显示",
        true,
        &[
            &home,
            &movies,
            &music,
            &documents,
            &separator()?,
            &back,
            &forward,
            &separator()?,
            &sidebar,
            &lyrics,
            &queue,
            &separator()?,
            &fullscreen,
        ],
    )?;

    let play_pause = item("cove.play-pause", "播放/暂停", None)?;
    let next = item("cove.next", "下一首", Some("CmdOrCtrl+Right"))?;
    let previous = item("cove.previous", "上一首", Some("CmdOrCtrl+Left"))?;
    let volume_up = item("cove.volume-up", "增大音量", Some("CmdOrCtrl+Up"))?;
    let volume_down = item("cove.volume-down", "减小音量", Some("CmdOrCtrl+Down"))?;
    let shuffle = item("cove.shuffle", "随机播放", None)?;
    let repeat = item("cove.repeat", "重复", None)?;
    let stop = item("cove.stop", "停止", Some("CmdOrCtrl+."))?;
    let controls_menu = Submenu::with_items(
        app,
        "控制",
        true,
        &[
            &play_pause,
            &stop,
            &next,
            &previous,
            &separator()?,
            &volume_up,
            &volume_down,
            &separator()?,
            &shuffle,
            &repeat,
        ],
    )?;

    let minimize = PredefinedMenuItem::minimize(app, Some("最小化"))?;
    let zoom = PredefinedMenuItem::maximize(app, Some("缩放"))?;
    let show_main = item("cove.show-window", "Cove", Some("CmdOrCtrl+0"))?;
    let front = PredefinedMenuItem::bring_all_to_front(app, Some("前置全部窗口"))?;
    let window_menu = Submenu::with_items(
        app,
        "窗口",
        true,
        &[&minimize, &zoom, &separator()?, &show_main, &separator()?, &front],
    )?;

    let help = item("cove.help", "Cove 帮助", None)?;
    let help_menu = Submenu::with_items(app, "帮助", true, &[&help])?;

    let items: [&dyn IsMenuItem<Wry>; 7] = [
        &app_menu,
        &file_menu,
        &edit_menu,
        &view_menu,
        &controls_menu,
        &window_menu,
        &help_menu,
    ];
    let menu = Menu::with_items(app, &items)?;
    window_menu.set_as_windows_menu_for_nsapp()?;
    help_menu.set_as_help_menu_for_nsapp()?;
    Ok(menu)
}

/// Route menu clicks to the web UI; window-level actions are handled natively.
pub fn handle(app: &AppHandle, id: &str) {
    if !id.starts_with("cove.") {
        return;
    }
    let playback = matches!(
        id,
        "cove.play-pause"
            | "cove.stop"
            | "cove.next"
            | "cove.previous"
            | "cove.volume-up"
            | "cove.volume-down"
            | "cove.shuffle"
            | "cove.repeat"
    );
    if !playback {
        crate::show_main_window(app);
    }
    let _ = app.emit("menu-action", id);
}
