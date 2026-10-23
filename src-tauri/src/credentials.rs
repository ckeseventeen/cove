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

/// The service account secrets are saved under (named before Cove was Cove).
pub(crate) const SERVICE: &str = "app.nimbus.desktop";

/// A Windows credential holds 2,560 bytes, stored as UTF-16: 1,280 characters, fewer than a OneDrive
/// sign-in. Longer secrets are kept in numbered parts there; the Keychain takes them whole.
const PART: usize = if cfg!(windows) { 1000 } else { usize::MAX };
const PARTS_MARK: &str = "cove-parts:";

/// `value` cut into pieces of at most `limit` UTF-16 units, never inside a character.
fn split_secret(value: &str, limit: usize) -> Vec<String> {
    let mut parts = vec![String::new()];
    let mut units = 0;
    for character in value.chars() {
        if units + character.len_utf16() > limit {
            parts.push(String::new());
            units = 0;
        }
        units += character.len_utf16();
        parts.last_mut().expect("one part at least").push(character);
    }
    parts
}

fn part_name(user: &str, index: usize) -> String {
    format!("{user}#{index}")
}

/// A saved secret from the Keychain (macOS) or the Credential Manager (Windows).
pub(crate) fn secret_get(service: &str, user: &str) -> keyring::Result<String> {
    let value = Entry::new(service, user)?.get_password()?;
    let Some(count) = value.strip_prefix(PARTS_MARK).and_then(|count| count.parse::<usize>().ok()) else {
        return Ok(value);
    };
    let mut joined = String::new();
    for index in 1..=count {
        joined.push_str(&Entry::new(service, &part_name(user, index))?.get_password()?);
    }
    Ok(joined)
}

/// How many parts the secret saved for `user` is kept in (0 when it is kept whole, or missing).
fn saved_parts(service: &str, user: &str) -> usize {
    Entry::new(service, user)
        .and_then(|entry| entry.get_password())
        .ok()
        .and_then(|value| value.strip_prefix(PARTS_MARK).and_then(|count| count.parse().ok()))
        .unwrap_or(0)
}

fn delete_parts(service: &str, user: &str, from: usize, to: usize) {
    for index in from..=to {
        let _ = Entry::new(service, &part_name(user, index)).and_then(|part| part.delete_credential());
    }
}

/// Save a secret, replacing what was saved; parts the new one no longer needs are removed after.
pub(crate) fn secret_set(service: &str, user: &str, value: &str) -> keyring::Result<()> {
    let previous = saved_parts(service, user);
    let parts = split_secret(value, PART);
    if parts.len() == 1 {
        Entry::new(service, user)?.set_password(value)?;
        delete_parts(service, user, 1, previous);
        return Ok(());
    }
    for (index, part) in parts.iter().enumerate() {
        Entry::new(service, &part_name(user, index + 1))?.set_password(part)?;
    }
    Entry::new(service, user)?.set_password(&format!("{PARTS_MARK}{}", parts.len()))?;
    delete_parts(service, user, parts.len() + 1, previous);
    Ok(())
}

/// Forget a secret and any parts of it; nothing saved is not an error.
pub(crate) fn secret_delete(service: &str, user: &str) {
    delete_parts(service, user, 1, saved_parts(service, user));
    let _ = Entry::new(service, user).and_then(|entry| entry.delete_credential());
}

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
        let value = tokio::task::spawn_blocking(move || secret_get(SERVICE, &reference))
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
        tokio::task::spawn_blocking(move || secret_set(SERVICE, &reference, &secret))
        .await
        .map_err(|e| NimbusError::Internal(e.to_string()))??;
        cache
            .write()
            .await
            .insert(id.to_owned(), Zeroizing::new(updated));
    }
    Ok((stored, token))
}

/// Replaces an account's saved password or token in place (reconnecting), inside the same
/// boundary so a refresh in flight cannot write the old login back.
pub async fn replace(
    cache: &CredentialCache,
    stored: &StoredAccount,
    secret: Zeroizing<String>,
) -> Result<()> {
    let _guard = REFRESH.lock().await;
    let reference = stored.secret_ref.clone();
    let value = secret.clone();
    tokio::task::spawn_blocking(move || secret_set(SERVICE, &reference, &value))
    .await
    .map_err(|e| NimbusError::Internal(e.to_string()))??;
    cache.write().await.insert(stored.account.id.clone(), secret);
    Ok(())
}

#[tauri::command]
pub(crate) async fn ai_key_load() -> Result<Option<String>> {
    tokio::task::spawn_blocking(|| {
        match secret_get("app.cove.desktop.ai", "last-used") {
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
        secret_set("app.cove.desktop.ai", "last-used", &secret)?;
        Ok(())
    })
    .await
    .map_err(|error| NimbusError::Internal(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_secrets_split_without_breaking_characters() {
        assert_eq!(split_secret("short", 1000), vec!["short"]);
        let token = "a".repeat(2500);
        let parts = split_secret(&token, 1000);
        assert_eq!(parts.iter().map(String::len).collect::<Vec<_>>(), vec![1000, 1000, 500]);
        assert_eq!(parts.concat(), token);
        // "𝄞" takes two UTF-16 units and stays whole.
        assert_eq!(split_secret("ab𝄞c", 3), vec!["ab", "𝄞c"]);
        assert_eq!(split_secret("", 3), vec![""]);
    }
}
