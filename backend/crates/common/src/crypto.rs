use crate::error::{AppError, AppResult};
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rand::RngCore;

#[derive(Clone)]
pub struct Aes256GcmCipher {
    key: [u8; 32],
}

#[derive(Debug, Clone)]
pub struct EncryptedPayload {
    pub ciphertext_b64: String,
    pub nonce_b64: String,
}

impl Aes256GcmCipher {
    pub fn new(key: [u8; 32]) -> Self {
        Self { key }
    }

    /// Generates a fresh 96-bit random nonce per encryption call so identical
    /// API secrets never produce identical ciphertexts or reuse keystreams.
    pub fn encrypt(&self, plaintext: &str) -> AppResult<EncryptedPayload> {
        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|e| AppError::Crypto(format!("failed to initialize AES-256-GCM: {e}")))?;

        let mut nonce_bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|e| AppError::Crypto(format!("encryption failed: {e}")))?;

        Ok(EncryptedPayload {
            ciphertext_b64: BASE64.encode(ciphertext),
            nonce_b64: BASE64.encode(nonce_bytes),
        })
    }

    pub fn decrypt(&self, ciphertext_b64: &str, nonce_b64: &str) -> AppResult<String> {
        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|e| AppError::Crypto(format!("failed to initialize AES-256-GCM: {e}")))?;

        let ciphertext = BASE64
            .decode(ciphertext_b64)
            .map_err(|e| AppError::Crypto(format!("invalid base64 ciphertext: {e}")))?;
        let nonce_bytes = BASE64
            .decode(nonce_b64)
            .map_err(|e| AppError::Crypto(format!("invalid base64 nonce: {e}")))?;

        if nonce_bytes.len() != 12 {
            return Err(AppError::Crypto(
                "nonce must be exactly 12 bytes (96 bits)".to_string(),
            ));
        }

        let nonce = Nonce::from_slice(&nonce_bytes);
        let plaintext = cipher.decrypt(nonce, ciphertext.as_ref()).map_err(|_| {
            AppError::Crypto("decryption failed or authentication tag mismatch".to_string())
        })?;

        String::from_utf8(plaintext)
            .map_err(|e| AppError::Crypto(format!("decrypted payload is not valid UTF-8: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_roundtrip_and_unique_nonce() {
        let key = [0x42u8; 32];
        let cipher = Aes256GcmCipher::new(key);
        let secret = "binance_futures_secret_example_99887766";

        let p1 = cipher.encrypt(secret).unwrap();
        let p2 = cipher.encrypt(secret).unwrap();

        assert_ne!(p1.nonce_b64, p2.nonce_b64);
        assert_ne!(p1.ciphertext_b64, p2.ciphertext_b64);

        let d1 = cipher.decrypt(&p1.ciphertext_b64, &p1.nonce_b64).unwrap();
        let d2 = cipher.decrypt(&p2.ciphertext_b64, &p2.nonce_b64).unwrap();
        assert_eq!(d1, secret);
        assert_eq!(d2, secret);
    }

    #[test]
    fn decrypt_fails_with_wrong_key() {
        let c1 = Aes256GcmCipher::new([0x11u8; 32]);
        let c2 = Aes256GcmCipher::new([0x22u8; 32]);
        let encrypted = c1.encrypt("top_secret").unwrap();
        assert!(c2
            .decrypt(&encrypted.ciphertext_b64, &encrypted.nonce_b64)
            .is_err());
    }
}
