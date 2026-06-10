use anyhow::{Context, Result};
use keyring::Entry;
#[cfg(target_os = "macos")]
use std::process::Command;

const SERVICE_NAME: &str = "NeoQuotaMonitor";

fn entry(name: &str) -> Result<Entry> {
    Entry::new(SERVICE_NAME, name).context("无法打开系统钥匙串条目")
}

pub fn target_key_name(target_id: &str) -> String {
    format!("target:{target_id}:management-key")
}

pub fn smtp_password_name() -> &'static str {
    "smtp:password"
}

pub fn set_secret(name: &str, secret: &str) -> Result<()> {
    let keyring_result = entry(name).and_then(|entry| {
        entry
            .set_password(secret)
            .context("保存密钥到系统钥匙串失败")
    });
    #[cfg(target_os = "macos")]
    let macos_result = macos_security_set(name, secret);
    #[cfg(not(target_os = "macos"))]
    let macos_result: Result<()> = Ok(());

    match get_secret(name) {
        Ok(Some(value)) if value == secret => Ok(()),
        Ok(Some(_)) => anyhow::bail!("系统钥匙串读回的密钥与写入值不一致"),
        Ok(None) => match (keyring_result, macos_result) {
            (Err(keyring_error), Err(macos_error)) => Err(keyring_error)
                .with_context(|| format!("macOS security fallback 也失败：{macos_error}")),
            (Err(error), _) | (_, Err(error)) => {
                Err(error).context("密钥写入后无法从系统钥匙串读回")
            }
            (Ok(()), Ok(())) => anyhow::bail!("密钥写入后无法从系统钥匙串读回"),
        },
        Err(error) => Err(error).context("密钥写入后读回校验失败"),
    }
}

pub fn get_secret(name: &str) -> Result<Option<String>> {
    match entry(name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => {
            #[cfg(target_os = "macos")]
            {
                macos_security_get(name)
            }
            #[cfg(not(target_os = "macos"))]
            {
                Ok(None)
            }
        }
        Err(error) => Err(error).context("读取系统钥匙串失败"),
    }
}

pub fn delete_secret(name: &str) -> Result<()> {
    let result = match entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error).context("删除系统钥匙串密钥失败"),
    };
    #[cfg(target_os = "macos")]
    macos_security_delete(name)?;
    result
}

#[cfg(target_os = "macos")]
fn macos_security_set(name: &str, secret: &str) -> Result<()> {
    let status = Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            SERVICE_NAME,
            "-a",
            name,
            "-w",
            secret,
        ])
        .status()
        .context("调用 macOS security 写入钥匙串失败")?;
    if status.success() {
        Ok(())
    } else {
        anyhow::bail!("macOS security 写入钥匙串失败，退出码：{status}")
    }
}

#[cfg(target_os = "macos")]
fn macos_security_get(name: &str) -> Result<Option<String>> {
    let output = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            SERVICE_NAME,
            "-a",
            name,
            "-w",
        ])
        .output()
        .context("调用 macOS security 读取钥匙串失败")?;
    if output.status.success() {
        let value = String::from_utf8(output.stdout)
            .context("macOS security 返回了非 UTF-8 密钥")?
            .trim_end_matches(['\r', '\n'])
            .to_string();
        Ok(Some(value))
    } else {
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
fn macos_security_delete(name: &str) -> Result<()> {
    let output = Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-s", SERVICE_NAME, "-a", name])
        .output()
        .context("调用 macOS security 删除钥匙串密钥失败")?;
    if output.status.success()
        || String::from_utf8_lossy(&output.stderr).contains("could not be found")
    {
        Ok(())
    } else {
        anyhow::bail!(
            "macOS security 删除钥匙串密钥失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }
}
