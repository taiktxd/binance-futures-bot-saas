mod auth_mw;
mod routes;
mod state;

use crate::state::AppState;
use anyhow::Context;
use axum::{
    extract::State,
    http::{HeaderValue, Method},
    routing::{delete, get, patch, post},
    Json, Router,
};
use binance::{spawn_market_data_stream, BinanceFuturesClient};
use common::{Aes256GcmCipher, AppConfig, MarketTick};
use engine::{spawn_trading_engine, TelegramNotifier};
use sqlx::postgres::PgPoolOptions;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::{info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,api=debug,engine=debug,binance=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Arc::new(AppConfig::from_env().context("failed to load configuration")?);
    let pool = PgPoolOptions::new()
        .max_connections(config.database_max_connections)
        .connect(&config.database_url)
        .await
        .context("failed to connect to Supabase PostgreSQL")?;

    let cipher = Arc::new(Aes256GcmCipher::new(config.encryption_master_key));
    let notifier = Arc::new(TelegramNotifier::new(
        config.telegram_bot_token.clone(),
        config.telegram_admin_chat_id.clone(),
    ));

    let feed_rest = config
        .rest_url_for(config.binance_market_feed_env)
        .to_string();
    let feed_ws = config
        .ws_url_for(config.binance_market_feed_env)
        .to_string();

    let public_client = BinanceFuturesClient::public(feed_rest, config.binance_market_feed_env)
        .context("failed to initialize public Binance client")?;

    let (filters, active_gold_symbol) = match public_client
        .fetch_symbol_filters(
            &config.gold_primary_symbol,
            &config.gold_testnet_fallback_symbol,
        )
        .await
    {
        Ok(res) => res,
        Err(err) => {
            warn!(error = %err, "failed fetching exchangeInfo on startup; using empty filter map");
            (HashMap::new(), config.gold_primary_symbol.clone())
        }
    };

    let (market_tx, _) = broadcast::channel::<MarketTick>(1024);
    let ws_connected = Arc::new(AtomicBool::new(false));

    spawn_market_data_stream(
        feed_ws,
        active_gold_symbol.clone(),
        market_tx.clone(),
        Arc::clone(&ws_connected),
    );

    let filters = Arc::new(filters);

    spawn_trading_engine(
        pool.clone(),
        Arc::clone(&config),
        Arc::clone(&cipher),
        Arc::clone(&notifier),
        Arc::clone(&filters),
        market_tx.subscribe(),
    );

    let state = AppState {
        pool,
        config: Arc::clone(&config),
        cipher,
        filters,
        market_tx,
        ws_connected,
        active_gold_symbol,
    };

    let cors = build_cors(&config.cors_allowed_origins);

    let app = Router::new()
        .route("/health", get(health_check))
        .route("/ws/market", get(routes::ws::market_ws_handler))
        // Auth
        .route("/api/v1/auth/register", post(routes::auth::register))
        .route("/api/v1/auth/login", post(routes::auth::login))
        .route("/api/v1/auth/me", get(routes::auth::me))
        // API Keys (Testnet restricted to Admin)
        .route(
            "/api/v1/api-keys",
            get(routes::api_keys::list_api_keys).post(routes::api_keys::create_api_key),
        )
        .route(
            "/api/v1/api-keys/:id/test",
            post(routes::api_keys::test_api_key),
        )
        .route(
            "/api/v1/api-keys/:id",
            delete(routes::api_keys::delete_api_key),
        )
        // Risk & Bot Execution (Single Adaptive Strategy Core, Uncapped Leverage)
        .route(
            "/api/v1/bots",
            get(routes::bots::list_bots).post(routes::bots::create_bot),
        )
        .route("/api/v1/bots/:id", patch(routes::bots::update_bot))
        .route("/api/v1/bots/:id/start", post(routes::bots::start_bot))
        .route("/api/v1/bots/:id/stop", post(routes::bots::stop_bot))
        .route(
            "/api/v1/dashboard/summary",
            get(routes::bots::dashboard_summary),
        )
        .route("/api/v1/positions", get(routes::bots::list_positions))
        .route("/api/v1/trades", get(routes::bots::list_trades))
        // Wallet, Partner Withdrawals ($5 max, 24h approval) & Notifications
        .route(
            "/api/v1/wallet/transactions",
            get(routes::wallet::list_wallet_transactions),
        )
        .route(
            "/api/v1/wallet/deposits/vietqr",
            post(routes::wallet::create_vietqr_deposit),
        )
        .route(
            "/api/v1/wallet/deposits/crypto",
            post(routes::wallet::create_crypto_deposit),
        )
        .route(
            "/api/v1/wallet/subscribe",
            post(routes::wallet::subscribe_plan),
        )
        .route("/api/v1/earn/summary", get(routes::wallet::earn_summary))
        .route(
            "/api/v1/earn/withdraw",
            get(routes::wallet::list_withdraw_requests)
                .post(routes::wallet::create_withdraw_request),
        )
        .route(
            "/api/v1/notifications",
            get(routes::wallet::list_notifications),
        )
        .route(
            "/api/v1/notifications/read-all",
            post(routes::wallet::mark_notifications_read),
        )
        .route(
            "/api/v1/webhooks/sepay",
            post(routes::wallet::sepay_webhook),
        )
        .route(
            "/api/v1/webhooks/nowpayments",
            post(routes::wallet::nowpayments_webhook),
        )
        // Admin
        .route("/api/v1/admin/users", get(routes::admin::list_users))
        .route(
            "/api/v1/admin/users/:id/credit-adjust",
            post(routes::admin::adjust_user_credit),
        )
        .route(
            "/api/v1/admin/engine-status",
            get(routes::admin::engine_status),
        )
        .route(
            "/api/v1/admin/withdrawals",
            get(routes::admin::list_withdrawals),
        )
        .route(
            "/api/v1/admin/withdrawals/:id/process",
            post(routes::admin::process_withdrawal),
        )
        .route(
            "/api/v1/admin/bots/:id/test-order",
            post(routes::admin::trigger_testnet_order),
        )
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr: SocketAddr = format!("{}:{}", config.server_host, config.server_port)
        .parse()
        .context("invalid SERVER_HOST or SERVER_PORT")?;

    info!(addr = %addr, "starting EXTREME futures core server");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health_check(State(state): State<AppState>) -> Json<serde_json::Value> {
    let db_ok = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool)
        .await
        .is_ok();
    Json(serde_json::json!({
        "status": if db_ok { "ok" } else { "degraded" },
        "database": db_ok,
        "ws_feed_connected": state.ws_connected.load(Ordering::Relaxed),
        "active_gold_symbol": state.active_gold_symbol
    }))
}

fn build_cors(origins: &[String]) -> CorsLayer {
    let parsed: Vec<HeaderValue> = origins
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect();

    let layer = CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(Any);

    if parsed.is_empty() {
        layer.allow_origin(Any)
    } else {
        layer.allow_origin(parsed)
    }
}
