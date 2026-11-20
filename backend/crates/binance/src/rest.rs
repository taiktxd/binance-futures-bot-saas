use crate::filters::{round_to_step, SymbolFilter};
use common::{AppError, AppResult, BinanceEnv, MarginMode, PositionSide};
use hmac::{Hmac, Mac};
use reqwest::{Client, Method, StatusCode};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use serde::Deserialize;
use sha2::Sha256;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::sleep;
use tracing::{info, warn};

type HmacSha256 = Hmac<Sha256>;

const DEFAULT_RECV_WINDOW_MS: u64 = 5000;
const MAX_RATE_LIMIT_RETRIES: u8 = 3;

#[derive(Debug, Clone)]
pub struct ApiKeyVerification {
    pub can_trade_futures: bool,
    pub can_withdraw: bool,
    pub ip_restricted: bool,
    pub available_usdt_balance: Decimal,
}

#[derive(Debug, Clone)]
pub struct OrderExecutionResult {
    pub entry_order_id: String,
    pub sl_order_id: Option<String>,
    pub tp_order_id: Option<String>,
    pub protection_error: Option<String>,
    pub executed_price: Decimal,
    pub executed_qty: Decimal,
    pub stop_loss_price: Decimal,
    pub take_profit_price: Decimal,
}

#[derive(Debug, Clone)]
pub struct RealizedTradeFill {
    pub trade_id: String,
    pub exit_price: Decimal,
    pub realized_pnl: Decimal,
    pub commission: Decimal,
}

#[derive(Debug, Clone)]
pub struct BinanceFuturesClient {
    http: Client,
    base_url: String,
    env: BinanceEnv,
    api_key: Option<String>,
    api_secret: Option<String>,
    time_offset_ms: Arc<AtomicI64>,
}

impl BinanceFuturesClient {
    pub fn public(base_url: impl Into<String>, env: BinanceEnv) -> AppResult<Self> {
        let http = Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| AppError::Internal(format!("failed to build HTTP client: {e}")))?;

