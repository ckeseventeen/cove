use crate::{
    direct,
    error::{NimbusError, Result},
    model::StoredAccount,
    proxy::CredentialCache,
    store::Store,
};
use keyring::Entry;
use std::sync::Arc;
use zeroize::Zeroizing;
static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// One refresh boundary shared by commands and the streaming proxy.
pub async fn get(
    store: &Arc<Store>,
    cache: &CredentialCache,
    id: &str,
) -> Result<(StoredAccount, String)> {
    let _guard = REFRESH.lock().await;
    let stored = store.get_account(id)?;
    if stored.account.provider == "local" {
        return Ok((stored, String::new()));
    }
    let cached = cache.read().await.get(id).cloned();
    let credential = if let Some(value) = cached {
        value
    } else {
        let reference = stored.secret_ref.clone();
        let value = tokio::task::spawn_blocking(move || {
            Entry::new("app.nimbus.desktop", &reference)?.get_password()
        })
        .await
        .map_err(|e| NimbusError::Internal(e.to_string()))??;
        let value = Zeroizing::new(value);
        cache.write().await.insert(id.to_owned(), value.clone());
        value
    };
    let (token, updated) = direct::access_token(&stored.account.provider, &credential).await?;
    if let Some(updated) = updated {
        let reference = stored.secret_ref.clone();
        let secret = updated.clone();
        tokio::task::spawn_blocking(move || {
            Entry::new("app.nimbus.desktop", &reference)?.set_password(&secret)
        })
        .await
        .map_err(|e| NimbusError::Internal(e.to_string()))??;
        cache
            .write()
            .await
            .insert(id.to_owned(), Zeroizing::new(updated));
    }
    Ok((stored, token))
}

#[tauri::command]
pub(crate) async fn ai_key_load() -> Result<Option<String>> {
    tokio::task::spawn_blocking(|| {
        let entry = keyring::Entry::new("app.cove.desktop.ai", "last-used")?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.into()),
        }
    })
    .await
    .map_err(|error| NimbusError::Internal(error.to_string()))?
}
#[tauri::command]
pub(crate) async fn ai_key_save(value: String) -> Result<()> {
    tokio::task::spawn_blocking(move || {
        let secret = Zeroizing::new(value);
        let entry = keyring::Entry::new("app.cove.desktop.ai", "last-used")?;
        entry.set_password(&secret)?;
        Ok(())
    })
    .await
    .map_err(|error| NimbusError::Internal(error.to_string()))?
}
