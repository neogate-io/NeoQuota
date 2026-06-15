#![recursion_limit = "256"]

mod cpa;
mod models;
mod pricing;
mod quota;
mod secrets;
mod service;
mod storage;

use std::sync::Arc;

use models::{SaveCollectorSettings, SaveEmailAlertSettings, SaveTargetRequest};
use serde_json::Value;
use service::AppService;
use storage::Storage;
use tauri::{
    include_image, menu::MenuBuilder, tray::TrayIconBuilder, Emitter, Manager, RunEvent,
    WindowEvent,
};

#[tauri::command]
async fn get_app_state(state: tauri::State<'_, Arc<AppService>>) -> Result<Value, String> {
    state.get_app_state().map_err(to_command_error)
}

#[tauri::command]
async fn list_targets(state: tauri::State<'_, Arc<AppService>>) -> Result<Value, String> {
    state
        .list_targets()
        .map(|targets| serde_json::to_value(targets).unwrap_or(Value::Null))
        .map_err(to_command_error)
}

#[tauri::command]
async fn save_target(
    state: tauri::State<'_, Arc<AppService>>,
    target: SaveTargetRequest,
) -> Result<Value, String> {
    state
        .save_target(target)
        .map(|target| serde_json::to_value(target).unwrap_or(Value::Null))
        .map_err(to_command_error)
}

#[tauri::command]
async fn delete_target(
    state: tauri::State<'_, Arc<AppService>>,
    target_id: String,
) -> Result<Value, String> {
    state
        .delete_target(target_id)
        .map(|_| serde_json::json!({ "ok": true }))
        .map_err(to_command_error)
}

#[tauri::command]
async fn test_target_connection(
    state: tauri::State<'_, Arc<AppService>>,
    target: SaveTargetRequest,
) -> Result<Value, String> {
    state
        .test_target_connection(target)
        .await
        .map_err(to_command_error)
}

#[tauri::command]
async fn get_latest(
    state: tauri::State<'_, Arc<AppService>>,
    cpa_id: Option<String>,
) -> Result<Value, String> {
    state.latest_payload(cpa_id).map_err(to_command_error)
}

#[tauri::command]
async fn refresh_target(
    state: tauri::State<'_, Arc<AppService>>,
    cpa_id: String,
) -> Result<Value, String> {
    state.refresh_target(cpa_id).await.map_err(to_command_error)
}

#[tauri::command]
async fn refresh_account(
    state: tauri::State<'_, Arc<AppService>>,
    cpa_id: String,
    account_key: String,
) -> Result<Value, String> {
    state
        .refresh_account(cpa_id, account_key)
        .await
        .map_err(to_command_error)
}

#[tauri::command]
async fn set_account_disabled(
    state: tauri::State<'_, Arc<AppService>>,
    cpa_id: String,
    auth_file_name: String,
    disabled: bool,
) -> Result<Value, String> {
    state
        .set_account_disabled(cpa_id, auth_file_name, disabled)
        .await
        .map_err(to_command_error)
}

#[tauri::command]
async fn delete_account_credential(
    state: tauri::State<'_, Arc<AppService>>,
    cpa_id: String,
    auth_file_name: String,
) -> Result<Value, String> {
    state
        .delete_account_credential(cpa_id, auth_file_name)
        .await
        .map_err(to_command_error)
}

#[tauri::command]
async fn clear_history(
    state: tauri::State<'_, Arc<AppService>>,
    cpa_id: Option<String>,
) -> Result<Value, String> {
    state.clear_history(cpa_id).map_err(to_command_error)
}

#[tauri::command]
async fn get_pricing(state: tauri::State<'_, Arc<AppService>>) -> Result<Value, String> {
    Ok(state.get_pricing())
}

#[tauri::command]
async fn save_pricing(
    state: tauri::State<'_, Arc<AppService>>,
    profile: Value,
) -> Result<Value, String> {
    state.save_pricing(profile).map_err(to_command_error)
}

#[tauri::command]
async fn get_alert_settings(state: tauri::State<'_, Arc<AppService>>) -> Result<Value, String> {
    state.get_alert_settings().map_err(to_command_error)
}

#[tauri::command]
async fn save_alert_settings(
    state: tauri::State<'_, Arc<AppService>>,
    settings: SaveEmailAlertSettings,
) -> Result<Value, String> {
    state
        .save_alert_settings(settings)
        .map_err(to_command_error)
}

#[tauri::command]
async fn send_test_email(
    state: tauri::State<'_, Arc<AppService>>,
    settings: SaveEmailAlertSettings,
) -> Result<Value, String> {
    state.send_test_email(settings).map_err(to_command_error)
}

#[tauri::command]
async fn save_collector_settings(
    state: tauri::State<'_, Arc<AppService>>,
    settings: SaveCollectorSettings,
) -> Result<Value, String> {
    state
        .save_collector_settings(settings)
        .map_err(to_command_error)
}

#[tauri::command]
async fn export_snapshot(
    state: tauri::State<'_, Arc<AppService>>,
    cpa_id: String,
) -> Result<Value, String> {
    state.export_snapshot(cpa_id).map_err(to_command_error)
}

#[tauri::command]
async fn pause_collector(state: tauri::State<'_, Arc<AppService>>) -> Result<Value, String> {
    state.pause_collector().map_err(to_command_error)
}

#[tauri::command]
async fn resume_collector(state: tauri::State<'_, Arc<AppService>>) -> Result<Value, String> {
    state.resume_collector().map_err(to_command_error)
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            let storage = Storage::new(config_dir, data_dir)?;
            let service = AppService::new(storage)?;
            service.set_app_handle(app.handle().clone());
            service.start_background();
            app.manage(Arc::clone(&service));
            setup_tray(app.handle(), service)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_state,
            list_targets,
            save_target,
            delete_target,
            test_target_connection,
            get_latest,
            refresh_target,
            refresh_account,
            set_account_disabled,
            delete_account_credential,
            clear_history,
            get_pricing,
            save_pricing,
            get_alert_settings,
            save_alert_settings,
            send_test_email,
            save_collector_settings,
            export_snapshot,
            pause_collector,
            resume_collector
        ])
        .build(tauri::generate_context!())
        .expect("error while building NeoQuota desktop app")
        .run(|app, event| {
            if let RunEvent::Reopen { .. } = event {
                show_main_window(app);
            }
        });
}

fn setup_tray(app: &tauri::AppHandle, service: Arc<AppService>) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("show", "显示窗口")
        .text("collect", "立即采集")
        .text("pause", "暂停/恢复监控")
        .separator()
        .text("quit", "退出")
        .build()?;
    #[cfg(target_os = "macos")]
    let tray_icon = include_image!("icons/tray-template.png");
    #[cfg(not(target_os = "macos"))]
    let tray_icon = include_image!("icons/32x32.png");

    let mut builder = TrayIconBuilder::with_id("main")
        .icon(tray_icon)
        .menu(&menu)
        .tooltip("NeoQuota")
        .show_menu_on_left_click(true);

    #[cfg(target_os = "macos")]
    {
        builder = builder.icon_as_template(true);
    }

    builder
        .on_menu_event(move |app, event| {
            let id = event.id().0.as_str();
            match id {
                "show" => show_main_window(app),
                "collect" => {
                    let service = Arc::clone(&service);
                    tauri::async_runtime::spawn(async move {
                        service.collect_first_enabled().await;
                    });
                }
                "pause" => {
                    if let Ok(state) = service.toggle_collector() {
                        let _ = app.emit("collector-paused", state);
                    }
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn to_command_error(error: anyhow::Error) -> String {
    error.to_string()
}