        Ok(Self {
            http,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            env,
            api_key: None,
            api_secret: None,
            time_offset_ms: Arc::new(AtomicI64::new(0)),
        })
    }

    pub fn authenticated(
        base_url: impl Into<String>,
        env: BinanceEnv,
        api_key: String,
        api_secret: String,
    ) -> AppResult<Self> {
        let mut client = Self::public(base_url, env)?;
        client.api_key = Some(api_key);
        client.api_secret = Some(api_secret);
        Ok(client)
    }

    pub async fn sync_server_time(&self) -> AppResult<i64> {
        #[derive(Deserialize)]
        struct ServerTimeResp {
            #[serde(rename = "serverTime")]
            server_time: i64,
        }

        let url = format!("{}/fapi/v1/time", self.base_url);
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| AppError::Exchange(format!("server time request failed: {e}")))?;

        let body: ServerTimeResp = resp
            .json()
            .await
            .map_err(|e| AppError::Exchange(format!("invalid server time response: {e}")))?;

        let local_ms = current_unix_ms()?;
        let offset = body.server_time - local_ms;
        self.time_offset_ms.store(offset, Ordering::Relaxed);
        Ok(offset)
    }

    pub async fn fetch_mark_price(&self, symbol: &str) -> AppResult<Decimal> {
        #[derive(Deserialize)]
        struct PremiumIndexResp {
            #[serde(rename = "markPrice")]
            mark_price: String,
        }

        let url = format!("{}/fapi/v1/premiumIndex?symbol={}", self.base_url, symbol);
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| AppError::Exchange(format!("premiumIndex request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::Exchange(format!(
                "premiumIndex failed ({status}): {text}"
            )));
        }

        let body: PremiumIndexResp = resp
            .json()
            .await
            .map_err(|e| AppError::Exchange(format!("invalid premiumIndex response: {e}")))?;

        let price = Decimal::from_str(&body.mark_price)
            .map_err(|e| AppError::Exchange(format!("invalid markPrice decimal: {e}")))?;
        if price <= dec!(0) {
            return Err(AppError::Exchange(
                "exchange returned non-positive mark price".to_string(),
            ));
        }
        Ok(price)
    }

    pub async fn fetch_symbol_filters(
        &self,
        gold_primary: &str,
        gold_fallback: &str,
    ) -> AppResult<(HashMap<String, SymbolFilter>, String)> {
        #[derive(Deserialize)]
        struct ExchangeInfoResp {
            symbols: Vec<ExchangeSymbol>,
        }
        #[derive(Deserialize)]
        struct ExchangeSymbol {
            symbol: String,
            status: String,
            filters: Vec<serde_json::Value>,
        }

        let url = format!("{}/fapi/v1/exchangeInfo", self.base_url);
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| AppError::Exchange(format!("exchangeInfo request failed: {e}")))?;

        if !resp.status().is_success() {
            return Err(AppError::Exchange(format!(
                "exchangeInfo returned status {}",
                resp.status()
            )));
        }

        let info: ExchangeInfoResp = resp
            .json()
            .await
            .map_err(|e| AppError::Exchange(format!("invalid exchangeInfo payload: {e}")))?;

        let mut filters_map = HashMap::new();
        for item in info.symbols {
            if item.status != "TRADING" {
                continue;
            }
            if !matches!(
                item.symbol.as_str(),
                "BTCUSDT" | "ETHUSDT" | "XAUUSDT" | "PAXGUSDT"
            ) {
                continue;
            }

            let mut tick_size = dec!(0.01);
            let mut step_size = dec!(0.001);
            let mut min_qty = dec!(0.001);

            for f in &item.filters {
                let ftype = f.get("filterType").and_then(|v| v.as_str()).unwrap_or("");
                if ftype == "PRICE_FILTER" {
                    if let Some(s) = f.get("tickSize").and_then(|v| v.as_str()) {
                        if let Ok(d) = Decimal::from_str(s) {
                            tick_size = d;
                        }
                    }
                } else if ftype == "LOT_SIZE" {
                    if let Some(s) = f.get("stepSize").and_then(|v| v.as_str()) {
                        if let Ok(d) = Decimal::from_str(s) {
                            step_size = d;
                        }
                    }
                    if let Some(s) = f.get("minQty").and_then(|v| v.as_str()) {
                        if let Ok(d) = Decimal::from_str(s) {
                            min_qty = d;
                        }
                    }
                }
            }

            filters_map.insert(
                item.symbol.clone(),
                SymbolFilter {
                    symbol: item.symbol,
                    tick_size,
                    step_size,
                    min_qty,
                },
            );
        }

        let active_gold = if filters_map.contains_key(gold_primary) {
            gold_primary.to_string()
        } else if filters_map.contains_key(gold_fallback) {
            warn!(
                primary = gold_primary,
                fallback = gold_fallback,
                env = ?self.env,
                "primary gold symbol unavailable on exchange; activating fallback"
            );
            gold_fallback.to_string()
        } else {
            gold_primary.to_string()
        };

        Ok((filters_map, active_gold))
    }

    pub async fn verify_api_key(&self) -> AppResult<ApiKeyVerification> {
        let _ = self.sync_server_time().await;

        let mut can_withdraw = false;
        let mut ip_restricted = false;

        if self.env == BinanceEnv::Live {
            if let Ok(restrictions) = self.fetch_live_api_restrictions().await {
                can_withdraw = restrictions.enable_withdrawals;
                ip_restricted = restrictions.ip_restrict;
                if can_withdraw {
                    return Err(AppError::Forbidden(
                        "API key rejected: Enable Withdrawals permission must be disabled"
                            .to_string(),
                    ));
                }
                if !restrictions.enable_futures {
                    return Err(AppError::Forbidden(
                        "API key rejected: Enable Futures permission is required".to_string(),
                    ));
                }
            }
        }

        let balance = self.fetch_usdt_balance().await?;
        Ok(ApiKeyVerification {
            can_trade_futures: true,
            can_withdraw,
            ip_restricted,
            available_usdt_balance: balance,
        })
    }

    async fn fetch_live_api_restrictions(&self) -> AppResult<ApiRestrictionsResp> {
        let query = self.signed_query(&[])?;
        let url = format!("https://api.binance.com/sapi/v1/account/apiRestrictions?{query}");
        let key = self
            .api_key
            .as_deref()
            .ok_or_else(|| AppError::Unauthorized("missing Binance API key".to_string()))?;

        let resp = self
            .http
            .get(&url)
            .header("X-MBX-APIKEY", key)
            .send()
            .await
            .map_err(|e| AppError::Exchange(format!("apiRestrictions check failed: {e}")))?;

        if !resp.status().is_success() {
            return Err(AppError::Exchange(format!(
                "apiRestrictions returned status {}",
                resp.status()
            )));
        }

        resp.json::<ApiRestrictionsResp>()
            .await
            .map_err(|e| AppError::Exchange(format!("invalid apiRestrictions response: {e}")))
    }

    pub async fn fetch_usdt_balance(&self) -> AppResult<Decimal> {
        #[derive(Deserialize)]
        struct BalanceItem {
            asset: String,
            #[serde(rename = "availableBalance")]
            available_balance: String,
        }

        let payload: Vec<BalanceItem> = self
            .signed_request(Method::GET, "/fapi/v2/balance", &[])
            .await?;

        for item in payload {
            if item.asset == "USDT" {
                return Decimal::from_str(&item.available_balance)
                    .map_err(|e| AppError::Exchange(format!("invalid USDT balance decimal: {e}")));
            }
        }
        Ok(dec!(0))
    }

    /// Queries Binance's exact maximum allowed leverage for the symbol and user account
    /// so `EXCHANGE_MAX` mode automatically uses whatever maximum leverage the exchange grants.
    pub async fn fetch_exchange_max_leverage(&self, symbol: &str) -> AppResult<i16> {
        #[derive(Deserialize)]
        struct BracketWrapper {
            brackets: Vec<BracketItem>,
        }
        #[derive(Deserialize)]
        struct BracketItem {
            #[serde(rename = "initialLeverage")]
            initial_leverage: i16,
        }

        let params = [("symbol", symbol)];
        let list: Vec<BracketWrapper> = self
            .signed_request(Method::GET, "/fapi/v1/leverageBracket", &params)
            .await?;

        let max_lev = list
            .into_iter()
            .flat_map(|w| w.brackets.into_iter())
            .map(|b| b.initial_leverage)
            .max()
            .unwrap_or(20);

        Ok(max_lev.max(1))
    }

    pub async fn set_margin_type(&self, symbol: &str, mode: MarginMode) -> AppResult<()> {
        let margin_str = match mode {
            MarginMode::Isolated => "ISOLATED",
            MarginMode::Crossed => "CROSSED",
        };
        let params = [("symbol", symbol), ("marginType", margin_str)];
        let res: Result<serde_json::Value, AppError> = self
            .signed_request(Method::POST, "/fapi/v1/marginType", &params)
            .await;

        match res {
            Ok(_) => Ok(()),
            Err(AppError::Exchange(msg)) if msg.contains("-4046") => Ok(()),
            Err(err) => Err(err),
        }
    }

    /// Applies any exchange-permitted leverage >= 1 with no artificial platform ceiling.
    pub async fn set_leverage(&self, symbol: &str, leverage: i16) -> AppResult<()> {
        if leverage < 1 {
            return Err(AppError::Validation(
                "leverage must be at least 1x".to_string(),
            ));
        }
        let lev_str = leverage.to_string();
        let params = [("symbol", symbol), ("leverage", lev_str.as_str())];
        let _: serde_json::Value = self
            .signed_request(Method::POST, "/fapi/v1/leverage", &params)
            .await?;
        Ok(())
    }

    pub async fn place_bracket_order(
        &self,
        symbol: &str,
        side: PositionSide,
        raw_qty: Decimal,
        raw_sl: Decimal,
        raw_tp: Decimal,
        filter: &SymbolFilter,
    ) -> AppResult<OrderExecutionResult> {
        let qty = round_to_step(raw_qty, filter.step_size);
        if qty < filter.min_qty {
            return Err(AppError::Validation(format!(
                "computed quantity {qty} is below exchange min_qty {} for {symbol}",
                filter.min_qty
            )));
        }

        let sl_price = round_to_step(raw_sl, filter.tick_size);
        let tp_price = round_to_step(raw_tp, filter.tick_size);

        let (entry_side, close_side) = match side {
            PositionSide::Long => ("BUY", "SELL"),
            PositionSide::Short => ("SELL", "BUY"),
        };

        let qty_str = qty.to_string();
        let client_order_id = format!("ext-{}", uuid::Uuid::new_v4().simple());
        let entry_params = [
            ("symbol", symbol),
            ("side", entry_side),
            ("type", "MARKET"),
            ("quantity", qty_str.as_str()),
            ("newOrderRespType", "RESULT"),
            ("newClientOrderId", client_order_id.as_str()),
        ];

        #[derive(Deserialize)]
        struct OrderResp {
            #[serde(rename = "orderId")]
            order_id: i64,
            #[serde(rename = "avgPrice", default)]
            avg_price: String,
            #[serde(rename = "executedQty")]
            executed_qty: Decimal,
        }

        let entry_resp: OrderResp = match self
            .signed_request(Method::POST, "/fapi/v1/order", &entry_params)
            .await
        {
            Ok(response) => response,
            Err(error) => self
                .signed_request(
                    Method::GET,
                    "/fapi/v1/order",
                    &[
                        ("symbol", symbol),
                        ("origClientOrderId", client_order_id.as_str()),
                    ],
                )
                .await
                .map_err(|_| {
                    AppError::Exchange(format!(
                        "{error}; verify entry {client_order_id} on Binance before restarting"
                    ))
                })?,
        };
        if entry_resp.executed_qty <= Decimal::ZERO {
            return Err(AppError::Exchange(format!(
                "entry {client_order_id} has no confirmed fill; check Binance before restarting"
            )));
        }
        let filled_qty = entry_resp.executed_qty.to_string();

        let (sl_order_id, tp_order_id, protection_error) = match self
            .place_close_trigger(symbol, close_side, "STOP_MARKET", sl_price)
            .await
        {
            Ok(sl_id) => match self
                .place_close_trigger(symbol, close_side, "TAKE_PROFIT_MARKET", tp_price)
                .await
            {
                Ok(tp_id) => (Some(sl_id), Some(tp_id), None),
                Err(error) => (
                    Some(sl_id),
                    None,
                    Some(format!("take profit failed: {error}")),
                ),
            },
            Err(error) => {
                let params = [
                    ("symbol", symbol),
                    ("side", close_side),
                    ("type", "MARKET"),
                    ("quantity", filled_qty.as_str()),
                    ("reduceOnly", "true"),
                ];
                let flatten: AppResult<serde_json::Value> = self
                    .signed_request(Method::POST, "/fapi/v1/order", &params)
                    .await;
                let message = match flatten {
                    Ok(_) => format!("stop loss failed: {error}; reduce-only exit requested"),
                    Err(close_error) => format!(
                        "stop loss failed: {error}; check position immediately: {close_error}"
                    ),
                };
                (None, None, Some(message))
            }
        };

        let executed_price = Decimal::from_str(&entry_resp.avg_price).unwrap_or(dec!(0));
        info!(
            symbol = symbol,
            side = ?side,
            qty = %qty,
            sl = %sl_price,
            tp = %tp_price,
            entry_order_id = entry_resp.order_id,
            "placed futures bracket order"
        );

        Ok(OrderExecutionResult {
            entry_order_id: entry_resp.order_id.to_string(),
            sl_order_id,
            tp_order_id,
            protection_error,
            executed_price,
            executed_qty: entry_resp.executed_qty,
            stop_loss_price: sl_price,
            take_profit_price: tp_price,
        })
    }

    /// Replaces the existing Stop Loss order with a breakeven Stop Loss once a position
    /// moves strongly into profit.
    pub async fn move_stop_loss(
        &self,
        symbol: &str,
        side: PositionSide,
        old_sl_order_id: Option<&str>,
        new_sl_raw: Decimal,
        filter: &SymbolFilter,
    ) -> AppResult<String> {
        let close_side = match side {
            PositionSide::Long => "SELL",
            PositionSide::Short => "BUY",
        };
        let sl_price = round_to_step(new_sl_raw, filter.tick_size);
        let new_id = self
            .place_close_trigger(symbol, close_side, "STOP_MARKET", sl_price)
            .await?;
        if let Some(old_id) = old_sl_order_id {
            if let Err(err) = self.cancel_close_trigger(symbol, old_id).await {
                warn!(symbol, old_id, error = %err, "could not cancel the previous stop");
            }
        }
        Ok(new_id)
    }

    async fn place_close_trigger(
        &self,
        symbol: &str,
        close_side: &str,
        order_type: &str,
        price: Decimal,
    ) -> AppResult<String> {
        #[derive(Deserialize)]
        struct AlgoResponse {
            #[serde(rename = "algoId")]
            algo_id: i64,
        }
        let trigger = price.to_string();
        let params = [
            ("algoType", "CONDITIONAL"),
            ("symbol", symbol),
            ("side", close_side),
            ("type", order_type),
            ("triggerPrice", trigger.as_str()),
            ("closePosition", "true"),
            ("workingType", "MARK_PRICE"),
        ];
        let response: AlgoResponse = self
            .signed_request(Method::POST, "/fapi/v1/algoOrder", &params)
            .await?;
        Ok(format!("algo:{}", response.algo_id))
    }

    pub async fn cancel_close_trigger(&self, symbol: &str, id: &str) -> AppResult<()> {
        let result: AppResult<serde_json::Value> = if let Some(algo_id) = id.strip_prefix("algo:") {
            self.signed_request(Method::DELETE, "/fapi/v1/algoOrder", &[("algoId", algo_id)])
                .await
        } else {
            self.signed_request(
                Method::DELETE,
                "/fapi/v1/order",
                &[("symbol", symbol), ("orderId", id)],
            )
            .await
        };
        match result {
            Ok(_) => Ok(()),
            Err(AppError::Exchange(message))
                if message.contains("-2011") || message.contains("-2013") =>
            {
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    pub async fn fetch_position_amt(&self, symbol: &str) -> AppResult<Decimal> {
        #[derive(Deserialize)]
        struct PosRisk {
            symbol: String,
            #[serde(rename = "positionAmt")]
            position_amt: String,
            #[serde(rename = "positionSide")]
            position_side: String,
        }
        let params = [("symbol", symbol)];
        let list: Vec<PosRisk> = self
            .signed_request(Method::GET, "/fapi/v2/positionRisk", &params)
            .await?;

        for item in list {
            if item.symbol == symbol {
                if item.position_side != "BOTH" {
                    return Err(AppError::Validation(
                        "EXTREME requires Binance One-way Mode".to_string(),
                    ));
                }
                return Decimal::from_str(&item.position_amt)
                    .map_err(|e| AppError::Exchange(format!("invalid positionAmt: {e}")));
            }
        }
        Ok(dec!(0))
    }

    /// Fetches exact realized PnL and commission from Binance `/fapi/v1/userTrades`
    /// starting at `start_time_ms` for penny-accurate 20% HWM billing.
    pub async fn fetch_realized_fills(
        &self,
        symbol: &str,
        start_time_ms: i64,
        entry_order_id: &str,
        side: PositionSide,
    ) -> AppResult<Option<RealizedTradeFill>> {
        #[derive(Deserialize)]
        struct UserTradeItem {
            id: i64,
            #[serde(rename = "orderId")]
            order_id: i64,
            side: String,
            qty: Decimal,
            price: Decimal,
            #[serde(rename = "realizedPnl")]
            realized_pnl: Decimal,
            commission: Decimal,
        }

        let start_str = start_time_ms.to_string();
        let params = [
            ("symbol", symbol),
            ("startTime", start_str.as_str()),
            ("limit", "1000"),
        ];
        let trades: Vec<UserTradeItem> = self
            .signed_request(Method::GET, "/fapi/v1/userTrades", &params)
            .await?;

        let mut total_pnl = dec!(0);
        let mut total_comm = dec!(0);
        let mut exit_value = dec!(0);
        let mut exit_qty = dec!(0);
        let entry_id: i64 = entry_order_id
            .parse()
            .map_err(|_| AppError::Validation("invalid entry order ID".to_string()))?;
        let close_side = if side == PositionSide::Long {
            "SELL"
        } else {
            "BUY"
        };
        let mut last_id: Option<String> = None;

        for t in trades {
            if t.order_id == entry_id {
                total_comm += t.commission;
            } else if t.side == close_side {
                total_pnl += t.realized_pnl;
                total_comm += t.commission;
                exit_value += t.qty * t.price;
                exit_qty += t.qty;
                last_id = Some(t.id.to_string());
            }
        }

        if exit_qty <= Decimal::ZERO {
            return Ok(None);
        }
        Ok(last_id.map(|trade_id| RealizedTradeFill {
            trade_id,
            exit_price: (exit_value / exit_qty).round_dp(8),
            realized_pnl: total_pnl.round_dp(8),
            commission: total_comm.round_dp(8),
        }))
    }

    async fn signed_request<T: for<'de> Deserialize<'de>>(
        &self,
        method: Method,
        path: &str,
        params: &[(&str, &str)],
    ) -> AppResult<T> {
        let api_key = self
            .api_key
            .as_deref()
            .ok_or_else(|| AppError::Unauthorized("missing Binance API key".to_string()))?;

        let mut attempt: u8 = 0;
        loop {
            let query = self.signed_query(params)?;
            let url = format!("{}{path}?{query}", self.base_url);

            let resp = self
                .http
                .request(method.clone(), &url)
                .header("X-MBX-APIKEY", api_key)
                .send()
                .await
                .map_err(|e| {
                    AppError::Exchange(format!(
                        "HTTP request failed on {path}: {}",
                        e.without_url()
                    ))
                })?;

            let status = resp.status();
            let text = resp.text().await.map_err(|e| {
                AppError::Exchange(format!(
                    "failed reading response body on {path}: {}",
                    e.without_url()
                ))
            })?;

            if (status == StatusCode::TOO_MANY_REQUESTS || status.as_u16() == 418)
                && attempt < MAX_RATE_LIMIT_RETRIES
            {
                attempt += 1;
                let backoff_secs = 2u64.pow(u32::from(attempt));
                warn!(
                    status = status.as_u16(),
                    attempt = attempt,
                    backoff_secs = backoff_secs,
                    path = path,
                    "binance rate limit hit; backing off"
                );
                sleep(Duration::from_secs(backoff_secs)).await;
                continue;
            }

            if !status.is_success() {
                if text.contains("-1021") && attempt == 0 {
                    attempt += 1;
                    let _ = self.sync_server_time().await;
                    continue;
                }
                return Err(AppError::Exchange(format!(
                    "binance error {status} on {path}: {text}"
                )));
            }

            return serde_json::from_str::<T>(&text)
                .map_err(|e| AppError::Exchange(format!("JSON decode error on {path}: {e}")));
        }
    }

    fn signed_query(&self, params: &[(&str, &str)]) -> AppResult<String> {
        let secret = self
            .api_secret
            .as_deref()
            .ok_or_else(|| AppError::Unauthorized("missing Binance API secret".to_string()))?;

        let now_ms = current_unix_ms()? + self.time_offset_ms.load(Ordering::Relaxed);
        let mut pairs: Vec<String> = params.iter().map(|(k, v)| format!("{k}={v}")).collect();
        pairs.push(format!("recvWindow={DEFAULT_RECV_WINDOW_MS}"));
        pairs.push(format!("timestamp={now_ms}"));
        let query = pairs.join("&");

        let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
            .map_err(|e| AppError::Crypto(format!("HMAC init failed: {e}")))?;
        mac.update(query.as_bytes());
        let signature = hex::encode(mac.finalize().into_bytes());

        Ok(format!("{query}&signature={signature}"))
    }
}

#[derive(Deserialize)]
struct ApiRestrictionsResp {
    #[serde(rename = "enableWithdrawals", default)]
    enable_withdrawals: bool,
    #[serde(rename = "enableFutures", default)]
    enable_futures: bool,
    #[serde(rename = "ipRestrict", default)]
    ip_restrict: bool,
}

fn current_unix_ms() -> AppResult<i64> {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| AppError::Internal(format!("system clock before UNIX_EPOCH: {e}")))?;
    i64::try_from(dur.as_millis())
        .map_err(|e| AppError::Internal(format!("timestamp overflow: {e}")))
}
