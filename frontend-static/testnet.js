function createApi(base, getToken) {
  const url = new URL(base);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('API phải dùng HTTPS.');
  }
  return async (path, method = 'GET', body) => {
    const headers = {};
    const token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base.replace(/\/$/, '') + '/api/v1' + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000)
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.message || 'API trả về HTTP ' + response.status);
    if (data === null) throw new Error('Phản hồi API không hợp lệ.');
    return data;
  };
}

const $ = id => document.getElementById(id);
const status = $('status');
const controls = $('controls');
const login = $('login');
let token = '';
let api;
let busy = false;

function fmtNum(val, maxDp = 8) {
  const n = Number(val);
  if (!Number.isFinite(n)) return String(val ?? '');
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: maxDp });
}

function fmtSigned(val, maxDp = 4) {
  const n = Number(val);
  if (!Number.isFinite(n)) return String(val ?? '');
  const prefix = n > 0 ? '+' : '';
  return prefix + fmtNum(n, maxDp);
}

function renderList(id, rows, describe, actions = {}) {
  const list = $(id);
  list.replaceChildren();
  if (!rows.length) list.textContent = 'Chưa có dữ liệu.';
  for (const row of rows) {
    const item = document.createElement('li');
    item.textContent = describe(row);
    for (const [label, action] of Object.entries(actions)) {
      const button = document.createElement('button');
      button.textContent = label;
      button.addEventListener('click', () => run(() => action(row)));
      item.append(' ', button);
    }
    list.append(item);
  }
}

async function refresh() {
  const [keys, bots, positions, trades] = await Promise.all([
    api('/api-keys'), api('/bots'), api('/positions'), api('/trades?limit=100')
  ]);
  const testKeys = keys.items.filter(key => key.environment === 'TESTNET');
  const testBots = bots.filter(bot => testKeys.some(key => key.id === bot.api_key_id));
  const botIds = new Set(testBots.map(bot => bot.id));
  const select = $('api-key-id');
  const selected = select.value;
  select.replaceChildren(...testKeys.filter(key => key.is_active && key.can_trade_futures)
    .map(key => new Option(key.label + ' ' + key.api_key_masked, key.id)));
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
  renderList('keys', testKeys, key => key.label + ' · ' + key.api_key_masked, {
    'Kiểm tra': async key => {
      const result = await api('/api-keys/' + key.id + '/test', 'POST');
      return 'Kết nối Testnet thành công. Số dư khả dụng ' + fmtNum(result.available_usdt_balance, 4) + ' USDT.';
    }
  });
  renderList('bots', testBots, bot => [bot.symbol, bot.risk_profile, bot.status, bot.last_error].filter(Boolean).join(' · '), {
    'Bật': async bot => { await api('/bots/' + bot.id + '/start', 'POST'); await refresh(); },
    'Dừng mở lệnh': async bot => { await api('/bots/' + bot.id + '/stop', 'POST'); await refresh(); },
    'Vào LONG ngay (Test)': async bot => {
      const pos = await api('/admin/bots/' + bot.id + '/test-order', 'POST', { side: 'LONG' });
      await refresh();
      return `Đã vào lệnh LONG ${pos.symbol}: KL ${fmtNum(pos.quantity)} @ ${fmtNum(pos.entry_price)} · SL ${fmtNum(pos.stop_loss_price)} · TP ${fmtNum(pos.take_profit_price)}`;
    },
    'Vào SHORT ngay (Test)': async bot => {
      const pos = await api('/admin/bots/' + bot.id + '/test-order', 'POST', { side: 'SHORT' });
      await refresh();
      return `Đã vào lệnh SHORT ${pos.symbol}: KL ${fmtNum(pos.quantity)} @ ${fmtNum(pos.entry_price)} · SL ${fmtNum(pos.stop_loss_price)} · TP ${fmtNum(pos.take_profit_price)}`;
    }
  });
  renderList('positions', positions.filter(row => botIds.has(row.bot_config_id)),
    row => [row.symbol, row.side, fmtNum(row.quantity), 'Giá vào ' + fmtNum(row.entry_price), 'SL ' + fmtNum(row.stop_loss_price), 'TP ' + fmtNum(row.take_profit_price), 'PnL ' + fmtSigned(row.unrealized_pnl, 4) + ' USDT'].join(' · '));
  renderList('trades', trades.filter(row => botIds.has(row.bot_config_id)),
    row => [row.symbol, row.side, 'Giá thoát ' + fmtNum(row.exit_price), 'PnL ' + fmtSigned(row.realized_pnl, 4) + ' USDT'].join(' · '));
}

async function run(action) {
  if (busy) return;
  busy = true;
  status.textContent = 'Đang xử lý…';
  try {
    status.textContent = (await action()) || 'Đã cập nhật từ máy chủ.';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    busy = false;
  }
}

function onSubmit(form, action) {
  form.addEventListener('submit', event => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(form));
    for (const input of form.querySelectorAll('input[type=password]')) input.value = '';
    run(() => action(fields));
  });
}

try {
  if (!window.EXTREME_CONFIG?.API_URL) throw new Error('Chưa cấu hình API_URL (link HTTPS của máy chủ bot VPS) trong config.js. Nếu đang test trên máy cá nhân, hãy mở http://localhost:5173/testnet.html.');
  api = createApi(window.EXTREME_CONFIG.API_URL, () => token);
  login.hidden = false;
  onSubmit(login, async fields => {
    const result = await api('/auth/login', 'POST', fields);
    if (result.user.role !== 'ADMIN') throw new Error('Testnet chỉ dành cho quản trị viên.');
    token = result.token;
    try {
      await refresh();
    } catch (error) {
      token = '';
      throw error;
    }
    login.hidden = true;
    controls.hidden = false;
  });
  onSubmit($('add-key'), async fields => {
    await api('/api-keys', 'POST', { ...fields, environment: 'TESTNET' });
    await refresh();
  });
  onSubmit($('create-bot'), async fields => {
    if (!fields.api_key_id) throw new Error('Hãy thêm khóa Testnet trước.');
    await api('/bots', 'POST', {
      ...fields, leverage: Number(fields.leverage), margin_type: 'ISOLATED',
      leverage_mode: 'CUSTOM', max_open_positions: 1
    });
    await refresh();
  });
  $('refresh').addEventListener('click', () => run(refresh));
  $('logout').addEventListener('click', () => location.reload());
} catch (error) {
  status.textContent = error.message;
}
