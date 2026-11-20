use crate::state::AppState;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Response,
};

pub async fn market_ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    let mut rx = state.market_tx.subscribe();
    while let Ok(tick) = rx.recv().await {
        if let Ok(json_text) = serde_json::to_string(&tick) {
            if socket.send(Message::Text(json_text)).await.is_err() {
                break;
            }
        }
    }
}
