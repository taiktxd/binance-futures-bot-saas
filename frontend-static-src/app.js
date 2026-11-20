import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.min.js';

    const CFG = window.EXTREME_CONFIG || { API_URL: '', STATIC_IP: '203.0.113.10' };
    const API_BASE = (CFG.API_URL || '').trim().replace(/\/$/, '');
    const HAS_API = API_BASE.length > 0;

    const loadJson = (k, fallback) => {
      try {
        const raw = localStorage.getItem(k);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    };

    function escapeHtml(val) {
      return String(val ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function normalizeUser(raw) {
      if (!raw) return null;
      return {
        ...raw,
        credit_balance: Number(raw.credit_balance ?? 0),
        commission_balance: Number(raw.commission_balance ?? 0),
        cumulative_net_pnl: Number(raw.cumulative_net_pnl ?? 0),
        high_water_mark: Number(raw.high_water_mark ?? raw.hwm ?? 0),
        bonus_claimed: Boolean(raw.bonus_credit_granted ?? raw.bonus_claimed ?? false),
        ref_code: raw.referral_code || raw.ref_code || '',
        has_referrer: Boolean(raw.referred_by_user_id || raw.has_referrer),
      };
    }

    function planLabel(plan, role) {
      if (role === 'ADMIN') return 'Quản trị';
      const map = {
        PRO: 'Chuyên nghiệp ($79)',
        STANDARD: 'Tiêu chuẩn ($29)',
        TRIAL: 'Dùng thử',
        INACTIVE: 'Chưa kích hoạt',
      };
      return map[plan] || plan || 'Chưa kích hoạt';
    }

    function txTypeLabel(txType) {
      const map = {
        FIRST_DEPOSIT_BONUS: 'Thưởng kích hoạt lần đầu',
        DEPOSIT_VIETQR: 'Nạp Credit qua VietQR',
        DEPOSIT_CRYPTO: 'Nạp Credit qua USDT BEP20',
        HWM_FEE_DEDUCTION: 'Phí 20% HWM',
        SUBSCRIPTION_FEE: 'Phí gói thuê bao tháng',
        COMMISSION_CONVERT: 'Quy đổi hoa hồng',
        ADMIN_ADJUSTMENT: 'Điều chỉnh từ Quản trị',
      };
      return map[txType] || txType;
    }

    function withdrawStatusMeta(status) {
      if (status === 'APPROVED') return { text: 'Đã duyệt', cls: 'bg-[#34B37E]/20 text-[#34B37E]' };
      if (status === 'REJECTED') return { text: 'Từ chối (đã hoàn)', cls: 'bg-[#D64545]/20 text-[#D64545]' };
      if (status === 'PENDING') return { text: 'Chờ duyệt (24h)', cls: 'bg-[#590907] text-[#E8D2B5]' };
      return { text: status || 'Chờ duyệt', cls: 'bg-[#590907] text-[#E8D2B5]' };
    }

    function fmtDateTime(raw) {
      if (!raw) return '';
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? String(raw) : d.toLocaleString('vi-VN');
    }

    // Ghi nhận mã giới thiệu ?ref=... nếu khách truy cập qua link đối tác
    const urlRef = new URLSearchParams(window.location.search).get('ref');
    if (urlRef) localStorage.setItem('ex_referred_by', urlRef.trim().toUpperCase());

    const state = {
      route: 'landing',
      user: normalizeUser(loadJson('ex_user', null)),
      token: localStorage.getItem('ex_token') || '',
      serverStaticIp: CFG.STATIC_IP || '203.0.113.10',
      viewLoading: false,
      viewError: '',
      actionNotice: null,
      dashboardSummary: null,
      trades: [],
      tradeSymbolFilter: '',
      earnSummary: null,
      pendingDeposit: null,
      adminEngineStatus: null,
      adminWithdrawals: [],
      usersDb: loadJson('ex_users_db', [
        { email: 'haug9g9@gmail.com', role: 'ADMIN', plan: 'Quản trị', credit_balance: 500.0, bonus_claimed: true, hwm: 0.0, ref_code: 'EX-ADMIN' },
      ]),
      creditTxs: loadJson('ex_credit_txs', []),
      withdraws: loadJson('ex_withdraws', []),
      withdrawDraft: {
        method: 'BANK',
        amount: 5,
        bscId: '',
        bankName: '',
        bankAccount: '',
        bankHolder: '',
      },
      vndRate: 25500,
      vndRateSource: 'Đang đồng bộ tỷ giá...',
      notifications: loadJson('ex_notifs', [
        { title: 'Chào mừng đến với EXTREME', body: 'Nạp lần đầu tối thiểu $1.00 để kích hoạt khuyến mãi $5.00 Credit.', time: 'Hệ thống', unread: true }
      ]),
      apiKeys: loadJson('ex_api_keys', []),
      configs: loadJson('ex_risk_configs', []),
      ticks: {
        BTCUSDT: { price: 0, pct: 0 },
        ETHUSDT: { price: 0, pct: 0 },
        PAXGUSDT: { price: 0, pct: 0 },
      },
      riskDraft: {
        apiKeyId: '',
        symbol: 'BTCUSDT',
        riskProfile: 'BALANCED',
        marginType: 'ISOLATED',
        leverageMode: 'EXCHANGE_MAX',
        leverage: 20,
        orderMargin: 100,
        maxOpen: 2,
        slPct: 1.5,
        tpPct: 3.5,
        enableBreakeven: true,
      },
      earnCalc: {
        refs: 20,
        avgMonthlyProfit: 600,
        avgSubFee: 29,
      },
      activeCleanup: null,
    };

    async function apiRequest(path, { method = 'GET', body, auth = true } = {}) {
      if (!HAS_API) throw new Error('Chưa cấu hình API_URL trong config.js.');
      const headers = {};
      if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const opts = {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      };
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        opts.signal = AbortSignal.timeout(20000);
      }
      const res = await fetch(`${API_BASE}${path}`, opts);
      const data = await res.json().catch(() => null);
      if (res.status === 401 && auth) {
        state.token = '';
        state.user = null;
        localStorage.removeItem('ex_token');
        localStorage.removeItem('ex_user');
        throw new Error(data?.message || 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.');
      }
      if (!res.ok) {
        throw new Error(data?.message || `Máy chủ trả về lỗi HTTP ${res.status}`);
      }
      return data;
    }

    function setNotice(type, text) {
      state.actionNotice = text ? { type, text } : null;
    }

    function renderNoticeBanner() {
      if (!state.actionNotice?.text) return '';
      const isErr = state.actionNotice.type === 'error';
      const cls = isErr
        ? 'bg-[#D64545]/15 border border-[#D64545]/40 text-[#D64545]'
        : 'bg-[#34B37E]/15 border border-[#34B37E]/40 text-[#34B37E]';
      return `<div class="p-3.5 text-xs rounded-xl ${cls}">${escapeHtml(state.actionNotice.text)}</div>`;
    }

    function renderViewStateBanner() {
      if (state.viewLoading) {
        return `<div class="panel rounded-xl p-4 text-xs text-[#E8D2B5]">Đang đồng bộ dữ liệu trực tiếp từ máy chủ EXTREME...</div>`;
      }
      if (state.viewError) {
        return `
          <div class="p-4 text-xs rounded-xl bg-[#D64545]/15 border border-[#D64545]/40 text-[#D64545] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <span>${escapeHtml(state.viewError)}</span>
            <button type="button" onclick="reloadCurrentRoute()" class="px-3 py-1.5 rounded-lg border border-[#D64545]/50 text-[#E8D2B5] hover:bg-[#D64545]/20 shrink-0">Thử lại</button>
          </div>
        `;
      }
      return '';
    }

    function renderAuthRequiredCard(title, desc) {
      return `
        <div class="max-w-md mx-auto mt-8 panel rounded-xl p-6 text-center space-y-3">
          <div class="text-sm font-bold text-[#E8D2B5]">${escapeHtml(title)}</div>
          <p class="text-xs text-[#A5A79B]">${escapeHtml(desc)}</p>
          <div class="flex justify-center gap-2 pt-1">
            <button type="button" onclick="navigate('login')" class="btn-champagne px-4 py-2 text-xs font-bold rounded-lg">Đăng nhập</button>
            <button type="button" onclick="navigate('register')" class="btn-stone px-4 py-2 text-xs font-semibold rounded-lg">Tạo tài khoản</button>
          </div>
        </div>
      `;
    }

    async function syncNotificationsFromApi() {
      if (!HAS_API || !state.token) return;
      try {
        const list = await apiRequest('/api/v1/notifications');
        if (Array.isArray(list)) {
          state.notifications = list.map((n) => ({
            id: n.id,
            title: n.title,
            body: n.body,
            time: fmtDateTime(n.created_at),
            unread: !n.is_read,
          }));
          renderNotifList();
          renderHeaderAuth();
          if (window.lucide) window.lucide.createIcons();
        }
      } catch {}
    }

    async function loadRouteData(route) {
      if (!HAS_API || !state.token) return;
      const protectedRoutes = ['dashboard', 'api-keys', 'bots', 'trades', 'wallet', 'earn', 'admin'];
      if (!protectedRoutes.includes(route)) return;

      state.viewLoading = true;
      state.viewError = '';
      renderView();

      try {
        if (route === 'dashboard') {
          const [me, summary, bots] = await Promise.all([
            apiRequest('/api/v1/auth/me'),
            apiRequest('/api/v1/dashboard/summary'),
            apiRequest('/api/v1/bots'),
          ]);
          if (state.route !== route) return;
          state.user = normalizeUser(me);
          localStorage.setItem('ex_user', JSON.stringify(state.user));
          state.dashboardSummary = summary;
          state.configs = Array.isArray(bots) ? bots : [];
          syncNotificationsFromApi();
        } else if (route === 'api-keys') {
          const res = await apiRequest('/api/v1/api-keys');
          if (state.route !== route) return;
          if (res?.server_static_ip) state.serverStaticIp = res.server_static_ip;
          state.apiKeys = Array.isArray(res?.items) ? res.items : [];
        } else if (route === 'bots') {
          const [bots, keysRes] = await Promise.all([
            apiRequest('/api/v1/bots'),
            apiRequest('/api/v1/api-keys'),
          ]);
          if (state.route !== route) return;
          state.configs = Array.isArray(bots) ? bots : [];
          state.apiKeys = Array.isArray(keysRes?.items) ? keysRes.items : [];
          const liveKeys = state.apiKeys.filter((k) => k.environment === 'LIVE' && k.is_active);
          if (!state.riskDraft.apiKeyId || !liveKeys.some((k) => k.id === state.riskDraft.apiKeyId)) {
            state.riskDraft.apiKeyId = liveKeys[0]?.id || state.apiKeys[0]?.id || '';
          }
        } else if (route === 'trades') {
          const q = state.tradeSymbolFilter ? `?limit=100&symbol=${encodeURIComponent(state.tradeSymbolFilter)}` : '?limit=100';
          const list = await apiRequest(`/api/v1/trades${q}`);
          if (state.route !== route) return;
          state.trades = Array.isArray(list) ? list : [];
        } else if (route === 'wallet') {
          const [me, txs] = await Promise.all([
            apiRequest('/api/v1/auth/me'),
            apiRequest('/api/v1/wallet/transactions'),
          ]);
          if (state.route !== route) return;
          state.user = normalizeUser(me);
          localStorage.setItem('ex_user', JSON.stringify(state.user));
          state.creditTxs = Array.isArray(txs) ? txs : [];
        } else if (route === 'earn') {
          const [me, summary, wds] = await Promise.all([
            apiRequest('/api/v1/auth/me'),
            apiRequest('/api/v1/earn/summary'),
            apiRequest('/api/v1/earn/withdraw'),
          ]);
          if (state.route !== route) return;
          state.user = normalizeUser(me);
          localStorage.setItem('ex_user', JSON.stringify(state.user));
          state.earnSummary = summary;
          state.withdraws = Array.isArray(wds) ? wds : [];
        } else if (route === 'admin') {
          if (state.user?.role !== 'ADMIN') return;
          const [engineStatus, users, withdrawals] = await Promise.all([
            apiRequest('/api/v1/admin/engine-status'),
            apiRequest('/api/v1/admin/users'),
            apiRequest('/api/v1/admin/withdrawals'),
          ]);
          if (state.route !== route) return;
          state.adminEngineStatus = engineStatus;
          state.usersDb = Array.isArray(users) ? users.map(normalizeUser) : [];
          state.adminWithdrawals = Array.isArray(withdrawals) ? withdrawals : [];
        }
      } catch (err) {
        if (state.route !== route) return;
        state.viewError = err.message || 'Không thể tải dữ liệu từ máy chủ.';
      } finally {
        if (state.route === route) {
          state.viewLoading = false;
          renderView();
        }
      }
    }

    const POINTER = { x: 0, y: 0 };
    window.addEventListener('pointermove', (e) => {
      POINTER.x = (e.clientX / window.innerWidth) * 2 - 1;
      POINTER.y = -(e.clientY / window.innerHeight) * 2 + 1;
    });
    window.addEventListener('touchmove', (e) => {
      if (e.touches && e.touches[0]) {
        POINTER.x = (e.touches[0].clientX / window.innerWidth) * 2 - 1;
        POINTER.y = -(e.touches[0].clientY / window.innerHeight) * 2 + 1;
      }
    }, { passive: true });

    async function fetchLiveUsdVndRate() {
      const sources = [
        {
          url: 'https://open.er-api.com/v6/latest/USD',
          parse: (d) => d?.rates?.VND,
          label: 'Tỷ giá thị trường trực tiếp',
        },
        {
          url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
          parse: (d) => d?.usd?.vnd,
          label: 'Tỷ giá thị trường trực tiếp',
        },
      ];
      for (const s of sources) {
        try {
          const res = await fetch(s.url);
          if (!res.ok) continue;
          const data = await res.json();
          const rate = parseFloat(s.parse(data));
          if (rate && rate > 20000 && rate < 35000) {
            state.vndRate = Math.round(rate);
            state.vndRateSource = `${s.label} (${state.vndRate.toLocaleString('vi-VN')} đ/USD)`;
            const el = document.getElementById('wd-vnd-preview');
            if (el) el.textContent = Math.round(state.withdrawDraft.amount * state.vndRate).toLocaleString('vi-VN') + ' VNĐ';
            const srcEl = document.getElementById('wd-rate-note');
            if (srcEl) srcEl.textContent = state.vndRateSource;
            return;
          }
        } catch {}
      }
      state.vndRateSource = `Tỷ giá tham chiếu (${state.vndRate.toLocaleString('vi-VN')} đ/USD)`;
    }

    async function fetchInitialPrices() {
      const endpoints = [
        'https://fapi.binance.com/fapi/v1/ticker/24hr?symbols=["BTCUSDT","ETHUSDT","PAXGUSDT"]',
        'https://api.binance.com/api/v3/ticker/24hr?symbols=["BTCUSDT","ETHUSDT","PAXGUSDT"]',
      ];
      for (const ep of endpoints) {
        try {
          const res = await fetch(ep);
          if (!res.ok) continue;
          const list = await res.json();
          if (Array.isArray(list)) {
            list.forEach((item) => {
              const sym = (item.symbol || '').toUpperCase();
              if (state.ticks[sym]) {
                state.ticks[sym].price = parseFloat(item.lastPrice) || 0;
                state.ticks[sym].pct = parseFloat(item.priceChangePercent) || 0;
              }
            });
            updatePriceDom();
            return;
          }
        } catch {}
      }
    }

    function startMarketStream() {
      fetchInitialPrices();
      const wsUrl = 'wss://fstream.binance.com/stream?streams=btcusdt@ticker/ethusdt@ticker/paxgusdt@ticker';
      let backoff = 2000;
      function connect() {
        const ws = new WebSocket(wsUrl);
        ws.onopen = () => { backoff = 2000; };
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            const d = msg.data;
            if (!d || !d.s) return;
            const sym = d.s.toUpperCase();
            if (!state.ticks[sym]) return;
            state.ticks[sym].price = parseFloat(d.c) || state.ticks[sym].price;
            state.ticks[sym].pct = parseFloat(d.P) || state.ticks[sym].pct;
            updatePriceDom();
          } catch {}
        };
        ws.onclose = () => {
          setTimeout(() => {
            backoff = Math.min(backoff * 2, 30000);
            connect();
          }, backoff);
        };
        ws.onerror = () => ws.close();
      }
      connect();
    }

    function fmtNum(v, maxDp = 8) {
      const n = Number(v);
      if (!Number.isFinite(n)) return String(v ?? '');
      return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: maxDp });
    }

    function fmtUsd(v, maxDp = 2) {
      const n = Number(v);
      if (!Number.isFinite(n)) return '$0';
      const sign = n < 0 ? '-' : '';
      return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: maxDp });
    }

    function updatePriceDom() {
      ['BTCUSDT', 'ETHUSDT', 'PAXGUSDT'].forEach((sym) => {
        const t = state.ticks[sym];
        if (!t || t.price <= 0) return;
        const pStr = fmtUsd(t.price, 2);
        const sign = t.pct > 0 ? '+' : '';
        const pctStr = `${sign}${fmtNum(t.pct, 2)}%`;
        const cls = t.pct > 0 ? 'text-[#34B37E]' : t.pct < 0 ? 'text-[#D64545]' : 'text-[#A5A79B]';

        ['top-price-', 'price-'].forEach((pre) => {
          const el = document.getElementById(pre + sym);
          if (el) el.textContent = pStr;
        });
        ['top-pct-', 'pct-'].forEach((pre) => {
          const el = document.getElementById(pre + sym);
          if (el) {
            el.textContent = pctStr;
            el.className = `num ${pre === 'top-pct-' ? 'text-[10px]' : 'text-xs'} font-semibold ${cls}`;
          }
        });
      });
    }

    function mountExtremeShader3D(containerId, compact) {
      const container = document.getElementById(containerId);
      if (!container) return () => {};

      try {
        const lowPower = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const width = container.clientWidth || 600;
        const height = container.clientHeight || (compact ? 210 : 350);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#130A0A');

        const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
        camera.position.set(0, compact ? 2.1 : 2.35, compact ? 4.4 : 4.8);
        camera.lookAt(0, -0.2, 0);

        const renderer = new THREE.WebGLRenderer({ antialias: !lowPower, powerPreference: 'high-performance' });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowPower ? 1 : 2));
        renderer.setSize(width, height);
        container.innerHTML = '';
        container.appendChild(renderer.domElement);

        const disposables = [];
        const uniforms = {
          uTime: { value: 0 },
          uVol: { value: 0.25 },
          uColorWine: { value: new THREE.Color('#590907') },
          uColorStone: { value: new THREE.Color('#A5A79B') },
          uColorChampagne: { value: new THREE.Color('#E8D2B5') },
        };

        const waveGeo = new THREE.PlaneGeometry(11, 8, lowPower ? 48 : 96, lowPower ? 48 : 96);
        waveGeo.rotateX(-Math.PI / 2);

        const waveMat = new THREE.ShaderMaterial({
          uniforms,
          transparent: true,
          side: THREE.DoubleSide,
          vertexShader: `
            uniform float uTime;
            uniform float uVol;
            varying float vElev;
            varying vec2 vUv;
            void main() {
              vUv = uv;
              vec3 pos = position;
              float w1 = sin(pos.x * 1.15 + uTime * 0.9) * cos(pos.z * 0.95 + uTime * 0.65) * (0.42 + uVol * 0.25);
              float w2 = sin(pos.x * 2.4 - uTime * 1.35 + pos.z * 1.6) * 0.14;
              float w3 = cos(length(pos.xz) * 1.8 - uTime * 1.2) * 0.16;
              pos.y += w1 + w2 + w3;
              vElev = pos.y;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
            }
          `,
          fragmentShader: `
            uniform vec3 uColorWine;
            uniform vec3 uColorStone;
            uniform vec3 uColorChampagne;
            varying float vElev;
            varying vec2 vUv;
            void main() {
              float h = clamp((vElev + 0.65) / 1.35, 0.0, 1.0);
              vec3 col = mix(uColorWine * 0.65, uColorStone * 0.85, smoothstep(0.18, 0.65, h));
              col = mix(col, uColorChampagne, smoothstep(0.62, 0.96, h));
              float contour = smoothstep(0.03, 0.0, abs(fract(vElev * 5.0) - 0.5));
              col += uColorChampagne * contour * 0.28;
              float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x)
                         * smoothstep(0.0, 0.18, vUv.y) * smoothstep(1.0, 0.82, vUv.y);
              gl_FragColor = vec4(col, edge * 0.92);
            }
          `,
        });

        const waveMesh = new THREE.Mesh(waveGeo, waveMat);
        waveMesh.position.y = -0.35;
        scene.add(waveMesh);
        disposables.push(waveGeo, waveMat);

        const ptCount = lowPower ? 220 : 600;
        const ptPositions = new Float32Array(ptCount * 3);
        const ptPhases = new Float32Array(ptCount);
        for (let i = 0; i < ptCount; i++) {
          ptPositions[i * 3] = (Math.random() - 0.5) * 9.5;
          ptPositions[i * 3 + 1] = 0.2 + Math.random() * 1.8;
          ptPositions[i * 3 + 2] = (Math.random() - 0.5) * 6.5;
          ptPhases[i] = Math.random() * Math.PI * 2;
        }
        const ptGeo = new THREE.BufferGeometry();
        ptGeo.setAttribute('position', new THREE.BufferAttribute(ptPositions, 3));
        const ptMat = new THREE.PointsMaterial({
          color: '#E8D2B5',
          size: 0.042,
          transparent: true,
          opacity: 0.72,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const points = new THREE.Points(ptGeo, ptMat);
        scene.add(points);
        disposables.push(ptGeo, ptMat);

        const onResize = () => {
          const w = container.clientWidth;
          const h = container.clientHeight;
          if (w > 0 && h > 0) {
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            renderer.setSize(w, h);
          }
        };
        window.addEventListener('resize', onResize);

        let rafId = 0;
        let prev = performance.now();

        const animate = (now) => {
          rafId = requestAnimationFrame(animate);
          const dt = Math.min((now - prev) / 1000, 0.05);
          prev = now;

          const vol = Math.min(Math.abs(state.ticks.BTCUSDT.pct || 0) * 0.12, 0.9);
          uniforms.uTime.value += dt * (0.85 + vol * 0.45);
          uniforms.uVol.value += (vol - uniforms.uVol.value) * 0.05;

          const posAttr = ptGeo.attributes.position;
          const t = uniforms.uTime.value;
          for (let i = 0; i < ptCount; i++) {
            const x = posAttr.getX(i);
            const z = posAttr.getZ(i);
            const y = 0.45 + Math.sin(x * 0.8 + t + ptPhases[i]) * 0.35 + Math.cos(z * 0.8 + t * 0.7) * 0.25;
            posAttr.setY(i, y);
          }
          posAttr.needsUpdate = true;

          camera.position.x += (POINTER.x * 0.75 - camera.position.x) * 0.04;
          camera.position.y += ((compact ? 2.1 : 2.35) + POINTER.y * 0.35 - camera.position.y) * 0.04;
          camera.lookAt(0, -0.2, 0);

          renderer.render(scene, camera);
        };
        rafId = requestAnimationFrame(animate);

        return () => {
          cancelAnimationFrame(rafId);
          window.removeEventListener('resize', onResize);
          for (const d of disposables) d.dispose();
          renderer.dispose();
        };
      } catch {
        return () => {};
      }
    }

    function renderHeaderAuth() {
      const area = document.getElementById('header-auth-area');
      const adminNav = document.getElementById('nav-admin-desktop');
      const isAdmin = state.user && state.user.role === 'ADMIN';
      if (adminNav) adminNav.classList.toggle('hidden', !isAdmin);

      if (!area) return;
      const unreadCount = state.notifications.filter((n) => n.unread).length;
      const bellBtn = `
        <button type="button" onclick="toggleNotifPanel()" class="relative p-1.5 sm:p-2 rounded-lg border border-[#A5A79B]/25 bg-[#1C1818] text-[#E8D2B5] hover:border-[#E8D2B5]/50 shrink-0" aria-label="Thông báo">
          <i data-lucide="bell" class="w-4 h-4"></i>
          ${unreadCount > 0 ? `<span class="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-[#D64545] text-white text-[10px] font-bold num flex items-center justify-center">${unreadCount}</span>` : ''}
        </button>
      `;
      if (state.user) {
        area.innerHTML = `
          ${bellBtn}
          ${isAdmin ? `<button type="button" onclick="navigate('admin')" class="lg:hidden px-2 py-1 text-[11px] font-semibold btn-wine rounded whitespace-nowrap shrink-0">Admin</button>` : ''}
          <span class="hidden sm:inline text-xs num px-2.5 sm:px-3 py-1 rounded bg-[#201C1B] border border-[#A5A79B]/25 text-[#E8D2B5] whitespace-nowrap">
            ${isAdmin ? 'ADMIN · ' : ''}${fmtUsd(state.user.credit_balance)}
          </span>
          <button type="button" onclick="logoutUser()" class="px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs btn-stone rounded whitespace-nowrap shrink-0">Thoát</button>
        `;
      } else {
        area.innerHTML = `
          ${bellBtn}
          <button type="button" onclick="navigate('login')" class="px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs text-[#A5A79B] hover:text-[#E8D2B5] whitespace-nowrap shrink-0">Đăng nhập</button>
          <button type="button" onclick="navigate('register')" class="px-2.5 sm:px-3.5 py-1.5 text-[11px] sm:text-xs font-semibold btn-champagne rounded whitespace-nowrap shrink-0">Đăng ký</button>
        `;
      }
    }

    function updateRiskCalc() {
      const d = state.riskDraft;
      const lev = d.leverageMode === 'EXCHANGE_MAX' ? null : Math.max(1, Number(d.leverage) || 1);
      const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

      if (lev === null) {
        setTxt('calc-notional', 'Theo hạn mức sàn');
        setTxt('calc-loss', 'Theo đòn bẩy sàn');
        setTxt('calc-profit', 'Theo đòn bẩy sàn');
        setTxt('calc-fee', '20% vượt đỉnh HWM');
      } else {
        const notional = d.orderMargin * lev;
        const estLoss = notional * (d.slPct / 100);
        const estProfit = notional * (d.tpPct / 100);
        const estFee = estProfit * 0.2;
        setTxt('calc-notional', fmtUsd(notional));
        setTxt('calc-loss', fmtUsd(estLoss));
        setTxt('calc-profit', fmtUsd(estProfit));
        setTxt('calc-fee', fmtUsd(estFee));
      }
    }

    function updateEarnCalc() {
      const { refs, avgMonthlyProfit, avgSubFee } = state.earnCalc;
      let subRate = 0.20;
      let hwmShareRate = 0.15;
      let tierName = 'Cộng tác viên';
      if (refs >= 100) { subRate = 0.35; hwmShareRate = 0.30; tierName = 'Đối tác Kim Cương'; }
      else if (refs >= 30) { subRate = 0.30; hwmShareRate = 0.25; tierName = 'Đối tác Vàng'; }
      else if (refs >= 10) { subRate = 0.25; hwmShareRate = 0.20; tierName = 'Đối tác Bạc'; }

      const subIncome = refs * avgSubFee * subRate;
      const hwmFeesGenerated = refs * (avgMonthlyProfit * 0.20);
      const hwmIncome = hwmFeesGenerated * hwmShareRate;
      const total = subIncome + hwmIncome;

      const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      setTxt('earn-refs-val', `${refs} khách`);
      setTxt('earn-profit-val', `${fmtUsd(avgMonthlyProfit)} / người`);
      setTxt('earn-tier', `${tierName} (${Math.round(subRate * 100)}% gói · ${Math.round(hwmShareRate * 100)}% HWM)`);
      setTxt('earn-sub', fmtUsd(subIncome));
      setTxt('earn-hwm', fmtUsd(hwmIncome));
      setTxt('earn-total', fmtUsd(total));
    }

    function renderView() {
      if (state.activeCleanup) {
        state.activeCleanup();
        state.activeCleanup = null;
      }

      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('nav-active', b.dataset.route === state.route));
      document.querySelectorAll('.m-nav').forEach((b) => b.classList.toggle('m-active', b.dataset.route === state.route));
      renderHeaderAuth();

      const root = document.getElementById('app-root');
      const isAdmin = state.user && state.user.role === 'ADMIN';

      if (state.route === 'landing') {
        root.innerHTML = `
          <div class="space-y-7">
            <section class="panel rounded-xl overflow-hidden grid grid-cols-1 lg:grid-cols-12">
              <div class="lg:col-span-5 p-6 sm:p-8 flex flex-col justify-between space-y-6 border-b lg:border-b-0 lg:border-r border-[#A5A79B]/20">
                <div class="space-y-4">
                  <div class="inline-flex items-center gap-2 text-[11px] font-semibold tracking-wider uppercase text-[#A5A79B]">
                    <span class="w-1.5 h-1.5 rounded-full bg-[#E8D2B5]"></span>
                    BINANCE USD-M FUTURES · BTC · ETH · VÀNG
                  </div>
                  <h1 class="text-2xl sm:text-3xl font-bold text-[#E8D2B5] leading-snug">
                    Giao dịch Futures tự động trên chính tài khoản Binance của bạn.
                  </h1>
                  <p class="text-xs sm:text-sm text-[#A5A79B] leading-relaxed">
                    Bạn chủ động thiết lập vốn, đòn bẩy theo mức sàn hỗ trợ và điểm cắt lỗ. <span class="extreme-run">EXTREME</span> tự động phân tích biến động và ghép thuật toán tối ưu cho từng nhịp thị trường.
                  </p>
                </div>

                <div class="space-y-3.5">
                  <div class="grid grid-cols-2 gap-2.5 sm:gap-3">
                    <div class="panel-inset rounded-lg p-3 sm:p-3.5 min-w-0">
                      <div class="text-[11px] text-[#A5A79B]">Ưu đãi kích hoạt</div>
                      <div class="mt-1 text-sm sm:text-base font-bold num text-[#E8D2B5] truncate">Nạp $1 tặng đến $10</div>
                    </div>
                    <div class="panel-inset rounded-lg p-3 sm:p-3.5 min-w-0">
                      <div class="text-[11px] text-[#A5A79B]">Hoa hồng đối tác</div>
                      <div class="mt-1 text-sm sm:text-base font-bold num text-[#34B37E] truncate">Lên đến 35%</div>
                    </div>
                  </div>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <button type="button" onclick="navigate('register')" class="btn-champagne py-3 px-3 text-xs font-bold rounded-lg">
                      Mở tài khoản ngay
                    </button>
                    <button type="button" onclick="navigate('earn')" class="btn-wine py-3 px-3 text-xs font-semibold rounded-lg">
                      Kiếm tiền cùng <span class="extreme-run">EXTREME</span>
                    </button>
                  </div>
                </div>
              </div>

              <div class="lg:col-span-7 flex flex-col justify-between bg-[#130A0A]">
                <div id="landing-3d" class="w-full h-[220px] sm:h-[340px]"></div>
                <div class="grid grid-cols-3 border-t border-[#A5A79B]/20 bg-[#181313]/95 divide-x divide-[#A5A79B]/20">
                  <div class="p-2.5 sm:p-3.5 min-w-0">
                    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 text-[10px] sm:text-[11px]">
                      <span class="font-semibold text-[#A5A79B]">BTCUSDT</span>
                      <span id="pct-BTCUSDT" class="num"></span>
                    </div>
                    <div id="price-BTCUSDT" class="mt-1 text-xs sm:text-base font-bold num text-[#E8D2B5] truncate">Đang tải</div>
                  </div>
                  <div class="p-2.5 sm:p-3.5 min-w-0">
                    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 text-[10px] sm:text-[11px]">
                      <span class="font-semibold text-[#A5A79B]">ETHUSDT</span>
                      <span id="pct-ETHUSDT" class="num"></span>
                    </div>
                    <div id="price-ETHUSDT" class="mt-1 text-xs sm:text-base font-bold num text-[#E8D2B5] truncate">Đang tải</div>
                  </div>
                  <div class="p-2.5 sm:p-3.5 min-w-0">
                    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 text-[10px] sm:text-[11px]">
                      <span class="font-semibold text-[#A5A79B]">VÀNG</span>
                      <span id="pct-PAXGUSDT" class="num"></span>
                    </div>
                    <div id="price-PAXGUSDT" class="mt-1 text-xs sm:text-base font-bold num text-[#E8D2B5] truncate">Đang tải</div>
                  </div>
                </div>
              </div>
            </section>

            <section class="panel rounded-xl overflow-hidden">
              <div class="px-6 py-4 border-b border-[#A5A79B]/20 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                <h2 class="text-sm font-bold text-[#E8D2B5]">Gói thuê bao tháng &amp; Khuyến mãi nạp lần đầu</h2>
                <span class="text-xs text-[#A5A79B]">Nạp tối thiểu $1.00 để kích hoạt thưởng $5.00 Credit (chống tạo tài khoản ảo)</span>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-[#A5A79B]/20">
                <div class="p-6 space-y-2.5">
                  <div class="text-[11px] font-semibold tracking-wider uppercase text-[#A5A79B]">Gói Dùng thử</div>
                  <div class="text-2xl font-bold num text-[#E8D2B5]">Nạp $1 <span class="text-xs font-normal text-[#34B37E]">+ $5.00 thưởng</span></div>
                  <p class="text-xs text-[#A5A79B] leading-relaxed">Nạp tối thiểu $1.00 ở lần đầu để xác thực tài khoản thật, nhận ngay tổng $6.00 Credit dùng test và trừ phí 20% HWM.</p>
                </div>
                <div class="p-6 space-y-2.5 bg-[#590907]/35">
                  <div class="flex items-center justify-between">
                    <span class="text-[11px] font-semibold tracking-wider uppercase text-[#E8D2B5]">Gói Tiêu chuẩn</span>
                    <span class="text-[10px] font-bold px-2 py-0.5 rounded bg-[#E8D2B5] text-[#590907]">PHỔ BIẾN</span>
                  </div>
                  <div class="text-2xl font-bold num text-[#E8D2B5]">$29 <span class="text-xs font-normal text-[#A5A79B]">/ tháng + 20% HWM</span></div>
                  <p class="text-xs text-[#E8D2B5]/80 leading-relaxed">Mở đồng thời 3 cặp BTC, ETH, Vàng; đòn bẩy theo hạn mức sàn và cảnh báo biến động qua Telegram.</p>
                </div>
                <div class="p-6 space-y-2.5">
                  <div class="text-[11px] font-semibold tracking-wider uppercase text-[#A5A79B]">Gói Chuyên nghiệp</div>
                  <div class="text-2xl font-bold num text-[#E8D2B5]">$79 <span class="text-xs font-normal text-[#A5A79B]">/ tháng + 20% HWM</span></div>
                  <p class="text-xs text-[#A5A79B] leading-relaxed">Không giới hạn quy mô vốn mỗi lệnh, ưu tiên luồng khớp lệnh nhanh và sao kê HWM chi tiết.</p>
                </div>
              </div>
            </section>
          </div>
        `;
        state.activeCleanup = mountExtremeShader3D('landing-3d', false);
      } else if (state.route === 'earn') {
        const refCode = state.earnSummary?.referral_code || state.user?.ref_code || (state.user ? 'EX-' + state.user.email.slice(0, 4).toUpperCase() : 'EX-PARTNER');
        const refLink = `${window.location.origin}/?ref=${refCode}`;
        const ec = state.earnCalc;
        const commBalance = state.earnSummary ? Number(state.earnSummary.commission_balance) : Number(state.user?.commission_balance || 0);
        const activeF1 = state.earnSummary ? Number(state.earnSummary.active_f1_count) : 0;
        const totalF1 = state.earnSummary ? Number(state.earnSummary.total_f1_count) : 0;
        const realTier = state.earnSummary?.tier_name || 'Cộng tác viên';
        root.innerHTML = `
          <div class="space-y-6">
            ${HAS_API && state.token ? renderViewStateBanner() : ''}
            ${renderNoticeBanner()}
            <div class="panel-wine rounded-xl p-6 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
              <div class="space-y-2 max-w-2xl">
                <div class="text-[11px] font-semibold tracking-widest uppercase text-[#E8D2B5]/75">CHƯƠNG TRÌNH ĐỐI TÁC &amp; KIẾM TIỀN <span class="extreme-run">EXTREME</span></div>
                <h1 class="text-xl sm:text-2xl font-bold text-[#E8D2B5]">Xây dựng dòng thu nhập thụ động 2 tầng trọn đời từ phí gói tháng &amp; lợi nhuận HWM</h1>
                <p class="text-xs sm:text-sm text-[#E8D2B5]/80">
                  Mỗi khách hàng nhập mã của bạn khi đăng ký sẽ được <strong class="text-[#34B37E]">nhân đôi thưởng khởi đầu lên $10.00 Credit</strong> (khi nạp từ $1.00) và <strong class="text-[#E8D2B5]">giảm 10% gói tháng đầu</strong>. Bạn nhận hoa hồng gói tháng, chia sẻ phí HWM trọn đời 2 tầng và quỹ thưởng Top Leader.
                </p>
              </div>
              <div class="panel-inset rounded-lg p-4 space-y-2 w-full lg:w-auto lg:min-w-[280px] min-w-0 shrink-0">
                <div class="text-[11px] text-[#A5A79B]">Liên kết giới thiệu của bạn</div>
                <div class="flex items-center gap-2 min-w-0">
                  <code class="text-xs num text-[#E8D2B5] truncate flex-1 min-w-0">${escapeHtml(refLink)}</code>
                  <button type="button" onclick="copyText('${escapeHtml(refLink)}', 'Đã sao chép liên kết giới thiệu.')" class="btn-champagne px-3 py-1.5 text-xs font-bold rounded shrink-0 whitespace-nowrap">Sao chép</button>
                </div>
                <div class="text-[10px] text-[#A5A79B]">Mã đối tác: <strong class="text-[#E8D2B5] num">${escapeHtml(refCode)}</strong></div>
              </div>
            </div>

            ${state.user ? `
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div class="panel rounded-xl p-4">
                <div class="text-xs text-[#A5A79B]">Số dư hoa hồng khả dụng</div>
                <div class="mt-1 text-2xl font-bold num text-[#34B37E]">${fmtUsd(commBalance)}</div>
                <div class="text-[11px] text-[#A5A79B] mt-0.5">Rút tối đa $5.00 / lệnh · Duyệt trong 24h</div>
              </div>
              <div class="panel rounded-xl p-4">
                <div class="text-xs text-[#A5A79B]">Khách hàng F1 đã kích hoạt</div>
                <div class="mt-1 text-2xl font-bold num text-[#E8D2B5]">${activeF1} <span class="text-xs font-normal text-[#A5A79B]">/ ${totalF1} tổng F1</span></div>
                <div class="text-[11px] text-[#A5A79B] mt-0.5">Tính theo F1 đã nạp tối thiểu $1.00</div>
              </div>
              <div class="panel rounded-xl p-4">
                <div class="text-xs text-[#A5A79B]">Cấp bậc đối tác hiện tại</div>
                <div class="mt-1 text-lg font-bold text-[#E8D2B5]">${escapeHtml(realTier)}</div>
                <div class="text-[11px] text-[#A5A79B] mt-0.5 num">${state.earnSummary ? `${state.earnSummary.sub_rate_pct}% gói · ${state.earnSummary.hwm_rate_pct}% HWM · ${state.earnSummary.f2_rate_pct}% F2` : '20% gói · 15% HWM · 5% F2'}</div>
              </div>
            </div>
            ` : ''}

            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div class="panel rounded-xl p-5 space-y-2">
                <div class="text-xs font-bold text-[#E8D2B5]">1. Hoa hồng F1 trọn đời</div>
                <div class="text-xl font-bold num text-[#34B37E]">20% - 35%</div>
                <p class="text-xs text-[#A5A79B] leading-relaxed">Hưởng trực tiếp hoa hồng trên mọi gói thuê bao tháng và phí HWM 20% mỗi khi khách F1 chốt lãi vượt đỉnh.</p>
              </div>
              <div class="panel rounded-xl p-5 space-y-2">
                <div class="text-xs font-bold text-[#E8D2B5]">2. Hoa hồng Hệ thống F2</div>
                <div class="text-xl font-bold num text-[#E8D2B5]">+5% HWM</div>
                <p class="text-xs text-[#A5A79B] leading-relaxed">Khi F1 phát triển thêm khách hàng mới (F2), bạn tự động hưởng thêm 5% từ doanh thu phí HWM của toàn nhánh F2.</p>
              </div>
              <div class="panel rounded-xl p-5 space-y-2">
                <div class="text-xs font-bold text-[#E8D2B5]">3. Quỹ thưởng Top Leader</div>
                <div class="text-xl font-bold num text-[#E8D2B5]">5% Pool Tháng</div>
                <p class="text-xs text-[#A5A79B] leading-relaxed">Trích 5% tổng phí HWM toàn sàn mỗi tháng chia thưởng trực tiếp cho Top 10 đối tác có doanh số hoạt động cao nhất.</p>
              </div>
              <div class="panel rounded-xl p-5 space-y-2">
                <div class="text-xs font-bold text-[#E8D2B5]">4. Rút Bank VNĐ &amp; BSC20</div>
                <div class="text-xl font-bold num text-[#34B37E]">Tối đa $5 / lệnh</div>
                <p class="text-xs text-[#A5A79B] leading-relaxed">Tự động quy đổi sang VNĐ về ngân hàng hoặc dán ID BSC20. Cam kết duyệt rút trong 24h làm việc.</p>
              </div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-12 gap-5">
              <div class="lg:col-span-6 panel rounded-xl p-5 space-y-4">
                <div class="border-b border-[#A5A79B]/20 pb-3">
                  <h2 class="text-sm font-bold text-[#E8D2B5]">Ước tính thu nhập đối tác hàng tháng</h2>
                  <p class="text-xs text-[#A5A79B] mt-0.5">Kéo thử số lượng khách F1 hoạt động để xem mức thu nhập thụ động dự kiến.</p>
                </div>

                <div class="space-y-4">
                  <div>
                    <div class="flex justify-between text-xs mb-1.5">
                      <span class="text-[#A5A79B]">Số khách hàng F1 đang chạy</span>
                      <span id="earn-refs-val" class="num font-bold text-[#E8D2B5]">${ec.refs} khách</span>
                    </div>
                    <input type="range" min="1" max="150" value="${ec.refs}" oninput="setEarnField('refs', Number(this.value))" class="w-full" />
                  </div>

                  <div>
                    <div class="flex justify-between text-xs mb-1.5">
                      <span class="text-[#A5A79B]">Lợi nhuận trung bình / khách / tháng</span>
                      <span id="earn-profit-val" class="num font-bold text-[#E8D2B5]">${fmtUsd(ec.avgMonthlyProfit)} / người</span>
                    </div>
                    <input type="range" min="100" max="5000" step="100" value="${ec.avgMonthlyProfit}" oninput="setEarnField('avgMonthlyProfit', Number(this.value))" class="w-full" />
                  </div>
                </div>

                <div class="panel-inset rounded-lg p-4 space-y-2.5 text-xs">
                  <div class="flex justify-between"><span class="text-[#A5A79B]">Cấp bậc đạt được</span><span id="earn-tier" class="font-semibold text-[#E8D2B5]"></span></div>
                  <div class="flex justify-between"><span class="text-[#A5A79B]">Hoa hồng gói tháng</span><span id="earn-sub" class="num font-semibold text-[#E8D2B5]"></span></div>
                  <div class="flex justify-between"><span class="text-[#A5A79B]">Hoa hồng chia sẻ HWM</span><span id="earn-hwm" class="num font-semibold text-[#E8D2B5]"></span></div>
                  <div class="flex justify-between pt-2 border-t border-[#A5A79B]/20 text-sm">
                    <span class="font-bold text-[#E8D2B5]">Tổng thu nhập dự kiến / tháng</span>
                    <span id="earn-total" class="num font-bold text-[#34B37E]"></span>
                  </div>
                </div>
              </div>

              <div class="lg:col-span-6 panel rounded-xl overflow-hidden">
                <div class="px-5 py-3.5 border-b border-[#A5A79B]/20 text-xs font-bold uppercase tracking-wider text-[#E8D2B5]">4 Cấp bậc Đối tác <span class="extreme-run">EXTREME</span></div>
                <div class="divide-y divide-[#A5A79B]/18 text-xs">
                  <div class="p-4 flex items-center justify-between gap-3">
                    <div>
                      <div class="font-bold text-[#E8D2B5]">Cộng tác viên (0 - 9 khách F1)</div>
                      <div class="text-[#A5A79B] mt-0.5">20% phí gói tháng · 15% phí HWM · 5% nhánh F2</div>
                    </div>
                    <span class="num text-[11px] px-2.5 py-1 rounded panel-inset text-[#A5A79B]">Mặc định</span>
                  </div>
                  <div class="p-4 flex items-center justify-between gap-3">
                    <div>
                      <div class="font-bold text-[#E8D2B5]">Đối tác Bạc (10 - 29 khách F1)</div>
                      <div class="text-[#A5A79B] mt-0.5">25% phí gói tháng · 20% phí HWM · 5% nhánh F2</div>
                    </div>
                    <span class="num text-[11px] px-2.5 py-1 rounded bg-[#590907]/50 text-[#E8D2B5]">Thưởng +$100</span>
                  </div>
                  <div class="p-4 flex items-center justify-between gap-3">
                    <div>
                      <div class="font-bold text-[#E8D2B5]">Đối tác Vàng (30 - 99 khách F1)</div>
                      <div class="text-[#A5A79B] mt-0.5">30% phí gói tháng · 25% phí HWM · 5% nhánh F2</div>
                    </div>
                    <span class="num text-[11px] px-2.5 py-1 rounded bg-[#590907]/70 text-[#E8D2B5]">Thưởng +$500</span>
                  </div>
                  <div class="p-4 flex items-center justify-between gap-3 bg-[#590907]/25">
                    <div>
                      <div class="font-bold text-[#E8D2B5]">Đối tác Kim Cương (100+ khách F1)</div>
                      <div class="text-[#E8D2B5]/80 mt-0.5">35% phí gói tháng · 30% phí HWM · Chia quỹ Top Leader</div>
                    </div>
                    <span class="num text-[11px] px-2.5 py-1 rounded bg-[#E8D2B5] text-[#590907] font-bold">Leader</span>
                  </div>
                </div>
              </div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-12 gap-5">
              <form id="withdraw-form" class="lg:col-span-7 panel rounded-xl p-5 space-y-4">
                <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-[#A5A79B]/20 pb-3">
                  <div>
                    <h2 class="text-sm font-bold text-[#E8D2B5]">Yêu cầu rút hoa hồng</h2>
                    <p class="text-xs text-[#A5A79B] mt-0.5">Rút tối đa <strong class="text-[#E8D2B5]">$5.00 / lệnh</strong> (tự quy đổi ${state.vndRate.toLocaleString('vi-VN')} đ/USD). Cam kết duyệt rút trong <strong class="text-[#34B37E]">24h làm việc</strong>.</p>
                  </div>
                  <span class="text-[11px] num px-2.5 py-1 rounded bg-[#590907] text-[#E8D2B5] border border-[#E8D2B5]/25 shrink-0">DUYỆT 24H</span>
                </div>

                ${HAS_API && !state.token ? `
                  <div class="p-3.5 text-xs rounded-lg panel-inset text-[#A5A79B] flex items-center justify-between gap-3">
                    <span>Đăng nhập để xem số dư hoa hồng thật và gửi yêu cầu rút tiền.</span>
                    <button type="button" onclick="navigate('login')" class="btn-champagne px-3.5 py-1.5 text-xs font-bold rounded-lg shrink-0">Đăng nhập</button>
                  </div>
                ` : ''}

                <div class="grid grid-cols-2 gap-2.5">
                  <button type="button" onclick="setWithdrawMethod('BANK')" class="py-2.5 text-xs font-semibold rounded-lg border transition-colors ${state.withdrawDraft.method === 'BANK' ? 'bg-[#590907] text-[#E8D2B5] border-[#E8D2B5]/50' : 'panel-inset text-[#A5A79B]'}">
                    Ngân hàng Việt Nam (VNĐ)
                  </button>
                  <button type="button" onclick="setWithdrawMethod('BSC20')" class="py-2.5 text-xs font-semibold rounded-lg border transition-colors ${state.withdrawDraft.method === 'BSC20' ? 'bg-[#590907] text-[#E8D2B5] border-[#E8D2B5]/50' : 'panel-inset text-[#A5A79B]'}">
                    BSC20 / BEP20 (USDT)
                  </button>
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3.5 items-end">
                  <div>
                    <label class="block text-xs text-[#A5A79B] mb-1">Số tiền muốn rút (USD, tối đa $5)</label>
                    <input id="wd-amt" type="number" min="0.5" max="5" step="0.5" required value="${state.withdrawDraft.amount}" oninput="updateWithdrawVnd(this.value)" class="w-full px-3.5 py-2.5 text-sm num font-bold panel-inset rounded-lg text-[#E8D2B5] focus:outline-none focus:border-[#E8D2B5]" />
                  </div>
                  ${state.withdrawDraft.method === 'BANK' ? `
                  <div class="panel-inset rounded-lg p-2.5">
                    <div class="text-[11px] text-[#A5A79B]">Quy đổi tự động sang VNĐ</div>
                    <div id="wd-vnd-preview" class="text-base font-bold num text-[#34B37E] mt-0.5">${Math.round(state.withdrawDraft.amount * state.vndRate).toLocaleString('vi-VN')} VNĐ</div>
                    <div id="wd-rate-note" class="text-[10px] text-[#A5A79B] mt-0.5">${escapeHtml(state.vndRateSource)}</div>
                  </div>
                  ` : `
                  <div class="panel-inset rounded-lg p-2.5">
                    <div class="text-[11px] text-[#A5A79B]">Thực nhận qua mạng BSC20 (BEP20)</div>
                    <div id="wd-usdt-preview" class="text-base font-bold num text-[#34B37E] mt-0.5">${fmtNum(state.withdrawDraft.amount, 2)} USDT</div>
                    <div class="text-[10px] text-[#A5A79B] mt-0.5">Nhận trực tiếp bằng USDT, không quy đổi VNĐ</div>
                  </div>
                  `}
                </div>

                ${state.withdrawDraft.method === 'BSC20' ? `
                  <div>
                    <label class="block text-xs text-[#A5A79B] mb-1">Dán địa chỉ ví hoặc ID BSC20 (BEP20)</label>
                    <input id="wd-bsc" type="text" required value="${escapeHtml(state.withdrawDraft.bscId)}" placeholder="0x... hoặc ID nhận BSC20" class="w-full px-3.5 py-2.5 text-xs num panel-inset rounded-lg text-[#E8D2B5] focus:outline-none focus:border-[#E8D2B5]" />
                  </div>
                ` : `
                  <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label class="block text-xs text-[#A5A79B] mb-1">Tên ngân hàng</label>
                      <input id="wd-bank-name" type="text" required value="${escapeHtml(state.withdrawDraft.bankName)}" placeholder="VD: MB Bank, Vietcombank" class="w-full px-3.5 py-2.5 text-xs panel-inset rounded-lg text-[#E8D2B5] focus:outline-none focus:border-[#E8D2B5]" />
                    </div>
                    <div>
                      <label class="block text-xs text-[#A5A79B] mb-1">Số tài khoản</label>
                      <input id="wd-bank-acc" type="text" required value="${escapeHtml(state.withdrawDraft.bankAccount)}" placeholder="Nhập số tài khoản" class="w-full px-3.5 py-2.5 text-xs num panel-inset rounded-lg text-[#E8D2B5] focus:outline-none focus:border-[#E8D2B5]" />
                    </div>
                    <div>
                      <label class="block text-xs text-[#A5A79B] mb-1">Tên người nhận</label>
                      <input id="wd-bank-holder" type="text" required value="${escapeHtml(state.withdrawDraft.bankHolder)}" placeholder="NGUYEN VAN A" class="w-full px-3.5 py-2.5 text-xs uppercase panel-inset rounded-lg text-[#E8D2B5] focus:outline-none focus:border-[#E8D2B5]" />
                    </div>
                  </div>
                `}

                <div class="p-3 rounded-lg panel-inset text-[11px] text-[#A5A79B]">
                  Cam kết xử lý: Sau khi bạn điền đúng thông tin nhận tiền và gửi lệnh, bộ phận tài chính sẽ đối soát và giải ngân trong vòng <strong class="text-[#E8D2B5]">24h làm việc</strong>. Mọi cập nhật sẽ gửi trực tiếp vào mục <strong class="text-[#E8D2B5]">Thông báo</strong>.
                </div>

                <div id="wd-msg" class="hidden p-3 text-xs rounded-lg"></div>

                <div class="flex justify-end">
                  <button type="submit" class="btn-champagne px-5 py-2.5 text-xs font-bold rounded-lg">Gửi yêu cầu rút tiền</button>
                </div>
              </form>

              <div class="lg:col-span-5 panel rounded-xl overflow-hidden">
                <div class="px-5 py-3.5 border-b border-[#A5A79B]/20 text-xs font-bold uppercase tracking-wider text-[#E8D2B5]">Lịch sử yêu cầu rút</div>
                ${state.withdraws.length === 0 ? `
                  <div class="p-6 text-xs text-[#A5A79B]">Chưa có yêu cầu rút hoa hồng nào.</div>
                ` : `
                  <div class="divide-y divide-[#A5A79B]/18">
                    ${state.withdraws.map((w) => {
                      const amtUsd = Number(w.amount_usd ?? w.amount ?? 0);
                      const amtVnd = Number(w.amount_vnd ?? w.vnd ?? Math.round(amtUsd * state.vndRate));
                      const target = w.method === 'BSC20'
                        ? (w.bsc20_address || w.target || '')
                        : (w.target || [w.bank_name, w.bank_account_no, w.bank_account_holder].filter(Boolean).join(' · '));
                      const st = withdrawStatusMeta(w.status);
                      const tm = w.created_at ? fmtDateTime(w.created_at) : (w.time || '');
                      return `
                      <div class="p-4 text-xs space-y-1">
                        <div class="flex items-center justify-between gap-2">
                          <span class="font-bold num text-[#E8D2B5]">${w.method === 'BANK' ? fmtUsd(amtUsd) + ' (' + Math.round(amtVnd).toLocaleString('vi-VN') + ' VNĐ)' : fmtNum(amtUsd, 2) + ' USDT (BSC20)'}</span>
                          <span class="text-[10px] px-2 py-0.5 rounded ${st.cls}">${escapeHtml(st.text)}</span>
                        </div>
                        <div class="text-[#A5A79B] break-all">${w.method === 'BSC20' ? 'BSC20: ' + escapeHtml(target) : escapeHtml(target)}</div>
                        ${w.admin_note ? `<div class="text-[11px] text-[#E8D2B5]/80">Ghi chú Admin: ${escapeHtml(w.admin_note)}</div>` : ''}
                        <div class="text-[10px] text-[#34B37E]">Cam kết duyệt trong 24h làm việc · ${escapeHtml(tm)}</div>
                      </div>
                    `;
                    }).join('')}
                  </div>
                `}
              </div>
            </div>
          </div>
        `;
        updateEarnCalc();
        const wdForm = document.getElementById('withdraw-form');
        if (wdForm) {
          wdForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const amt = parseFloat(document.getElementById('wd-amt')?.value || '0');
            const box = document.getElementById('wd-msg');
            if (isNaN(amt) || amt <= 0 || amt > 5) {
              box.className = 'p-3 text-xs rounded-lg bg-[#D64545]/15 border border-[#D64545]/40 text-[#D64545]';
              box.textContent = 'Số tiền rút phải lớn hơn $0 và tối đa $5.00 mỗi lệnh.';
              return;
            }
            const method = state.withdrawDraft.method;
            let target = '';
            let payload = { method, amount_usd: amt.toFixed(2) };
            if (method === 'BSC20') {
              const idVal = document.getElementById('wd-bsc')?.value.trim() || '';
              if (idVal.length < 6) {
                box.className = 'p-3 text-xs rounded-lg bg-[#D64545]/15 border border-[#D64545]/40 text-[#D64545]';
                box.textContent = 'Vui lòng dán địa chỉ ví hoặc ID BSC20 hợp lệ.';
                return;
              }
              target = idVal;
              state.withdrawDraft.bscId = idVal;
              payload.bsc20_address = idVal;
            } else {
              const bankName = document.getElementById('wd-bank-name')?.value.trim() || '';
              const bankAcc = document.getElementById('wd-bank-acc')?.value.trim() || '';
              const bankHolder = (document.getElementById('wd-bank-holder')?.value.trim() || '').toUpperCase();
              if (!bankName || !bankAcc || !bankHolder) {
                box.className = 'p-3 text-xs rounded-lg bg-[#D64545]/15 border border-[#D64545]/40 text-[#D64545]';
                box.textContent = 'Vui lòng điền đủ Tên ngân hàng, Số tài khoản và Tên người nhận.';
                return;
              }
              target = `${bankName} · ${bankAcc} · ${bankHolder}`;
              state.withdrawDraft.bankName = bankName;
              state.withdrawDraft.bankAccount = bankAcc;
              state.withdrawDraft.bankHolder = bankHolder;
              payload.vnd_rate = String(state.vndRate);
              payload.bank_name = bankName;
              payload.bank_account_no = bankAcc;
              payload.bank_account_holder = bankHolder;
            }

            if (HAS_API) {
              if (!state.token) {
                box.className = 'p-3 text-xs rounded-lg bg-[#D64545]/15 border border-[#D64545]/40 text-[#D64545]';
                box.textContent = 'Vui lòng đăng nhập để gửi yêu cầu rút hoa hồng.';
                return;
              }
              box.className = 'p-3 text-xs rounded-lg bg-[#590907]/40 text-[#E8D2B5]';
              box.textContent = 'Đang gửi yêu cầu rút tiền lên máy chủ...';
              try {
                await apiRequest('/api/v1/earn/withdraw', { method: 'POST', body: payload });
                setNotice('success', `Đã gửi yêu cầu rút ${fmtUsd(amt)} thành công. Cam kết duyệt trong 24h làm việc.`);
                await syncNotificationsFromApi();
                await loadRouteData('earn');
              } catch (err) {
                box.className = 'p-3 text-xs rounded-lg bg-[#D64545]/15 border border-[#D64545]/40 text-[#D64545]';
                box.textContent = err.message;
              }
              return;
            }

            const vnd = Math.round(amt * state.vndRate);
            state.withdraws.unshift({
              method,
              amount: amt,
              vnd,
              target,
              status: 'PENDING',
              time: new Date().toLocaleString('vi-VN'),
            });
            localStorage.setItem('ex_withdraws', JSON.stringify(state.withdraws));
            pushNotification(
              'Đã tiếp nhận yêu cầu rút tiền',
              `Rút ${fmtUsd(amt)} (${vnd.toLocaleString('vi-VN')} VNĐ) qua ${method}. Cam kết duyệt trong 24h làm việc.`
            );
            renderView();
          });
        }
      } else if (state.route === 'guide') {
        root.innerHTML = `
          <div class="space-y-6">
            <div class="panel-wine rounded-xl p-6 space-y-2">
              <div class="text-[11px] font-semibold tracking-widest uppercase text-[#E8D2B5]/75">HƯỚNG DẪN SỬ DỤNG <span class="extreme-run">EXTREME</span></div>
              <h1 class="text-xl sm:text-2xl font-bold text-[#E8D2B5]">Quy trình 5 bước thiết lập và giao dịch Futures tự động</h1>
              <p class="text-xs sm:text-sm text-[#E8D2B5]/80 max-w-2xl">
                Làm theo đúng 5 bước dưới đây để kết nối tài khoản Binance USD-M Futures an toàn, nhận khuyến mãi $5.00 Credit khi nạp tối thiểu $1.00 và bắt đầu vận hành.
              </p>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div class="panel rounded-xl p-5 space-y-2.5">
                <div class="flex items-center gap-2.5">
                  <span class="w-7 h-7 rounded-full bg-[#590907] border border-[#E8D2B5]/40 text-xs font-bold num flex items-center justify-center text-[#E8D2B5]">01</span>
                  <h2 class="text-sm font-bold text-[#E8D2B5]">Kích hoạt Ví Credit (Nạp tối thiểu $1.00 tặng $5.00)</h2>
                </div>
                <p class="text-xs text-[#A5A79B] leading-relaxed">
                  Tài khoản mới có số dư $0.00 nhằm chống tạo tài khoản ảo. Vào mục <strong class="text-[#E8D2B5]">Ví Credit</strong>, nạp lần đầu tối thiểu <strong class="text-[#E8D2B5]">$1.00</strong> (qua VietQR hoặc USDT BEP20), hệ thống sẽ tự động cộng thêm <strong class="text-[#34B37E]">$5.00 khuyến mãi</strong> (tổng $6.00 Credit) để bạn kiểm thử và trừ phí 20% HWM.
                </p>
                <button type="button" onclick="navigate('wallet')" class="text-xs font-semibold text-[#E8D2B5] hover:underline">Mở Ví Credit ngay</button>
              </div>

              <div class="panel rounded-xl p-5 space-y-2.5">
                <div class="flex items-center gap-2.5">
                  <span class="w-7 h-7 rounded-full bg-[#590907] border border-[#E8D2B5]/40 text-xs font-bold num flex items-center justify-center text-[#E8D2B5]">02</span>
                  <h2 class="text-sm font-bold text-[#E8D2B5]">Tạo khóa API trên sàn Binance (Tắt quyền rút tiền)</h2>
                </div>
                <p class="text-xs text-[#A5A79B] leading-relaxed">
                  Đăng nhập Binance, mở mục <strong class="text-[#E8D2B5]">Quản lý API (API Management)</strong> và tạo khóa mới. Tích chọn <strong class="text-[#E8D2B5]">Bật Đọc (Enable Reading)</strong> và <strong class="text-[#E8D2B5]">Bật Futures (Enable Futures)</strong>. Giữ tắt hoàn toàn quyền Rút tiền (Withdrawals) và dán địa chỉ IP Whitelist lấy từ trang Kết nối API của <span class="extreme-run">EXTREME</span>.
                </p>
                <button type="button" onclick="navigate('api-keys')" class="text-xs font-semibold text-[#E8D2B5] hover:underline">Lấy địa chỉ IP Whitelist</button>
              </div>

              <div class="panel rounded-xl p-5 space-y-2.5">
                <div class="flex items-center gap-2.5">
                  <span class="w-7 h-7 rounded-full bg-[#590907] border border-[#E8D2B5]/40 text-xs font-bold num flex items-center justify-center text-[#E8D2B5]">03</span>
                  <h2 class="text-sm font-bold text-[#E8D2B5]">Gắn khóa API &amp; Kiểm tra số dư Futures</h2>
                </div>
                <p class="text-xs text-[#A5A79B] leading-relaxed">
                  Chuyển vốn USDT sang ví <strong class="text-[#E8D2B5]">USD-M Futures</strong> trên Binance. Sau đó vào mục <strong class="text-[#E8D2B5]">Kết nối API</strong> trên <span class="extreme-run">EXTREME</span>, dán API Key và API Secret rồi bấm Lưu &amp; Kiểm tra kết nối để xác nhận quyền hợp lệ.
                </p>
              </div>

              <div class="panel rounded-xl p-5 space-y-2.5">
                <div class="flex items-center gap-2.5">
                  <span class="w-7 h-7 rounded-full bg-[#590907] border border-[#E8D2B5]/40 text-xs font-bold num flex items-center justify-center text-[#E8D2B5]">04</span>
                  <h2 class="text-sm font-bold text-[#E8D2B5]">Thiết lập Quản trị rủi ro &amp; Kích hoạt</h2>
                </div>
                <p class="text-xs text-[#A5A79B] leading-relaxed">
                  Vào mục <strong class="text-[#E8D2B5]">Quản trị rủi ro</strong>, chọn cặp giao dịch (<strong class="text-[#E8D2B5]">BTCUSDT, ETHUSDT, XAUUSDT</strong>), mức rủi ro mục tiêu, chế độ Isolated/Cross, đòn bẩy theo hạn mức sàn, vốn ký quỹ mỗi lệnh và tỷ lệ Cắt lỗ (SL) / Chốt lời (TP). Bấm Lưu cấu hình, hệ thống sẽ tự ghép thuật toán và vào lệnh khi có tín hiệu.
                </p>
                <button type="button" onclick="navigate('bots')" class="text-xs font-semibold text-[#E8D2B5] hover:underline">Mở Quản trị rủi ro</button>
              </div>
            </div>

            <div class="panel rounded-xl p-5 space-y-3">
              <h2 class="text-sm font-bold text-[#E8D2B5]">Nguyên tắc bảo vệ tài khoản &amp; Tính phí 20% HWM</h2>
              <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs text-[#A5A79B]">
                <div class="panel-inset rounded-lg p-3.5 space-y-1">
                  <div class="font-semibold text-[#E8D2B5]">Bắt buộc có SL &amp; TP</div>
                  <p>Mọi vị thế mở ra đều đi kèm lệnh cắt lỗ (STOP_MARKET) và chốt lời (TAKE_PROFIT_MARKET) đặt trực tiếp trên sàn Binance.</p>
                </div>
                <div class="panel-inset rounded-lg p-3.5 space-y-1">
                  <div class="font-semibold text-[#E8D2B5]">Chỉ thu phí khi vượt đỉnh lãi</div>
                  <p>Phí 20% chỉ trừ vào Ví Credit khi tổng lãi ròng cộng dồn vượt mốc Đỉnh Lợi Nhuận (HWM) trước đó. Giai đoạn gỡ lỗ hoàn toàn không bị trừ phí.</p>
                </div>
                <div class="panel-inset rounded-lg p-3.5 space-y-1">
                  <div class="font-semibold text-[#E8D2B5]">Không bao giờ ép đóng lệnh</div>
                  <p>Khi Ví Credit về $0.00, hệ thống chỉ tạm khóa mở vị thế mới. Các vị thế đang chạy vẫn giữ nguyên SL/TP cho đến khi tự đóng.</p>
                </div>
              </div>
            </div>
          </div>
        `;
      } else if (state.route === 'dashboard') {
        if (HAS_API && !state.token) {
          root.innerHTML = renderAuthRequiredCard(
            'Đăng nhập để xem Tổng quan tài khoản',
            'Kết nối tới máy chủ EXTREME để theo dõi số dư Credit, đỉnh HWM, vị thế Futures đang mở và trạng thái bot.'
          );
        } else {
          const sum = state.dashboardSummary;
          const credit = sum ? Number(sum.credit_balance) : (state.user ? state.user.credit_balance : 0.0);
          const hwm = sum ? Number(sum.high_water_mark) : (state.user ? state.user.high_water_mark : 0.0);
          const cumPnl = sum ? Number(sum.cumulative_net_pnl) : (state.user ? state.user.cumulative_net_pnl : 0.0);
          const bonusClaimed = state.user ? Boolean(state.user.bonus_claimed) : false;
          const hasReferrer = Boolean(state.user?.has_referrer);
          const bonusUsd = hasReferrer ? 10 : 5;
          const totalWithOne = bonusUsd + 1;
          const activeCount = sum ? Number(sum.active_bots_count) : state.configs.filter((c) => c.status === 'RUNNING').length;
          const openPositions = Array.isArray(sum?.open_positions) ? sum.open_positions : [];
          const wsLiveLabel = sum ? (sum.ws_feed_connected ? 'TRỰC TIẾP' : 'ĐANG KẾT NỐI') : 'TRỰC TIẾP';
          const pnlSign = cumPnl >= 0 ? '+' : '-';
          root.innerHTML = `
            <div class="space-y-6">
              ${renderViewStateBanner()}
              ${renderNoticeBanner()}
              ${!bonusClaimed ? `
              <div class="panel-wine rounded-xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <div class="text-xs font-bold text-[#E8D2B5]">Kích hoạt thưởng $${bonusUsd}.00 Credit${hasReferrer ? ' (Nhân đôi qua mã giới thiệu)' : ' cho tài khoản mới'}</div>
                  <div class="text-xs text-[#E8D2B5]/80 mt-0.5">Nạp lần đầu tối thiểu $1.00 để xác thực tài khoản thật và nhận ngay $${bonusUsd}.00 khuyến mãi (tổng $${totalWithOne}.00 Credit)${hasReferrer ? ' + giảm 10% gói tháng đầu' : ''}.</div>
                </div>
                <button type="button" onclick="navigate('wallet')" class="btn-champagne px-4 py-2 text-xs font-bold rounded-lg shrink-0">Nạp $1 nhận $${bonusUsd}</button>
              </div>
              ` : ''}

              <div class="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3.5">
                <div class="panel-wine rounded-xl p-3.5 sm:p-4 min-w-0">
                  <div class="text-[11px] sm:text-xs text-[#E8D2B5]/75">Số dư Ví Credit</div>
                  <div class="mt-1.5 text-lg sm:text-2xl font-bold num text-[#E8D2B5] truncate">${fmtUsd(credit)}</div>
                  <div class="mt-1 text-[10.5px] sm:text-[11px] text-[#E8D2B5]/70">${bonusClaimed ? `Đã nhận thưởng $${bonusUsd}.00` : `Nạp tối thiểu $1 để nhận $${bonusUsd}`}</div>
                </div>
                <div class="panel rounded-xl p-3.5 sm:p-4 min-w-0">
                  <div class="text-[11px] sm:text-xs text-[#A5A79B]">Gói hiện tại</div>
                  <div class="mt-1.5 text-base sm:text-xl font-bold text-[#E8D2B5] truncate">${escapeHtml(planLabel(state.user?.plan, state.user?.role))}</div>
                  <div class="mt-1 text-[10.5px] sm:text-[11px] text-[#A5A79B] truncate">${isAdmin ? 'Toàn quyền hệ thống' : (state.user?.plan_expires_at ? 'Hạn: ' + fmtDateTime(state.user.plan_expires_at) : 'Nâng cấp gói tháng tại Ví')}</div>
                </div>
                <div class="panel rounded-xl p-3.5 sm:p-4 min-w-0">
                  <div class="text-[11px] sm:text-xs text-[#A5A79B]">Đỉnh Lợi Nhuận (HWM)</div>
                  <div class="mt-1.5 text-lg sm:text-2xl font-bold num text-[#E8D2B5] truncate">${fmtUsd(hwm)}</div>
                  <div class="mt-1 text-[10.5px] sm:text-[11px] num truncate ${cumPnl >= 0 ? 'text-[#34B37E]' : 'text-[#D64545]'}">Lãi ròng: ${pnlSign}${fmtUsd(Math.abs(cumPnl))}</div>
                </div>
                <div class="panel rounded-xl p-3.5 sm:p-4 min-w-0">
                  <div class="text-[11px] sm:text-xs text-[#A5A79B]">Cấu hình đang chạy</div>
                  <div class="mt-1.5 text-lg sm:text-2xl font-bold num text-[#E8D2B5]">${activeCount} / ${state.configs.length}</div>
                  <div class="mt-1 text-[10.5px] sm:text-[11px] text-[#A5A79B]">Tự động ghép chiến lược</div>
                </div>
              </div>

              <div class="panel rounded-xl overflow-hidden grid grid-cols-1 lg:grid-cols-12">
                <div class="lg:col-span-5 bg-[#130A0A] border-b lg:border-b-0 lg:border-r border-[#A5A79B]/20">
                  <div id="pulse-3d" class="w-full h-[210px]"></div>
                </div>
                <div class="lg:col-span-7 p-5 flex flex-col justify-between gap-4">
                  <div class="flex items-center justify-between">
                    <h1 class="text-xs font-bold tracking-wider uppercase text-[#E8D2B5]">Sóng thanh khoản Futures trực tiếp</h1>
                    <span class="text-[10px] font-semibold px-2.5 py-1 rounded bg-[#590907] text-[#E8D2B5] border border-[#E8D2B5]/25 whitespace-nowrap">${wsLiveLabel}</span>
                  </div>
                  <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div class="panel-inset rounded-lg p-3.5">
                      <div class="flex justify-between items-center"><span class="text-xs font-semibold text-[#A5A79B]">BTCUSDT</span><span id="pct-BTCUSDT" class="num text-xs"></span></div>
                      <div id="price-BTCUSDT" class="mt-1.5 text-lg font-bold num text-[#E8D2B5]">Đang tải</div>
                    </div>
                    <div class="panel-inset rounded-lg p-3.5">
                      <div class="flex justify-between items-center"><span class="text-xs font-semibold text-[#A5A79B]">ETHUSDT</span><span id="pct-ETHUSDT" class="num text-xs"></span></div>
                      <div id="price-ETHUSDT" class="mt-1.5 text-lg font-bold num text-[#E8D2B5]">Đang tải</div>
                    </div>
                    <div class="panel-inset rounded-lg p-3.5">
                      <div class="flex justify-between items-center"><span class="text-xs font-semibold text-[#A5A79B]">VÀNG</span><span id="pct-PAXGUSDT" class="num text-xs"></span></div>
                      <div id="price-PAXGUSDT" class="mt-1.5 text-lg font-bold num text-[#E8D2B5]">Đang tải</div>
                    </div>
                  </div>
                </div>
              </div>

              <div class="panel rounded-xl overflow-hidden">
                <div class="px-5 py-3.5 border-b border-[#A5A79B]/20 flex justify-between items-center text-xs">
                  <span class="font-bold tracking-wider uppercase text-[#E8D2B5]">Vị thế đang mở</span>
                  <span class="num text-[#A5A79B]">${openPositions.length} vị thế</span>
                </div>
                ${openPositions.length === 0 ? `
                <div class="p-6 text-xs text-[#A5A79B] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <span>Chưa có vị thế Futures nào đang mở trên tài khoản.</span>
                  <div class="flex flex-wrap gap-2">
                    <button type="button" onclick="navigate('trades')" class="btn-stone px-3.5 py-2 rounded-lg font-semibold">Lịch sử lệnh</button>
                    <button type="button" onclick="navigate('earn')" class="btn-stone px-3.5 py-2 rounded-lg font-semibold">Kiếm tiền đối tác</button>
                    <button type="button" onclick="navigate('api-keys')" class="btn-champagne px-3.5 py-2 rounded-lg font-semibold">Kết nối API</button>
                    <button type="button" onclick="navigate('bots')" class="btn-wine px-3.5 py-2 rounded-lg font-semibold">Cài đặt rủi ro</button>
                  </div>
                </div>
                ` : `
                <div class="divide-y divide-[#A5A79B]/18">
                  ${openPositions.map((p) => {
                    const upnl = Number(p.unrealized_pnl || 0);
                    return `
                    <div class="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs">
                      <div class="space-y-1">
                        <div class="flex items-center gap-2">
                          <span class="font-bold num text-[#E8D2B5]">${escapeHtml(p.symbol)}</span>
                          <span class="text-[10px] font-bold px-2 py-0.5 rounded ${p.side === 'LONG' ? 'bg-[#34B37E]/15 text-[#34B37E]' : 'bg-[#D64545]/15 text-[#D64545]'}">${escapeHtml(p.side)}</span>
                          <span class="text-[10px] num text-[#A5A79B]">${escapeHtml(p.margin_type)} · ${p.leverage}x</span>
                          ${p.breakeven_moved ? '<span class="text-[10px] px-2 py-0.5 rounded bg-[#590907] text-[#E8D2B5]">SL Hòa vốn</span>' : ''}
                        </div>
                        <div class="num text-[#A5A79B]">Vào: ${escapeHtml(fmtNum(p.entry_price))} · KL: ${escapeHtml(fmtNum(p.quantity))} · SL: ${escapeHtml(fmtNum(p.stop_loss_price))} · TP: ${escapeHtml(fmtNum(p.take_profit_price))}</div>
                      </div>
                      <div class="num font-bold text-sm ${upnl >= 0 ? 'text-[#34B37E]' : 'text-[#D64545]'}">${upnl > 0 ? '+' : ''}${fmtUsd(upnl, 4)}</div>
                    </div>
                  `;
                  }).join('')}
                </div>
                `}
              </div>
            </div>
          `;
          state.activeCleanup = mountExtremeShader3D('pulse-3d', true);
        }
      } else if (state.route === 'api-keys') {
        if (HAS_API && !state.token) {
          root.innerHTML = renderAuthRequiredCard(
            'Đăng nhập để quản lý khóa API Binance',
            'Khóa API Secret được mã hóa AES-256-GCM và kiểm tra tắt quyền rút tiền trước khi lưu.'
          );
        } else {
          root.innerHTML = `
            <div class="space-y-5">
              ${renderViewStateBanner()}
              ${renderNoticeBanner()}
              <div class="panel-wine rounded-xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <div class="text-xs font-bold text-[#E8D2B5]">Địa chỉ IP Whitelist hệ thống</div>
                  <div class="text-xs text-[#E8D2B5]/80 mt-0.5">Dán IP này vào phần Quản lý API Binance và giữ tắt quyền Rút tiền.</div>
                </div>
                <div class="flex items-center gap-2">
                  <code class="px-3 py-1.5 bg-[#130A0A] border border-[#E8D2B5]/30 text-xs num font-semibold text-[#E8D2B5] rounded">${escapeHtml(state.serverStaticIp)}</code>
                  <button type="button" onclick="copyText('${escapeHtml(state.serverStaticIp)}', 'Đã sao chép địa chỉ IP Whitelist.')" class="btn-champagne px-3.5 py-1.5 text-xs font-bold rounded">Sao chép</button>
                </div>
              </div>

              <form id="api-form" class="panel rounded-xl p-4 sm:p-5 space-y-4">
                <div class="flex items-center justify-between gap-2 border-b border-[#A5A79B]/20 pb-3">
                  <h1 class="text-sm font-bold text-[#E8D2B5] min-w-0">Kết nối API Binance USD-M Futures</h1>
                  <span class="text-[10px] font-semibold px-2.5 py-1 rounded bg-[#590907] text-[#E8D2B5] border border-[#E8D2B5]/25 whitespace-nowrap shrink-0">
                    ${isAdmin ? 'QUYỀN ADMIN' : 'TÀI KHOẢN LIVE'}
                  </span>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label class="block text-xs text-[#A5A79B] mb-1.5">Tên gợi nhớ</label>
                    <input id="k-label" type="text" required value="Tài khoản Binance Futures" class="w-full px-3.5 py-2.5 text-xs panel-inset rounded-lg text-[#E8D2B5] focus:outline-none focus:border-[#E8D2B5]" />
                  </div>
                  <div>
                    <label class="block text-xs text-[#A5A79B] mb-1.5">Môi trường kết nối</label>
                    <input type="text" value="Binance USD-M Futures (Live)" readonly class="w-full px-3.5 py-2.5 text-xs bg-[#201C1B] border border-[#A5A79B]/25 rounded-lg text-[#E8D2B5]" />
                    ${isAdmin ? `<a class="inline-block mt-1 text-xs underline text-[#E8D2B5]" href="./testnet.html">Mở Binance Futures Testnet</a>` : ''}
                  </div>
                  <div>
                    <label class="block text-xs text-[#A5A79B] mb-1.5">API Key</label>
                    <input id="k-key" type="text" required placeholder="Nhập API Key từ Binance" class="w-full px-3.5 py-2.5 text-xs num panel-inset rounded-lg text-[#E8D2B5] focus:outline-none focus:border-[#E8D2B5]" />
                  </div>
                  <div>
                    <label class="block text-xs text-[#A5A79B] mb-1.5">API Secret</label>
                    <input id="k-secret" type="password" required placeholder="Nhập API Secret" class="w-full px-3.5 py-2.5 text-xs num panel-inset rounded-lg text-[#E8D2B5] focus:outline-none focus:border-[#E8D2B5]" />
                  </div>
                </div>
                <div id="api-form-msg" class="hidden p-3 text-xs rounded-lg"></div>
                <button type="submit" class="btn-champagne w-full sm:w-auto px-5 py-2.5 text-xs font-bold rounded-lg">Lưu &amp; Kiểm tra kết nối</button>
              </form>

              <div class="panel rounded-xl overflow-hidden">
                <div class="px-5 py-3.5 border-b border-[#A5A79B]/20 text-xs font-bold uppercase tracking-wider text-[#E8D2B5]">Khóa API đã kết nối</div>
                ${state.apiKeys.length === 0 ? `
                  <div class="p-6 text-xs text-[#A5A79B]">Chưa có khóa API nào được kết nối.</div>
                ` : `
                  <div class="divide-y divide-[#A5A79B]/18">
                    ${state.apiKeys.map((k, idx) => {
                      const env = k.environment || k.env || 'LIVE';
                      const masked = k.api_key_masked || k.masked || '****';
                      const keyIdArg = HAS_API ? `'${escapeHtml(k.id)}'` : idx;
                      return `
                      <div class="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                        <div>
                          <div class="text-xs font-semibold text-[#E8D2B5]">
                            ${escapeHtml(k.label)}
                            <span class="ml-1.5 text-[10px] num px-2 py-0.5 rounded bg-[#590907] text-[#E8D2B5]">${escapeHtml(env)}</span>
                            ${k.can_trade_futures ? '<span class="ml-1 text-[10px] px-2 py-0.5 rounded bg-[#34B37E]/15 text-[#34B37E]">Futures OK</span>' : ''}
                          </div>
                          <div class="text-xs num text-[#A5A79B] mt-0.5">${escapeHtml(masked)}${k.last_verified_at ? ' · Kiểm tra: ' + escapeHtml(fmtDateTime(k.last_verified_at)) : ''}</div>
                        </div>
                        <div class="flex items-center gap-2">
                          ${HAS_API ? `<button type="button" onclick="testApiKey('${escapeHtml(k.id)}')" class="btn-stone px-3 py-1.5 text-xs rounded-lg font-medium">Kiểm tra</button>` : ''}
                          <button type="button" onclick="deleteApiKey(${keyIdArg})" class="px-3 py-1.5 text-xs border border-[#D64545]/45 text-[#D64545] rounded-lg font-medium">Xóa</button>
                        </div>
                      </div>
                    `;
                    }).join('')}
                  </div>
                `}
              </div>
            </div>
          `;
          document.getElementById('api-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const label = document.getElementById('k-label').value.trim();
            const apiKey = document.getElementById('k-key').value.trim();
            const apiSecret = document.getElementById('k-secret').value.trim();
            const msgBox = document.getElementById('api-form-msg');

            if (HAS_API) {
              msgBox.className = 'p-3 text-xs rounded-lg bg-[#590907]/40 text-[#E8D2B5]';
              msgBox.textContent = 'Đang xác thực quyền API với Binance Futures...';
              try {
                await apiRequest('/api/v1/api-keys', {
                  method: 'POST',
                  body: { label, environment: 'LIVE', api_key: apiKey, api_secret: apiSecret },
                });
                setNotice('success', 'Đã xác thực và lưu khóa API Binance USD-M Futures thành công.');
                await loadRouteData('api-keys');
              } catch (err) {
                msgBox.className = 'p-3 text-xs rounded-lg bg-[#D64545]/15 border border-[#D64545]/40 text-[#D64545]';
                msgBox.textContent = err.message;
              }
              return;
            }

            const masked = apiKey.length > 10 ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : '****';
            state.apiKeys.unshift({ label, env: 'LIVE', masked });
            localStorage.setItem('ex_api_keys', JSON.stringify(state.apiKeys));
            renderView();
          });
        }
      } else if (state.route === 'bots') {
        if (HAS_API && !state.token) {
          root.innerHTML = renderAuthRequiredCard(
            'Đăng nhập để cấu hình Quản trị rủi ro',
            'Thiết lập cặp giao dịch, vốn mỗi lệnh, đòn bẩy theo hạn mức sàn và ngưỡng SL/TP tự động.'
          );
        } else {
          const d = state.riskDraft;
          const isExMax = d.leverageMode === 'EXCHANGE_MAX';
          const selectableKeys = state.apiKeys.filter((k) => k.is_active !== false);
          root.innerHTML = `
            <div class="space-y-5">
              ${renderViewStateBanner()}
              ${renderNoticeBanner()}
              <div class="panel rounded-xl p-5 space-y-5">
                <div class="border-b border-[#A5A79B]/20 pb-4">
                  <h1 class="text-sm font-bold text-[#E8D2B5]">Thiết lập Quản trị rủi ro &amp; Vốn</h1>
                  <p class="text-xs text-[#A5A79B] mt-1">Thiết lập vốn, mức đòn bẩy theo hạn mức sàn và ngưỡng cắt lỗ. <span class="extreme-run">EXTREME</span> tự động ghép thuật toán tối ưu.</p>
                </div>

                ${HAS_API ? `
                <div>
                  <label class="block text-xs text-[#A5A79B] mb-1.5">Khóa API Binance áp dụng</label>
                  ${selectableKeys.length === 0 ? `
                    <div class="p-3 text-xs rounded-lg panel-inset text-[#A5A79B] flex items-center justify-between gap-2">
                      <span>Bạn chưa có khóa API Binance nào. Hãy kết nối khóa API trước khi tạo cấu hình.</span>
                      <button type="button" onclick="navigate('api-keys')" class="btn-champagne px-3 py-1.5 text-xs font-bold rounded-lg shrink-0">Kết nối API</button>
                    </div>
                  ` : `
                    <select onchange="setRiskField('apiKeyId', this.value, true)" class="w-full px-3.5 py-2.5 text-xs num panel-inset rounded-lg text-[#E8D2B5] focus:outline-none focus:border-[#E8D2B5]">
                      ${selectableKeys.map((k) => `
                        <option value="${escapeHtml(k.id)}" ${d.apiKeyId === k.id ? 'selected' : ''}>${escapeHtml(k.label)} (${escapeHtml(k.environment)} · ${escapeHtml(k.api_key_masked)})</option>
                      `).join('')}
                    </select>
                  `}
                </div>
                ` : ''}

                <div class="grid grid-cols-3 gap-2.5">
                  ${[
                    { id: 'BTCUSDT', name: 'Bitcoin' },
                    { id: 'ETHUSDT', name: 'Ethereum' },
                    { id: 'XAUUSDT', name: 'Vàng' },
                  ].map((c) => `
                    <button type="button" onclick="setRiskField('symbol','${c.id}')" class="p-2.5 sm:p-3.5 rounded-lg text-left border transition-colors min-w-0 ${d.symbol === c.id ? 'bg-[#590907] text-[#E8D2B5] border-[#E8D2B5]/50' : 'panel-inset text-[#A5A79B] hover:text-[#E8D2B5]'}">
                      <div class="text-[11px] sm:text-xs num font-bold truncate">${c.id}</div>
                      <div class="text-[10.5px] sm:text-[11px] opacity-80 mt-0.5 truncate">${c.name}</div>
                    </button>
                  `).join('')}
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  ${[
                    { id: 'SAFE', title: 'Rủi ro thấp', desc: 'Ưu tiên giữ vốn, lọc tín hiệu chặt' },
                    { id: 'BALANCED', title: 'Cân bằng', desc: 'Tối ưu lợi nhuận trên rủi ro' },
                    { id: 'GROWTH', title: 'Tăng trưởng', desc: 'Bám sát nhịp sóng mạnh 2 chiều' },
                  ].map((p) => `
                    <button type="button" onclick="setRiskField('riskProfile','${p.id}')" class="p-3.5 rounded-lg text-left border transition-colors ${d.riskProfile === p.id ? 'bg-[#251A19] border-[#E8D2B5] text-[#E8D2B5]' : 'panel-inset text-[#A5A79B] hover:text-[#E8D2B5]'}">
                      <div class="text-xs font-bold">${p.title}</div>
                      <div class="text-[11px] opacity-80 mt-0.5">${p.desc}</div>
                    </button>
                  `).join('')}
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div class="panel-inset rounded-lg p-4 space-y-4">
                    <div class="grid grid-cols-2 gap-2">
                      <button type="button" onclick="setRiskField('marginType','ISOLATED')" class="py-2 text-xs font-semibold rounded-lg border ${d.marginType === 'ISOLATED' ? 'bg-[#590907] text-[#E8D2B5] border-[#E8D2B5]/45' : 'border-[#A5A79B]/25 text-[#A5A79B]'}">Isolated (Cô lập)</button>
                      <button type="button" onclick="setRiskField('marginType','CROSSED')" class="py-2 text-xs font-semibold rounded-lg border ${d.marginType === 'CROSSED' ? 'bg-[#590907] text-[#E8D2B5] border-[#E8D2B5]/45' : 'border-[#A5A79B]/25 text-[#A5A79B]'}">Cross (Chéo)</button>
                    </div>

                    <div class="space-y-2.5">
                      <div class="text-xs text-[#A5A79B]">Đòn bẩy (nhập tự do theo hạn mức sàn)</div>
                      <div class="flex items-center gap-2">
                        <input id="lev-input" type="number" min="1" step="1" ${isExMax ? 'disabled' : ''} value="${d.leverage}" oninput="setCustomLeverage(this.value)" placeholder="Nhập mức đòn bẩy" class="flex-1 min-w-0 w-full px-3 py-2 text-sm num font-bold bg-[#181414] border border-[#A5A79B]/35 rounded-lg text-[#E8D2B5] disabled:opacity-40 focus:outline-none focus:border-[#E8D2B5]" />
                        <button type="button" onclick="toggleExchangeMax()" class="px-3.5 py-2 text-xs font-semibold rounded-lg border whitespace-nowrap ${isExMax ? 'bg-[#E8D2B5] text-[#590907] border-[#E8D2B5]' : 'btn-stone'}">
                          Tối đa sàn
                        </button>
                      </div>
                      <div class="flex flex-wrap gap-1.5">
                        ${[5, 10, 20, 50, 100].map((lv) => `
                          <button type="button" onclick="pickLeverage(${lv})" class="px-2.5 py-1 text-[11px] num rounded border ${!isExMax && Number(d.leverage) === lv ? 'bg-[#590907] text-[#E8D2B5] border-[#E8D2B5]/50' : 'border-[#A5A79B]/25 text-[#A5A79B] hover:text-[#E8D2B5]'}">${lv}x</button>
                        `).join('')}
                      </div>
                    </div>
                  </div>

                  <div class="panel-inset rounded-lg p-4 grid grid-cols-2 gap-3">
                    <div>
                      <label class="block text-[11px] text-[#A5A79B] mb-1">Vốn mỗi lệnh (USDT)</label>
                      <input type="number" min="1" step="5" value="${d.orderMargin}" oninput="setRiskField('orderMargin', Number(this.value)||0, true)" class="w-full px-3 py-2 text-xs num bg-[#181414] border border-[#A5A79B]/30 rounded-lg text-[#E8D2B5]" />
                    </div>
                    <div>
                      <label class="block text-[11px] text-[#A5A79B] mb-1">Số lệnh tối đa</label>
                      <input type="number" min="1" step="1" value="${d.maxOpen}" oninput="setRiskField('maxOpen', Number(this.value)||1, true)" class="w-full px-3 py-2 text-xs num bg-[#181414] border border-[#A5A79B]/30 rounded-lg text-[#E8D2B5]" />
                    </div>
                    <div>
                      <label class="block text-[11px] text-[#A5A79B] mb-1">Cắt lỗ SL (%)</label>
                      <input type="number" min="0.1" step="0.1" value="${d.slPct}" oninput="setRiskField('slPct', Number(this.value)||0, true)" class="w-full px-3 py-2 text-xs num bg-[#181414] border border-[#A5A79B]/30 rounded-lg text-[#D64545] font-semibold" />
                    </div>
                    <div>
                      <label class="block text-[11px] text-[#A5A79B] mb-1">Chốt lời TP (%)</label>
                      <input type="number" min="0.1" step="0.1" value="${d.tpPct}" oninput="setRiskField('tpPct', Number(this.value)||0, true)" class="w-full px-3 py-2 text-xs num bg-[#181414] border border-[#A5A79B]/30 rounded-lg text-[#34B37E] font-semibold" />
                    </div>
                    <label class="col-span-2 flex items-center gap-2 text-xs text-[#E8D2B5] pt-1 cursor-pointer">
                      <input type="checkbox" ${d.enableBreakeven ? 'checked' : ''} onchange="setRiskField('enableBreakeven', this.checked, true)" />
                      <span>Tự động dời Stop Loss về hòa vốn khi đạt 50% mục tiêu TP</span>
                    </label>
                  </div>
                </div>

                <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 panel-inset rounded-lg p-4 text-xs">
                  <div><div class="text-[#A5A79B]">Quy mô vị thế</div><div id="calc-notional" class="mt-1 font-bold num text-[#E8D2B5]"></div></div>
                  <div><div class="text-[#A5A79B]">Rủi ro tối đa (SL)</div><div id="calc-loss" class="mt-1 font-bold num text-[#D64545]"></div></div>
                  <div><div class="text-[#A5A79B]">Lợi nhuận mục tiêu (TP)</div><div id="calc-profit" class="mt-1 font-bold num text-[#34B37E]"></div></div>
                  <div><div class="text-[#A5A79B]">Phí HWM 20% ước tính</div><div id="calc-fee" class="mt-1 font-bold num text-[#E8D2B5]"></div></div>
                </div>

                <div class="flex justify-end">
                  <button type="button" onclick="saveRiskConfig()" class="btn-champagne w-full sm:w-auto px-5 py-2.5 text-xs font-bold rounded-lg">Lưu cấu hình rủi ro</button>
                </div>
              </div>

              <div class="panel rounded-xl overflow-hidden">
                <div class="px-5 py-3.5 border-b border-[#A5A79B]/20 text-xs font-bold uppercase tracking-wider text-[#E8D2B5]">Cấu hình đang quản lý</div>
                ${state.configs.length === 0 ? `
                  <div class="p-6 text-xs text-[#A5A79B]">Chưa có cấu hình nào được lưu.</div>
                ` : `
                  <div class="divide-y divide-[#A5A79B]/18">
                    ${state.configs.map((c, idx) => {
                      const mType = c.margin_type || c.marginType || 'ISOLATED';
                      const lMode = c.leverage_mode || c.leverageMode || 'EXCHANGE_MAX';
                      const marginAmt = c.order_margin_usdt ?? c.orderMargin;
                      const sl = c.sl_pct ?? c.slPct;
                      const tp = c.tp_pct ?? c.tpPct;
                      const profile = c.risk_profile || c.riskProfile || 'BALANCED';
                      const statusMap = {
                        RUNNING: { label: 'ĐANG CHẠY', cls: 'bg-[#34B37E]/15 text-[#34B37E]' },
                        STOP_NEW_ENTRIES: { label: 'KHÓA MỞ MỚI', cls: 'bg-[#590907] text-[#E8D2B5]' },
                        ERROR: { label: 'LỖI', cls: 'bg-[#D64545]/20 text-[#D64545]' },
                        STOPPED: { label: 'TẠM DỪNG', cls: 'bg-[#A5A79B]/20 text-[#A5A79B]' },
                      };
                      const st = statusMap[c.status] || statusMap.STOPPED;
                      const toggleArg = HAS_API ? `'${escapeHtml(c.id)}', '${escapeHtml(c.status)}'` : `${idx}, '${escapeHtml(c.status)}'`;
                      return `
                      <div class="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                        <div class="space-y-1">
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="text-sm num font-bold text-[#E8D2B5]">${escapeHtml(c.symbol)}</span>
                            <span class="text-[10px] font-semibold px-2 py-0.5 rounded ${st.cls}">${st.label}</span>
                            <span class="text-[10px] px-2 py-0.5 rounded panel-inset text-[#A5A79B]">${escapeHtml(profile)}</span>
                          </div>
                          <div class="text-xs num text-[#A5A79B]">${escapeHtml(mType)} · ${lMode === 'EXCHANGE_MAX' ? 'Tối đa sàn' : c.leverage + 'x'} · Vốn $${escapeHtml(fmtNum(marginAmt, 4))} · SL ${escapeHtml(fmtNum(sl, 4))}% · TP ${escapeHtml(fmtNum(tp, 4))}%</div>
                          ${c.last_error ? `<div class="text-[11px] text-[#D64545]">${escapeHtml(c.last_error)}</div>` : ''}
                        </div>
                        <button type="button" onclick="toggleConfigStatus(${toggleArg})" class="px-4 py-1.5 text-xs font-semibold rounded-lg shrink-0 ${c.status === 'RUNNING' ? 'border border-[#D64545]/45 text-[#D64545]' : 'btn-champagne'}">
                          ${c.status === 'RUNNING' ? 'Tạm dừng' : 'Kích hoạt'}
                        </button>
                      </div>
                    `;
                    }).join('')}
                  </div>
                `}
              </div>
            </div>
          `;
          updateRiskCalc();
        }
      } else if (state.route === 'trades') {
        if (HAS_API && !state.token) {
          root.innerHTML = renderAuthRequiredCard(
            'Đăng nhập để xem Lịch sử lệnh',
            'Toàn bộ giá vào, giá ra, phí sàn, lãi lỗ ròng khớp từ Binance và phí 20% HWM được lưu minh bạch tại đây.'
          );
        } else {
          root.innerHTML = `
            <div class="space-y-4">
              ${renderViewStateBanner()}
              <div class="panel rounded-xl overflow-hidden">
                <div class="px-4 sm:px-5 py-3.5 sm:py-4 border-b border-[#A5A79B]/20 flex flex-wrap items-center justify-between gap-2">
                  <h1 class="text-sm font-bold text-[#E8D2B5]">Lịch sử lệnh đã chốt</h1>
                  <select onchange="setTradeSymbolFilter(this.value)" class="px-3 py-1.5 text-xs num panel-inset rounded-lg text-[#E8D2B5]">
                    <option value="" ${state.tradeSymbolFilter === '' ? 'selected' : ''}>Tất cả cặp</option>
                    <option value="BTCUSDT" ${state.tradeSymbolFilter === 'BTCUSDT' ? 'selected' : ''}>BTCUSDT</option>
                    <option value="ETHUSDT" ${state.tradeSymbolFilter === 'ETHUSDT' ? 'selected' : ''}>ETHUSDT</option>
                    <option value="XAUUSDT" ${state.tradeSymbolFilter === 'XAUUSDT' ? 'selected' : ''}>XAUUSDT</option>
                    <option value="PAXGUSDT" ${state.tradeSymbolFilter === 'PAXGUSDT' ? 'selected' : ''}>PAXGUSDT</option>
                  </select>
                </div>
                ${state.trades.length === 0 ? `
                <div class="p-8 text-center text-xs text-[#A5A79B]">
                  Chưa có giao dịch nào được chốt. Toàn bộ giá vào, giá ra, lãi lỗ ròng và phí 20% HWM sẽ hiển thị minh bạch tại đây.
                </div>
                ` : `
                <div class="divide-y divide-[#A5A79B]/18">
                  ${state.trades.map((t) => {
                    const pnl = Number(t.realized_pnl || 0);
                    const hwmFee = Number(t.hwm_fee_charged || 0);
                    return `
                    <div class="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs">
                      <div class="space-y-1">
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="font-bold num text-[#E8D2B5]">${escapeHtml(t.symbol)}</span>
                          <span class="text-[10px] font-bold px-2 py-0.5 rounded ${t.side === 'LONG' ? 'bg-[#34B37E]/15 text-[#34B37E]' : 'bg-[#D64545]/15 text-[#D64545]'}">${escapeHtml(t.side)}</span>
                          <span class="text-[10px] text-[#A5A79B]">${escapeHtml(t.close_reason)} · ${escapeHtml(fmtDateTime(t.executed_at))}</span>
                        </div>
                        <div class="num text-[#A5A79B]">Vào: ${escapeHtml(fmtNum(t.entry_price))} → Ra: ${escapeHtml(fmtNum(t.exit_price))} · KL: ${escapeHtml(fmtNum(t.quantity))} · Phí sàn: ${fmtUsd(t.exchange_fee || 0, 4)}</div>
                      </div>
                      <div class="text-left sm:text-right num">
                        <div class="font-bold text-sm ${pnl >= 0 ? 'text-[#34B37E]' : 'text-[#D64545]'}">${pnl > 0 ? '+' : ''}${fmtUsd(pnl, 4)}</div>
                        <div class="text-[11px] text-[#A5A79B]">Phí HWM: ${fmtUsd(hwmFee, 4)}</div>
                      </div>
                    </div>
                  `;
                  }).join('')}
                </div>
                `}
              </div>
            </div>
          `;
        }
      } else if (state.route === 'wallet') {
        if (HAS_API && !state.token) {
          root.innerHTML = renderAuthRequiredCard(
            'Đăng nhập để mở Ví Credit & Gói thuê bao',
            'Nạp lần đầu tối thiểu $1.00 để tự động nhận thưởng $5.00 Credit, nâng cấp gói tháng và xem sao kê HWM.'
          );
        } else {
          const credit = state.user ? state.user.credit_balance : 0.0;
          const bonusClaimed = state.user ? Boolean(state.user.bonus_claimed) : false;
          const hasReferrer = Boolean(state.user?.has_referrer);
          const bonusUsd = hasReferrer ? 10 : 5;
          const hasPriorSub = state.creditTxs.some((tx) => tx.tx_type === 'SUBSCRIPTION_FEE' || tx.is_sub_fee);
          const firstSubDiscount = hasReferrer && !hasPriorSub;
          const stdLabel = firstSubDiscount ? '$26.10/tháng (-10%)' : '$29/tháng';
          const proLabel = firstSubDiscount ? '$71.10/tháng (-10%)' : '$79/tháng';
          const pd = state.pendingDeposit;
          root.innerHTML = `
            <div class="space-y-5">
              ${renderViewStateBanner()}
              ${renderNoticeBanner()}
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div class="panel rounded-xl p-4 sm:p-5 space-y-3.5">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <div class="text-xs text-[#A5A79B]">Ví Credit (Trừ phí 20% HWM)</div>
                    <span class="text-[10px] font-semibold px-2 py-0.5 rounded whitespace-nowrap shrink-0 ${bonusClaimed ? 'bg-[#34B37E]/15 text-[#34B37E]' : 'bg-[#590907] text-[#E8D2B5]'}">
                      ${bonusClaimed ? `Đã nhận $${bonusUsd} thưởng` : `Nạp tối thiểu $1 nhận $${bonusUsd}`}
                    </span>
                  </div>
                  <div class="text-2xl font-bold num text-[#E8D2B5]">${fmtUsd(credit)}</div>
                  <p class="text-xs text-[#A5A79B] leading-relaxed">
                    Nguyên tắc chống spam: tài khoản mới cần nạp lần đầu tối thiểu <strong class="text-[#E8D2B5]">$1.00</strong> để hệ thống tự động cộng thêm <strong class="text-[#34B37E]">$${bonusUsd}.00 khuyến mãi</strong>${hasReferrer ? ' (đã nhân đôi nhờ mã giới thiệu)' : ' (nhập mã giới thiệu lúc đăng ký được nhân đôi lên $10.00)'} — chỉ dùng trừ phí HWM, không rút tiền mặt.
                  </p>
                  <div class="flex flex-col sm:flex-row sm:items-end gap-2 pt-1">
                    <div class="flex-1 min-w-0">
                      <label class="block text-[11px] text-[#A5A79B] mb-1">Số tiền nạp (tối thiểu $1.00)</label>
                      <input id="dep-amt" type="number" min="1" step="1" value="1" class="w-full px-3 py-2 text-xs num panel-inset rounded-lg text-[#E8D2B5]" />
                    </div>
                    <div class="grid grid-cols-2 sm:flex gap-2 w-full sm:w-auto">
                      <button type="button" onclick="createDeposit('VietQR')" class="btn-champagne px-3.5 py-2 text-xs font-bold rounded-lg whitespace-nowrap">Nạp VietQR</button>
                      <button type="button" onclick="createDeposit('USDT BEP20')" class="btn-stone px-3.5 py-2 text-xs font-semibold rounded-lg whitespace-nowrap">USDT BEP20</button>
                    </div>
                  </div>
                </div>

                <div class="panel-wine rounded-xl p-4 sm:p-5 space-y-3">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <div class="text-xs text-[#E8D2B5]/75">Gói thuê bao tháng</div>
                    ${firstSubDiscount ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded bg-[#34B37E]/25 text-[#34B37E] whitespace-nowrap shrink-0">GIẢM 10% THÁNG ĐẦU</span>' : ''}
                  </div>
                  <div class="text-2xl font-bold text-[#E8D2B5]">${escapeHtml(planLabel(state.user?.plan, state.user?.role))}</div>
                  ${state.user?.plan_expires_at ? `<div class="text-[11px] num text-[#E8D2B5]/80">Hiệu lực đến: ${escapeHtml(fmtDateTime(state.user.plan_expires_at))}</div>` : ''}
                  <p class="text-xs text-[#E8D2B5]/80 leading-relaxed">${firstSubDiscount ? 'Ưu đãi mã giới thiệu: giảm ngay 10% cho tháng đầu tiên — Gói Tiêu chuẩn còn $26.10 (gốc $29), Gói Chuyên nghiệp còn $71.10 (gốc $79).' : 'Nâng cấp Gói Tiêu chuẩn ($29/tháng) hoặc Chuyên nghiệp ($79/tháng) bằng Ví Credit để mở toàn bộ 3 cặp giao dịch không giới hạn.'}</p>
                  <div class="flex flex-col sm:flex-row flex-wrap gap-2 pt-1">
                    <button type="button" onclick="subscribePlan('STANDARD')" class="btn-champagne w-full sm:w-auto px-4 py-2 text-xs font-bold rounded-lg">Chọn gói ${stdLabel}</button>
                    <button type="button" onclick="subscribePlan('PRO')" class="btn-stone w-full sm:w-auto px-4 py-2 text-xs font-semibold rounded-lg">Chọn gói ${proLabel}</button>
                  </div>
                </div>
              </div>

              ${pd ? `
              <div class="panel rounded-xl p-5 space-y-3">
                <div class="flex items-center justify-between gap-2 border-b border-[#A5A79B]/20 pb-2.5">
                  <div class="text-xs font-bold uppercase tracking-wider text-[#E8D2B5]">Đơn nạp đang chờ thanh toán (${escapeHtml(pd.method)})</div>
                  <button type="button" onclick="reloadCurrentRoute()" class="btn-stone px-3 py-1 text-[11px] rounded">Làm mới số dư</button>
                </div>
                ${pd.method === 'VietQR' ? `
                <div class="grid grid-cols-1 sm:grid-cols-12 gap-4 items-center text-xs">
                  <div class="sm:col-span-4 flex justify-center">
                    <img src="${escapeHtml(pd.qr_url)}" alt="VietQR" class="w-44 h-44 rounded-lg bg-white p-1.5 object-contain" />
                  </div>
                  <div class="sm:col-span-8 space-y-2">
                    <div>Số tiền chuyển khoản: <strong class="num text-[#34B37E] text-sm">${Math.round(Number(pd.amount_vnd || 0)).toLocaleString('vi-VN')} VNĐ</strong> (${fmtUsd(pd.credit_usd)})</div>
                    <div>Nội dung chuyển khoản (bắt buộc giữ nguyên): <code class="px-2 py-0.5 rounded bg-[#590907] text-[#E8D2B5] num font-bold">${escapeHtml(pd.order_code)}</code></div>
                    <div class="text-[#A5A79B]">Tài khoản nhận: <strong class="text-[#E8D2B5] num">${escapeHtml(pd.account_no)}</strong> · ${escapeHtml(pd.account_name)} (BIN ${escapeHtml(pd.bank_bin)})</div>
                    <div class="text-[11px] text-[#A5A79B]">Hệ thống tự động cộng Credit và thưởng $5.00 lần đầu ngay khi webhook SePay xác nhận giao dịch.</div>
                  </div>
                </div>
                ` : `
                <div class="space-y-1.5 text-xs">
                  <div>Mã đơn nạp USDT BEP20: <code class="px-2 py-0.5 rounded bg-[#590907] text-[#E8D2B5] num font-bold">${escapeHtml(pd.order_code)}</code></div>
                  <div>Số lượng: <strong class="num text-[#34B37E]">${escapeHtml(fmtNum(pd.pay_amount, 4))} ${escapeHtml(pd.pay_currency)}</strong></div>
                  <div class="text-[11px] text-[#A5A79B]">Trạng thái: ${escapeHtml(pd.status)}. Credit sẽ tự động cộng sau khi NOWPayments xác nhận giao dịch trên mạng BSC20.</div>
                </div>
                `}
              </div>
              ` : ''}

              <div class="panel rounded-xl overflow-hidden">
                <div class="px-5 py-3.5 border-b border-[#A5A79B]/20 text-xs font-bold uppercase tracking-wider text-[#E8D2B5]">Sao kê Credit &amp; Phí HWM</div>
                ${state.creditTxs.length === 0 ? `
                  <div class="p-6 text-xs text-[#A5A79B]">Chưa có giao dịch nạp Credit. Nạp tối thiểu $1.00 ở phía trên để nhận ngay $5.00 thưởng kích hoạt.</div>
                ` : `
                  <div class="divide-y divide-[#A5A79B]/18">
                    ${state.creditTxs.map((tx) => {
                      const amt = Number(tx.amount ?? 0);
                      const isPos = amt >= 0;
                      const title = tx.tx_type ? txTypeLabel(tx.tx_type) : (tx.title || 'Giao dịch Credit');
                      const timeStr = tx.created_at ? fmtDateTime(tx.created_at) : (tx.time || '');
                      return `
                      <div class="p-4 text-xs flex items-center justify-between gap-3">
                        <div>
                          <div class="font-semibold text-[#E8D2B5]">${escapeHtml(title)}</div>
                          ${tx.note ? `<div class="text-[11px] text-[#A5A79B] mt-0.5">${escapeHtml(tx.note)}</div>` : ''}
                          <div class="text-[11px] text-[#A5A79B] mt-0.5">${escapeHtml(timeStr)}${tx.balance_after !== undefined ? ' · Số dư sau GD: ' + fmtUsd(tx.balance_after) : ''}</div>
                        </div>
                        <div class="num font-bold ${isPos ? 'text-[#34B37E]' : 'text-[#D64545]'}">${isPos ? '+' : '-'}${fmtUsd(Math.abs(amt))}</div>
                      </div>
                    `;
                    }).join('')}
                  </div>
                `}
              </div>
            </div>
          `;
        }
      } else if (state.route === 'admin') {
        if (!isAdmin) {
          root.innerHTML = `
            <div class="max-w-md mx-auto mt-8 panel rounded-xl p-6 text-center space-y-3">
              <div class="text-sm font-bold text-[#E8D2B5]">Khu vực chỉ dành cho Quản trị viên</div>
              <p class="text-xs text-[#A5A79B]">Vui lòng đăng nhập bằng tài khoản Admin để quản lý người dùng, cộng trừ Credit, duyệt rút hoa hồng và bật chế độ Testnet.</p>
              <button type="button" onclick="navigate('login')" class="btn-champagne px-4 py-2 text-xs font-bold rounded-lg">Đăng nhập Admin</button>
            </div>
          `;
        } else {
          const es = state.adminEngineStatus;
          root.innerHTML = `
            <div class="space-y-5">
              ${renderViewStateBanner()}
              ${renderNoticeBanner()}
              <div class="panel-wine rounded-xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <div class="text-[10px] tracking-widest uppercase text-[#E8D2B5]/70">BẢNG ĐIỀU KHIỂN QUẢN TRỊ</div>
                  <a class="underline text-xs text-[#E8D2B5]" href="./testnet.html">Mở Binance Futures Testnet</a>
                  <h1 class="text-lg font-bold text-[#E8D2B5] mt-1">Xin chào Admin (${escapeHtml(state.user.email)})</h1>
                  <p class="text-xs text-[#E8D2B5]/80 mt-1">Đã mở khóa chế độ Testnet riêng, quyền cộng trừ Credit thủ công và đối soát duyệt rút hoa hồng đối tác.</p>
                </div>
                <div class="flex flex-wrap gap-2 shrink-0">
                  <a href="./testnet.html" class="btn-champagne px-4 py-2 text-xs font-bold rounded-lg">Mở trang Testnet</a>
                  ${HAS_API ? `<button type="button" onclick="reloadCurrentRoute()" class="btn-stone px-3.5 py-2 text-xs font-semibold rounded-lg">Làm mới</button>` : ''}
                </div>
              </div>

              ${es ? `
              <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 sm:gap-3">
                <div class="panel rounded-xl p-3.5 text-xs">
                  <div class="text-[#A5A79B]">WS Feed</div>
                  <div class="mt-1 font-bold ${es.ws_feed_connected ? 'text-[#34B37E]' : 'text-[#D64545]'}">${es.ws_feed_connected ? 'CONNECTED' : 'OFFLINE'}</div>
                </div>
                <div class="panel rounded-xl p-3.5 text-xs">
                  <div class="text-[#A5A79B]">Mã Vàng</div>
                  <div class="mt-1 font-bold num text-[#E8D2B5]">${escapeHtml(es.active_gold_symbol)}</div>
                </div>
                <div class="panel rounded-xl p-3.5 text-xs">
                  <div class="text-[#A5A79B]">Tổng tài khoản</div>
                  <div class="mt-1 font-bold num text-[#E8D2B5]">${es.total_users}</div>
                </div>
                <div class="panel rounded-xl p-3.5 text-xs">
                  <div class="text-[#A5A79B]">Bot RUNNING</div>
                  <div class="mt-1 font-bold num text-[#34B37E]">${es.running_bots}</div>
                </div>
                <div class="panel rounded-xl p-3.5 text-xs">
                  <div class="text-[#A5A79B]">STOP_NEW</div>
                  <div class="mt-1 font-bold num text-[#E8D2B5]">${es.stop_new_entries_bots}</div>
                </div>
                <div class="panel rounded-xl p-3.5 text-xs">
                  <div class="text-[#A5A79B]">Vị thế OPEN</div>
                  <div class="mt-1 font-bold num text-[#E8D2B5]">${es.open_positions}</div>
                </div>
              </div>
              ` : ''}

              ${HAS_API ? `
              <div class="panel rounded-xl overflow-hidden">
                <div class="px-5 py-3.5 border-b border-[#A5A79B]/20 text-xs font-bold uppercase tracking-wider text-[#E8D2B5]">Duyệt yêu cầu rút hoa hồng đối tác (24h)</div>
                ${state.adminWithdrawals.length === 0 ? `
                  <div class="p-6 text-xs text-[#A5A79B]">Chưa có yêu cầu rút hoa hồng nào từ người dùng.</div>
                ` : `
                  <div class="divide-y divide-[#A5A79B]/18">
                    ${state.adminWithdrawals.map((w) => {
                      const st = withdrawStatusMeta(w.status);
                      const target = w.method === 'BSC20'
                        ? `BSC20: ${w.bsc20_address || ''}`
                        : `${w.bank_name || ''} · ${w.bank_account_no || ''} · ${w.bank_account_holder || ''}`;
                      return `
                      <div class="p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 text-xs">
                        <div class="space-y-1">
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="font-bold text-[#E8D2B5]">${escapeHtml(w.user_email)}</span>
                            <span class="font-bold num text-[#34B37E]">${fmtUsd(w.amount_usd)}${w.amount_vnd ? ' (' + Math.round(Number(w.amount_vnd)).toLocaleString('vi-VN') + ' VNĐ)' : ''}</span>
                            <span class="text-[10px] px-2 py-0.5 rounded ${st.cls}">${escapeHtml(st.text)}</span>
                          </div>
                          <div class="text-[#A5A79B] break-all">${escapeHtml(target)} · ${escapeHtml(fmtDateTime(w.created_at))}</div>
                          ${w.admin_note ? `<div class="text-[11px] text-[#E8D2B5]/80">Ghi chú: ${escapeHtml(w.admin_note)}</div>` : ''}
                        </div>
                        ${w.status === 'PENDING' ? `
                        <div class="flex flex-wrap items-center gap-2 w-full lg:w-auto shrink-0">
                          <input id="wd-note-${escapeHtml(w.id)}" type="text" placeholder="Ghi chú duyệt / lý do từ chối" class="px-2.5 py-1.5 text-xs panel-inset rounded-lg text-[#E8D2B5] w-full sm:w-48" />
                          <button type="button" onclick="adminProcessWithdrawal('${escapeHtml(w.id)}', 'APPROVED')" class="btn-champagne px-3 py-1.5 text-xs font-bold rounded-lg">Duyệt</button>
                          <button type="button" onclick="adminProcessWithdrawal('${escapeHtml(w.id)}', 'REJECTED')" class="px-3 py-1.5 text-xs border border-[#D64545]/50 text-[#D64545] rounded-lg font-semibold">Từ chối &amp; Hoàn</button>
                        </div>
                        ` : ''}
                      </div>
                    `;
                    }).join('')}
                  </div>
                `}
              </div>
              ` : ''}

              <div class="panel rounded-xl overflow-hidden">
                <div class="px-5 py-3.5 border-b border-[#A5A79B]/20 text-xs font-bold uppercase tracking-wider text-[#E8D2B5]">Danh sách tài khoản &amp; Điều chỉnh Credit</div>
                <div class="divide-y divide-[#A5A79B]/18">
                  ${state.usersDb.map((u, idx) => {
                    const adjArg = HAS_API ? `'${escapeHtml(u.id)}', ${idx}` : `${idx}, ${idx}`;
                    return `
                    <div class="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs">
                      <div>
                        <div class="font-semibold text-[#E8D2B5]">${escapeHtml(u.email)} <span class="ml-1.5 text-[10px] px-2 py-0.5 rounded bg-[#590907] text-[#E8D2B5]">${escapeHtml(u.role)}</span></div>
                        <div class="text-[#A5A79B] num mt-0.5">Gói: ${escapeHtml(planLabel(u.plan, u.role))} · Credit: ${fmtUsd(u.credit_balance)} · Hoa hồng: ${fmtUsd(u.commission_balance || 0)} · ${u.bonus_claimed ? 'Đã nhận $5' : 'Chưa nạp $1'}</div>
                      </div>
                      <div class="flex items-center gap-2">
                        <input id="adj-${idx}" type="number" step="5" placeholder="+50" class="w-24 px-2.5 py-1.5 text-xs num panel-inset rounded-lg text-[#E8D2B5]" />
                        <button type="button" onclick="adminAdjustCredit(${adjArg})" class="btn-champagne px-3 py-1.5 text-xs font-bold rounded-lg">Cập nhật</button>
                      </div>
                    </div>
                  `;
                  }).join('')}
                </div>
              </div>
            </div>
          `;
        }
      } else if (state.route === 'login' || state.route === 'register') {
        const isReg = state.route === 'register';
        const savedRef = localStorage.getItem('ex_referred_by') || '';
        root.innerHTML = `
          <div class="max-w-md mx-auto mt-6 panel rounded-xl p-6 space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-[#A5A79B]/20 pb-3">
              <h1 class="text-base font-bold text-[#E8D2B5]">${isReg ? 'Tạo tài khoản EXTREME' : 'Đăng nhập EXTREME'}</h1>
              <span id="reg-perk-pill" class="text-[11px] font-semibold num text-[#34B37E] whitespace-nowrap shrink-0">${isReg ? (savedRef ? 'Nạp $1 tặng $10 + Giảm 10%' : 'Nạp $1 tặng đến $10') : ''}</span>
            </div>
            ${isReg ? `<div class="p-3 text-xs rounded-lg panel-inset text-[#A5A79B]">Tài khoản mới khởi tạo với $0.00 Credit. Nạp lần đầu tối thiểu <strong class="text-[#E8D2B5]">$1.00</strong> nhận ngay <strong class="text-[#34B37E]">$5.00</strong> — hoặc <strong class="text-[#34B37E]">$10.00 Credit + giảm 10% gói tháng đầu</strong> khi có mã giới thiệu.</div>` : ''}
            <div id="auth-msg" class="hidden p-3 text-xs rounded-lg"></div>
            <form id="auth-form" class="space-y-3.5">
              <div>
                <label class="block text-xs text-[#A5A79B] mb-1">Email</label>
                <input id="auth-email" type="email" required placeholder="ban@domain.com" class="w-full px-3.5 py-2.5 text-xs panel-inset rounded-lg text-[#E8D2B5] focus:outline-none focus:border-[#E8D2B5]" />
              </div>
              <div>
                <label class="block text-xs text-[#A5A79B] mb-1">Mật khẩu (tối thiểu 8 ký tự)</label>
                <input id="auth-pass" type="password" minlength="8" required class="w-full px-3.5 py-2.5 text-xs panel-inset rounded-lg text-[#E8D2B5] focus:outline-none focus:border-[#E8D2B5]" />
              </div>
              ${isReg ? `
              <div class="p-3 rounded-lg border border-[#34B37E]/30 bg-[#34B37E]/8 space-y-1.5">
                <div class="flex items-center justify-between gap-2">
                  <label class="text-xs font-semibold text-[#E8D2B5]">Mã giới thiệu đối tác</label>
                  <span id="ref-status-badge" class="text-[10px] font-bold px-2 py-0.5 rounded ${savedRef ? 'bg-[#34B37E]/25 text-[#34B37E]' : 'bg-[#590907] text-[#E8D2B5]'}">${savedRef ? 'Đã áp dụng ưu đãi x2' : '+$5 Credit · -10% gói đầu'}</span>
                </div>
                <input id="auth-ref" type="text" value="${escapeHtml(savedRef)}" placeholder="VD: EX-XXXXXX" oninput="updateRefPerkHint(this.value)" class="w-full px-3.5 py-2 text-xs num uppercase panel-inset rounded-lg text-[#E8D2B5] focus:outline-none focus:border-[#34B37E]" />
                <p class="text-[11px] text-[#A5A79B] leading-relaxed">
                  Nhập mã giới thiệu để <strong class="text-[#34B37E]">nhân đôi thưởng khởi đầu lên $10.00 Credit</strong> (khi nạp đầu từ $1) + <strong class="text-[#E8D2B5]">giảm 10% gói tháng đầu</strong> ($26.10 Standard / $71.10 Pro).
                </p>
              </div>
              ` : ''}
              <button type="submit" class="btn-champagne w-full py-2.5 text-xs font-bold rounded-lg">
                ${isReg ? 'Tạo tài khoản' : 'Đăng nhập'}
              </button>
            </form>
            <div class="text-xs text-center text-[#A5A79B]">
              <button type="button" onclick="navigate('${isReg ? 'login' : 'register'}')" class="font-semibold text-[#E8D2B5] hover:underline">
                ${isReg ? 'Đã có tài khoản? Đăng nhập' : 'Chưa có tài khoản? Đăng ký ngay'}
              </button>
            </div>
          </div>
        `;
        document.getElementById('auth-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const email = document.getElementById('auth-email').value.trim().toLowerCase();
          const password = document.getElementById('auth-pass').value;
          const refCode = document.getElementById('auth-ref')?.value.trim().toUpperCase() || '';
          const box = document.getElementById('auth-msg');

          if (HAS_API) {
            box.className = 'p-3 text-xs rounded-lg bg-[#590907]/40 text-[#E8D2B5]';
            box.textContent = 'Đang xác thực...';
            try {
              const payload = isReg && refCode
                ? { email, password, referral_code: refCode }
                : { email, password };
              const data = await apiRequest(isReg ? '/api/v1/auth/register' : '/api/v1/auth/login', {
                method: 'POST',
                body: payload,
                auth: false,
              });
              state.token = data.token;
              state.user = normalizeUser(data.user);
              localStorage.setItem('ex_token', data.token);
              localStorage.setItem('ex_user', JSON.stringify(state.user));
              syncNotificationsFromApi();
              navigate(state.user.role === 'ADMIN' ? 'admin' : 'dashboard');
            } catch (err) {
              box.className = 'p-3 text-xs rounded-lg bg-[#D64545]/15 border border-[#D64545]/40 text-[#D64545]';
              box.textContent = err.message;
            }
          } else {
            let existing = state.usersDb.find((u) => u.email === email);
            if (!existing) {
              existing = normalizeUser({
                email,
                role: 'USER',
                plan: 'INACTIVE',
                credit_balance: 0.0,
                bonus_claimed: false,
                has_referrer: Boolean(refCode),
                hwm: 0.0,
                ref_code: 'EX-' + Math.random().toString(36).slice(2, 7).toUpperCase(),
              });
              state.usersDb.push(existing);
              localStorage.setItem('ex_users_db', JSON.stringify(state.usersDb));
            }
            state.user = normalizeUser(existing);
            localStorage.setItem('ex_user', JSON.stringify(state.user));
            navigate('dashboard');
          }
        });
      }

      if (window.lucide) window.lucide.createIcons();
      updatePriceDom();
    }

    window.copyText = (text, msg) => {
      if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
      setNotice('success', msg || 'Đã sao chép vào bộ nhớ tạm.');
      renderView();
    };
    window.reloadCurrentRoute = () => {
      setNotice('', '');
      loadRouteData(state.route);
    };
    window.navigate = (r) => {
      state.route = r;
      state.viewError = '';
      setNotice('', '');
      renderView();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      loadRouteData(r);
    };
    window.logoutUser = () => {
      state.user = null;
      state.token = '';
      state.dashboardSummary = null;
      state.earnSummary = null;
      state.pendingDeposit = null;
      state.adminEngineStatus = null;
      state.adminWithdrawals = [];
      localStorage.removeItem('ex_user');
      localStorage.removeItem('ex_token');
      navigate('landing');
    };
    function pushNotification(title, body) {
      state.notifications.unshift({
        title,
        body,
        time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
        unread: true,
      });
      if (state.notifications.length > 20) state.notifications.pop();
      localStorage.setItem('ex_notifs', JSON.stringify(state.notifications));
      renderNotifList();
      renderHeaderAuth();
      if (window.lucide) window.lucide.createIcons();
    }
    function renderNotifList() {
      const list = document.getElementById('notif-list');
      if (!list) return;
      if (state.notifications.length === 0) {
        list.innerHTML = '<div class="p-4 text-xs text-[#A5A79B]">Chưa có thông báo nào.</div>';
        return;
      }
      list.innerHTML = state.notifications.map((n) => `
        <div class="p-3.5 text-xs ${n.unread ? 'bg-[#590907]/25' : ''}">
          <div class="flex items-center justify-between gap-2">
            <span class="font-semibold text-[#E8D2B5]">${escapeHtml(n.title)}</span>
            <span class="text-[10px] text-[#A5A79B] shrink-0">${escapeHtml(n.time)}</span>
          </div>
          <p class="text-[11px] text-[#A5A79B] mt-1 leading-relaxed">${escapeHtml(n.body)}</p>
        </div>
      `).join('');
    }
    window.toggleNotifPanel = () => {
      const p = document.getElementById('notif-panel');
      if (!p) return;
      p.classList.toggle('hidden');
      renderNotifList();
      if (!p.classList.contains('hidden') && HAS_API && state.token) {
        syncNotificationsFromApi();
      }
    };
    window.markAllRead = async () => {
      if (HAS_API && state.token) {
        try {
          await apiRequest('/api/v1/notifications/read-all', { method: 'POST' });
        } catch {}
      }
      state.notifications.forEach((n) => { n.unread = false; });
      if (!HAS_API) localStorage.setItem('ex_notifs', JSON.stringify(state.notifications));
      renderNotifList();
      renderHeaderAuth();
      if (window.lucide) window.lucide.createIcons();
    };
    window.setWithdrawMethod = (method) => {
      state.withdrawDraft.method = method;
      renderView();
    };
    window.updateWithdrawVnd = (val) => {
      let n = parseFloat(val);
      if (isNaN(n) || n < 0) n = 0;
      if (n > 5) {
        n = 5;
        const inp = document.getElementById('wd-amt');
        if (inp) inp.value = '5';
      }
      state.withdrawDraft.amount = n;
      const el = document.getElementById('wd-vnd-preview');
      if (el) el.textContent = Math.round(n * state.vndRate).toLocaleString('vi-VN') + ' VNĐ';
      const uEl = document.getElementById('wd-usdt-preview');
      if (uEl) uEl.textContent = fmtNum(n, 2) + ' USDT';
    };
    window.setEarnField = (key, val) => {
      state.earnCalc[key] = val;
      updateEarnCalc();
    };
    window.setTradeSymbolFilter = (sym) => {
      state.tradeSymbolFilter = sym;
      if (HAS_API && state.token) loadRouteData('trades');
      else renderView();
    };
    window.createDeposit = async (method) => {
      const amt = parseFloat(document.getElementById('dep-amt')?.value || '0');
      if (isNaN(amt) || amt < 1) {
        setNotice('error', 'Số tiền nạp tối thiểu là $1.00 USD.');
        renderView();
        return;
      }
      if (!state.user) {
        navigate('register');
        return;
      }

      if (HAS_API) {
        try {
          if (method === 'VietQR') {
            const res = await apiRequest('/api/v1/wallet/deposits/vietqr', {
              method: 'POST',
              body: { credit_usd_amount: amt.toFixed(2) },
            });
            state.pendingDeposit = {
              method: 'VietQR',
              qr_url: res.qr_url,
              order_code: res.order?.order_code || '',
              bank_bin: res.bank_bin,
              account_no: res.account_no,
              account_name: res.account_name,
              amount_vnd: res.amount_vnd,
              credit_usd: amt,
            };
            setNotice('success', 'Đã tạo mã VietQR nạp Credit. Quét mã và giữ nguyên nội dung chuyển khoản.');
          } else {
            const res = await apiRequest('/api/v1/wallet/deposits/crypto', {
              method: 'POST',
              body: { credit_usd_amount: amt.toFixed(2) },
            });
            state.pendingDeposit = {
              method: 'USDT BEP20',
              order_code: res.order_code,
              pay_amount: res.pay_amount,
              pay_currency: res.pay_currency,
              status: res.status,
            };
            setNotice('success', 'Đã tạo đơn nạp USDT BEP20. Chuyển đúng số lượng để hệ thống tự cộng Credit.');
          }
        } catch (err) {
          setNotice('error', err.message);
        }
        renderView();
        return;
      }

      const nowStr = new Date().toLocaleString('vi-VN');
      state.user.credit_balance = Number((state.user.credit_balance + amt).toFixed(2));
      state.creditTxs.unshift({ title: `Nạp Credit qua ${method}`, amount: amt, time: nowStr });

      if (!state.user.bonus_claimed && amt >= 1) {
        const bonusVal = state.user.has_referrer ? 10.0 : 5.0;
        state.user.bonus_claimed = true;
        state.user.plan = 'TRIAL';
        state.user.credit_balance = Number((state.user.credit_balance + bonusVal).toFixed(2));
        state.creditTxs.unshift({
          title: state.user.has_referrer
            ? 'Thưởng nạp đầu nhân đôi ($10 Credit qua mã giới thiệu)'
            : 'Khuyến mãi kích hoạt lần đầu (Nạp tối thiểu $1)',
          amount: bonusVal,
          time: nowStr,
        });
      }

      const idx = state.usersDb.findIndex((u) => u.email === state.user.email);
      if (idx >= 0) {
        state.usersDb[idx] = { ...state.user };
        localStorage.setItem('ex_users_db', JSON.stringify(state.usersDb));
      }
      localStorage.setItem('ex_user', JSON.stringify(state.user));
      localStorage.setItem('ex_credit_txs', JSON.stringify(state.creditTxs));
      pushNotification('Nạp Credit thành công', `Đã cộng ${fmtUsd(amt)} qua ${method}. Số dư hiện tại: ${fmtUsd(state.user.credit_balance)}.`);
      setNotice('success', `Đã cộng ${fmtUsd(amt)} qua ${method}.`);
      renderView();
    };
    window.subscribePlan = async (plan) => {
      if (!state.user) {
        navigate('login');
        return;
      }
      if (HAS_API) {
        try {
          const updated = await apiRequest('/api/v1/wallet/subscribe', {
            method: 'POST',
            body: { plan },
          });
          state.user = normalizeUser(updated);
          localStorage.setItem('ex_user', JSON.stringify(state.user));
          setNotice('success', `Đã nâng cấp ${planLabel(state.user.plan, state.user.role)} thành công (30 ngày).`);
          await syncNotificationsFromApi();
          await loadRouteData('wallet');
        } catch (err) {
          setNotice('error', err.message);
          renderView();
        }
        return;
      }
      const basePrice = plan === 'PRO' ? 79 : 29;
      const isFirstSub = !state.creditTxs.some((tx) => tx.tx_type === 'SUBSCRIPTION_FEE' || tx.is_sub_fee);
      const discounted = Boolean(state.user.has_referrer) && isFirstSub;
      const price = discounted ? Number((basePrice * 0.9).toFixed(2)) : basePrice;
      if (state.user.credit_balance < price) {
        setNotice('error', `Số dư Ví Credit không đủ (${fmtUsd(price)}). Vui lòng nạp thêm Credit trước.`);
        renderView();
        return;
      }
      state.user.credit_balance = Number((state.user.credit_balance - price).toFixed(2));
      state.user.plan = plan;
      state.creditTxs.unshift({
        title: `Đăng ký gói ${planLabel(plan, 'USER')}${discounted ? ' (-10% mã giới thiệu)' : ''}`,
        amount: -price,
        is_sub_fee: true,
        time: new Date().toLocaleString('vi-VN'),
      });
      localStorage.setItem('ex_user', JSON.stringify(state.user));
      localStorage.setItem('ex_credit_txs', JSON.stringify(state.creditTxs));
      setNotice('success', `Đã kích hoạt gói ${planLabel(plan, 'USER')}${discounted ? ' với ưu đãi giảm 10% tháng đầu' : ''}.`);
      renderView();
    };
    window.updateRefPerkHint = (val) => {
      const hasVal = Boolean((val || '').trim());
      const badge = document.getElementById('ref-status-badge');
      const pill = document.getElementById('reg-perk-pill');
      if (badge) {
        badge.textContent = hasVal ? 'Đã áp dụng ưu đãi x2' : '+$5 Credit · -10% gói đầu';
        badge.className = `text-[10px] font-bold px-2 py-0.5 rounded ${hasVal ? 'bg-[#34B37E]/25 text-[#34B37E]' : 'bg-[#590907] text-[#E8D2B5]'}`;
      }
      if (pill) {
        pill.textContent = hasVal ? 'Nạp $1 tặng $10 + Giảm 10%' : 'Nạp $1 tặng đến $10';
      }
    };
    window.setCustomLeverage = (val) => {
      const parsed = parseInt(val, 10);
      state.riskDraft.leverageMode = 'CUSTOM';
      state.riskDraft.leverage = parsed >= 1 ? parsed : 1;
      updateRiskCalc();
    };
    window.pickLeverage = (lv) => {
      state.riskDraft.leverageMode = 'CUSTOM';
      state.riskDraft.leverage = lv;
      renderView();
    };
    window.toggleExchangeMax = () => {
      state.riskDraft.leverageMode = state.riskDraft.leverageMode === 'EXCHANGE_MAX' ? 'CUSTOM' : 'EXCHANGE_MAX';
      renderView();
    };
    window.setRiskField = (key, val, calcOnly = false) => {
      state.riskDraft[key] = val;
      if (calcOnly) updateRiskCalc();
      else renderView();
    };
    window.saveRiskConfig = async () => {
      const d = state.riskDraft;
      if (HAS_API) {
        if (!d.apiKeyId) {
          setNotice('error', 'Vui lòng kết nối và chọn khóa API Binance trước khi lưu cấu hình.');
          renderView();
          return;
        }
        try {
          await apiRequest('/api/v1/bots', {
            method: 'POST',
            body: {
              api_key_id: d.apiKeyId,
              symbol: d.symbol,
              risk_profile: d.riskProfile,
              margin_type: d.marginType,
              leverage_mode: d.leverageMode,
              leverage: Math.max(1, Number(d.leverage) || 1),
              order_margin_usdt: String(d.orderMargin),
              max_open_positions: Math.max(1, Number(d.maxOpen) || 1),
              sl_pct: String(d.slPct),
              tp_pct: String(d.tpPct),
              enable_breakeven: Boolean(d.enableBreakeven),
            },
          });
          setNotice('success', `Đã lưu cấu hình ${d.symbol}. Bấm "Kích hoạt" để bắt đầu theo dõi tín hiệu.`);
          await loadRouteData('bots');
        } catch (err) {
          setNotice('error', err.message);
          renderView();
        }
        return;
      }

      state.configs.unshift({ ...state.riskDraft, status: 'RUNNING' });
      localStorage.setItem('ex_risk_configs', JSON.stringify(state.configs));
      renderView();
    };
    window.toggleConfigStatus = async (idOrIdx, currentStatus) => {
      if (HAS_API) {
        try {
          const action = currentStatus === 'RUNNING' ? 'stop' : 'start';
          await apiRequest(`/api/v1/bots/${idOrIdx}/${action}`, { method: 'POST' });
          setNotice('success', action === 'start' ? 'Đã kích hoạt cấu hình giao dịch.' : 'Đã tạm dừng mở lệnh mới (vị thế đang mở vẫn giữ SL/TP).');
          await loadRouteData('bots');
        } catch (err) {
          setNotice('error', err.message);
          renderView();
        }
        return;
      }
      const item = state.configs[idOrIdx];
      if (!item) return;
      item.status = item.status === 'RUNNING' ? 'STOPPED' : 'RUNNING';
      localStorage.setItem('ex_risk_configs', JSON.stringify(state.configs));
      renderView();
    };
    window.testApiKey = async (id) => {
      try {
        const res = await apiRequest(`/api/v1/api-keys/${id}/test`, { method: 'POST' });
        setNotice('success', `Kết nối thành công (${res.environment}). Số dư USDT khả dụng: ${fmtUsd(res.available_usdt_balance)}.`);
        await loadRouteData('api-keys');
      } catch (err) {
        setNotice('error', err.message);
        renderView();
      }
    };
    window.deleteApiKey = async (idOrIdx) => {
      if (HAS_API) {
        try {
          await apiRequest(`/api/v1/api-keys/${idOrIdx}`, { method: 'DELETE' });
          setNotice('success', 'Đã xóa khóa API khỏi hệ thống.');
          await loadRouteData('api-keys');
        } catch (err) {
          setNotice('error', err.message);
          renderView();
        }
        return;
      }
      state.apiKeys.splice(idOrIdx, 1);
      localStorage.setItem('ex_api_keys', JSON.stringify(state.apiKeys));
      renderView();
    };
    window.adminAdjustCredit = async (idOrIdx, inputIdx) => {
      const inp = document.getElementById(`adj-${inputIdx}`);
      const delta = parseFloat(inp?.value || '0');
      if (!delta) return;

      if (HAS_API) {
        try {
          await apiRequest(`/api/v1/admin/users/${idOrIdx}/credit-adjust`, {
            method: 'POST',
            body: { amount: delta.toFixed(2), note: 'Điều chỉnh từ bảng quản trị EXTREME' },
          });
          setNotice('success', `Đã điều chỉnh ${delta > 0 ? '+' : ''}${fmtUsd(delta)} Credit.`);
          await loadRouteData('admin');
        } catch (err) {
          setNotice('error', err.message);
          renderView();
        }
        return;
      }

      if (!state.usersDb[idOrIdx]) return;
      state.usersDb[idOrIdx].credit_balance = Number((state.usersDb[idOrIdx].credit_balance + delta).toFixed(2));
      localStorage.setItem('ex_users_db', JSON.stringify(state.usersDb));
      if (state.user && state.user.email === state.usersDb[idOrIdx].email) {
        state.user.credit_balance = state.usersDb[idOrIdx].credit_balance;
        localStorage.setItem('ex_user', JSON.stringify(state.user));
      }
      renderView();
    };
    window.adminProcessWithdrawal = async (withdrawId, status) => {
      const note = document.getElementById(`wd-note-${withdrawId}`)?.value.trim() || '';
      try {
        await apiRequest(`/api/v1/admin/withdrawals/${withdrawId}/process`, {
          method: 'POST',
          body: { status, admin_note: note || null },
        });
        setNotice(
          'success',
          status === 'APPROVED'
            ? 'Đã duyệt yêu cầu rút hoa hồng và gửi thông báo cho đối tác.'
            : 'Đã từ chối yêu cầu rút, hoàn lại số dư hoa hồng và gửi thông báo.'
        );
        await loadRouteData('admin');
      } catch (err) {
        setNotice('error', err.message);
        renderView();
      }
    };

    async function hydrateSessionOnBoot() {
      if (!HAS_API || !state.token) return;
      try {
        const me = await apiRequest('/api/v1/auth/me');
        state.user = normalizeUser(me);
        localStorage.setItem('ex_user', JSON.stringify(state.user));
        renderHeaderAuth();
        if (window.lucide) window.lucide.createIcons();
        syncNotificationsFromApi();
      } catch {
        renderHeaderAuth();
      }
    }

    fetchLiveUsdVndRate();
    startMarketStream();
    renderView();
    hydrateSessionOnBoot();
