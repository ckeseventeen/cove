fn main() {
    println!("cargo:rerun-if-changed=src/mpv_view.m");
    #[cfg(target_os = "macos")]
    {
        let prefix = std::env::var("NIMBUS_MPV_PREFIX").unwrap_or_else(|_| {
            if std::path::Path::new("/opt/homebrew/include/mpv").exists() {
                "/opt/homebrew".into()
            } else {
                "/usr/local".into()
            }
        });
        println!("cargo:rerun-if-env-changed=NIMBUS_MPV_PREFIX");
        cc::Build::new()
            .file("src/mpv_view.m")
            .flag("-fobjc-arc")
            .include(format!("{prefix}/include"))
            .compile("nimbus_mpv_view");
        println!("cargo:rustc-link-search=native={prefix}/lib");
        println!("cargo:rustc-link-lib=framework=Cocoa");
        println!("cargo:rustc-link-lib=framework=OpenGL");
        println!("cargo:rustc-link-arg=-Wl,-rpath,{prefix}/lib");
        println!("cargo:rustc-link-arg=-Wl,-headerpad_max_install_names");
    }
    println!("cargo:rerun-if-changed=../.env");
    println!("cargo:rerun-if-env-changed=NIMBUS_BUNDLE_PERSONAL_CONFIG");
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let env_candidates = [
        std::path::PathBuf::from(&manifest_dir).join("../.env"),
        std::path::PathBuf::from("../.env"),
        std::path::PathBuf::from(".env"),
    ];
    let contents = if std::env::var("NIMBUS_BUNDLE_PERSONAL_CONFIG").as_deref() == Ok("1") {
        env_candidates
            .iter()
            .find_map(|p| std::fs::read_to_string(p).ok())
            .unwrap_or_default()
    } else {
        String::new()
    };
    let value = |name: &str| {
        contents
            .lines()
            .filter_map(|line| line.trim().split_once('='))
            .find(|(key, _)| key.trim() == name)
            .map(|(_, value)| value.trim().trim_matches(['\'', '"']).to_owned())
            .unwrap_or_default()
    };
    let baidu_key = value("NIMBUS_BAIDU_APP_KEY");
    let baidu_secret = value("NIMBUS_BAIDU_SECRET_KEY");
    let baidu_redirect = value("NIMBUS_BAIDU_REDIRECT_URI");
    let tmdb_token = value("NIMBUS_TMDB_READ_ACCESS_TOKEN");
    if std::env::var("NIMBUS_BUNDLE_PERSONAL_CONFIG").as_deref() == Ok("1") {
        println!(
            "cargo:warning=Bundling personal config: Baidu key len={}, TMDB token len={}",
            baidu_key.len(),
            tmdb_token.len()
        );
    } else {
        println!(
            "cargo:warning=Personal config bundling disabled (NIMBUS_BUNDLE_PERSONAL_CONFIG != 1)"
        );
    }
    let generated = format!(
        "const BUNDLED_BAIDU_APP_KEY: &str = {:?};\nconst BUNDLED_BAIDU_SECRET_KEY: &str = {:?};\nconst BUNDLED_BAIDU_REDIRECT_URI: &str = {:?};\nconst BUNDLED_TMDB_READ_ACCESS_TOKEN: &str = {:?};\n",
        baidu_key,
        baidu_secret,
        baidu_redirect,
        tmdb_token
    );
    let output = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR missing"));
    std::fs::write(output.join("baidu_build_config.rs"), generated)
        .expect("failed to generate bundled Baidu configuration");
    tauri_build::build()
}
