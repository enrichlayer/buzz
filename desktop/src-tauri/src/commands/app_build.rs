/// Identity of the running binary, never of a checkout read at runtime.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBuildInfo {
    version: String,
    build_number: &'static str,
    revision: &'static str,
    built_at_ms: &'static str,
    source_state: &'static str,
    repository: &'static str,
}

/// Return the packaged version and compile-time provenance of this process.
#[tauri::command]
pub fn get_app_build_info(app: tauri::AppHandle) -> AppBuildInfo {
    AppBuildInfo {
        version: app.package_info().version.to_string(),
        build_number: env!("BUZZ_BUILD_NUMBER"),
        revision: env!("BUZZ_BUILD_REVISION"),
        built_at_ms: env!("BUZZ_BUILD_TIME_MS"),
        source_state: env!("BUZZ_BUILD_SOURCE_STATE"),
        repository: "https://github.com/enrichlayer/buzz",
    }
}
