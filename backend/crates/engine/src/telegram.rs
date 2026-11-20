use reqwest::Client;
use serde_json::json;
use sqlx::PgPool;
use std::time::Duration;
use tracing::{error, info, warn};
use uuid::Uuid;

#[derive(Clone)]
pub struct TelegramNotifier {
    http: Client,
    bot_token: String,
    admin_chat_id: String,
}

impl TelegramNotifier {
    pub fn new(bot_token: String, admin_chat_id: String) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| Client::new());

        Self {
            http,
            bot_token,
            admin_chat_id,
        }
    }

    pub async fn notify_user(
        &self,
        pool: &PgPool,
        user_id: Uuid,
        chat_id: Option<&str>,
        alert_type: &str,
        message: &str,
    ) {
        let target_chat = match chat_id.filter(|s| !s.trim().is_empty()) {
            Some(id) => id,
            None => {
                if !self.admin_chat_id.is_empty() {
                    self.admin_chat_id.as_str()
                } else {
                    warn!(user_id = %user_id, alert_type = alert_type, "telegram chat_id unavailable; alert skipped");
                    return;
                }
            }
        };

        if self.bot_token.trim().is_empty() {
            warn!(user_id = %user_id, alert_type = alert_type, "TELEGRAM_BOT_TOKEN not configured");
            return;
        }

        let url = format!("https://api.telegram.org/bot{}/sendMessage", self.bot_token);
        let payload = json!({
            "chat_id": target_chat,
            "text": message,
            "parse_mode": "HTML"
        });

        let (delivered, error_detail) = match self.http.post(&url).json(&payload).send().await {
            Ok(resp) if resp.status().is_success() => {
                info!(user_id = %user_id, alert_type = alert_type, "telegram alert delivered");
                (true, None)
            }
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                error!(user_id = %user_id, status = %status, "telegram alert failed");
                (false, Some(format!("HTTP {status}: {body}")))
            }
            Err(err) => {
                error!(user_id = %user_id, error = %err, "telegram request error");
                (false, Some(err.to_string()))
            }
        };

        let _ = sqlx::query(
            r#"
            INSERT INTO alert_logs (user_id, alert_type, message, delivered, error_detail)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(user_id)
        .bind(alert_type)
        .bind(message)
        .bind(delivered)
        .bind(error_detail)
        .execute(pool)
        .await;
    }
}
