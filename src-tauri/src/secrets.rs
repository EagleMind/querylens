//! OS keychain access (Windows Credential Manager, macOS Keychain, Secret Service).

use crate::error::AppResult;
use crate::model::LlmProviderKind;

const SERVICE: &str = "querylens";

pub fn connection_account(connection_id: &str) -> String {
    format!("conn:{connection_id}")
}

pub fn llm_account(provider: LlmProviderKind) -> String {
    format!("llm:{}", provider.as_str())
}

/// Store a secret; an empty value deletes it.
pub fn set(account: &str, secret: &str) -> AppResult<()> {
    if secret.is_empty() {
        return delete(account);
    }
    keyring::Entry::new(SERVICE, account)?.set_password(secret)?;
    Ok(())
}

pub fn get(account: &str) -> AppResult<Option<String>> {
    match keyring::Entry::new(SERVICE, account)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete(account: &str) -> AppResult<()> {
    match keyring::Entry::new(SERVICE, account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
