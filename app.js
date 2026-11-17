(() => {
  const cfg = window.MINATO_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const authView = $("authView");
  const dashboardView = $("dashboardView");
  const toast = (message) => {
    $("toast").textContent = message;
    $("toast").classList.add("show");
    setTimeout(() => $("toast").classList.remove("show"), 2600);
  };
  const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
    !String(cfg.SUPABASE_URL).startsWith("ISI_") && !String(cfg.SUPABASE_ANON_KEY).startsWith("ISI_");
  let sb = null;
  let currentSession = null;
  let authMode = "login";
  let pollHandle = null;

  function showAuth() {
    authView.classList.remove("hidden");
    dashboardView.classList.add("hidden");
    if (pollHandle) clearInterval(pollHandle);
  }
  function showDashboard() {
    authView.classList.add("hidden");
    dashboardView.classList.remove("hidden");
    $("accountEmail").textContent = currentSession.user.email || "Akun MINATOHOST";
    loadSettings();
    refreshStatus();
    refreshLogs();
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = setInterval(refreshStatus, 3500);
  }
  function setAuthMode(mode) {
    authMode = mode;
    $("loginTab").classList.toggle("active", mode === "login");
    $("registerTab").classList.toggle("active", mode === "register");
    $("authTitle").textContent = mode === "login" ? "Selamat datang" : "Buat akun";
    $("authSubtitle").textContent = mode === "login" ? "Masuk ke akun MINATOHOST kamu." : "Daftar untuk membuat dashboard bot sendiri.";
    $("authSubmit").textContent = mode === "login" ? "Masuk" : "Buat akun";
    $("password").autocomplete = mode === "login" ? "current-password" : "new-password";
    $("authMessage").textContent = "";
  }
  async function api(path, body) {
    if (!cfg.BOT_API_URL || String(cfg.BOT_API_URL).startsWith("ISI_")) throw new Error("URL worker belum diatur.");
    const tokenResult = await sb.auth.getSession();
    const token = tokenResult.data.session && tokenResult.data.session.access_token;
    if (!token) throw new Error("Sesi login habis. Silakan masuk kembali.");
    const response = await fetch(String(cfg.BOT_API_URL).replace(/\/$/, "") + path, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Permintaan gagal (" + response.status + ").");
    return data;
  }
  async function handleAuth(event) {
    event.preventDefault();
    if (!configured) {
      $("authMessage").textContent = "Konfigurasi Supabase belum diisi di file config.js.";
      return;
    }
    const email = $("email").value.trim();
    const password = $("password").value;
    const submit = $("authSubmit");
    submit.disabled = true;
    submit.textContent = "Memproses...";
    $("authMessage").textContent = "";
    try {
      if (authMode === "register") {
        const result = await sb.auth.signUp({ email, password });
        if (result.error) throw result.error;
        $("authMessage").textContent = "Pendaftaran berhasil. Jika verifikasi email aktif, cek kotak masuk lalu masuk.";
      } else {
        const result = await sb.auth.signInWithPassword({ email, password });
        if (result.error) throw result.error;
        currentSession = result.data.session;
        showDashboard();
      }
    } catch (error) {
      $("authMessage").textContent = error.message || "Tidak dapat memproses akun.";
    } finally {
      submit.disabled = false;
      submit.textContent = authMode === "login" ? "Masuk" : "Buat akun";
    }
  }
  async function loadSettings() {
    try {
      const data = await api("/api/settings");
      const settings = data.settings || {};
      $("antiLink").checked = !!settings.anti_link;
      $("welcome").checked = !!settings.welcome;
      $("goodbye").checked = !!settings.goodbye;
    } catch (error) {
      $("settingsMessage").textContent = error.message;
    }
  }
  async function saveSettings() {
    $("saveSettingsBtn").disabled = true;
    try {
      await api("/api/settings", {
        anti_link: $("antiLink").checked,
        welcome: $("welcome").checked,
        goodbye: $("goodbye").checked
      });
      $("settingsMessage").textContent = "Pengaturan berhasil disimpan.";
      toast("Pengaturan tersimpan.");
    } catch (error) {
      $("settingsMessage").textContent = error.message;
    } finally {
      $("saveSettingsBtn").disabled = false;
    }
  }
  async function connect(mode) {
    const phone = $("phone").value.replace(/[^0-9]/g, "");
    if (mode === "pairing" && (phone.length < 10 || phone.length > 15)) {
      toast("Masukkan nomor dengan kode negara, contoh 62812xxxx.");
      return;
    }
    $("pairBox").classList.add("hidden");
    $("qrBox").classList.add("hidden");
    const button = mode === "pairing" ? $("pairBtn") : $("qrBtn");
    button.disabled = true;
    button.textContent = "Menghubungkan...";
    try {
      await api("/api/connect", { mode, phone: mode === "pairing" ? phone : "" });
      toast("Permintaan koneksi dikirim. Menunggu WhatsApp...");
      setTimeout(refreshStatus, 1200);
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = mode === "pairing" ? "Pairing Code" : "Gunakan QR";
    }
  }
  async function refreshStatus() {
    if (!currentSession) return;
    try {
      const data = await api("/api/status");
      const status = data.status || "disconnected";
      const state = $("connectionState");
      state.textContent = status === "connected" ? "TERHUBUNG" :
        status === "connecting" ? "MENGHUBUNGKAN" :
        status === "waiting_qr" ? "MENUNGGU QR" : "BELUM TERHUBUNG";
      state.classList.toggle("connected", status === "connected");
      $("disconnectBtn").classList.toggle("hidden", status === "disconnected");
      if (data.pairingCode) {
        $("pairCode").textContent = data.pairingCode;
        $("pairBox").classList.remove("hidden");
      } else if (status !== "connecting") {
        $("pairBox").classList.add("hidden");
      }
      if (data.qr) {
        $("qrImage").src = data.qr;
        $("qrBox").classList.remove("hidden");
      } else if (status === "connected" || status === "disconnected") {
        $("qrBox").classList.add("hidden");
      }
      if (data.phone) $("phone").value = data.phone;
    } catch (error) {
      $("connectionState").textContent = "API BELUM SIAP";
    }
  }
  async function disconnect() {
    if (!confirm("Putuskan sesi WhatsApp yang sedang terhubung?")) return;
    try {
      await api("/api/disconnect", {});
      $("pairBox").classList.add("hidden");
      $("qrBox").classList.add("hidden");
      toast("Sesi diputuskan.");
      refreshStatus();
    } catch (error) { toast(error.message); }
  }
  async function refreshLogs() {
    try {
      const data = await api("/api/logs");
      const list = $("logsList");
      const logs = data.logs || [];
      if (!logs.length) {
        list.innerHTML = '<p class="muted">Belum ada aktivitas.</p>';
        return;
      }
      list.innerHTML = logs.map((item) => {
        const row = document.createElement("div");
        row.className = "log-item";
        const message = document.createElement("span");
        message.textContent = item.message || "Aktivitas bot";
        const time = document.createElement("time");
        time.textContent = item.created_at ? new Date(item.created_at).toLocaleString("id-ID") : "";
        row.append(message, time);
        return row.outerHTML;
      }).join("");
    } catch (error) {
      $("logsList").innerHTML = '<p class="muted">Log belum tersedia.</p>';
    }
  }

  $("loginTab").addEventListener("click", () => setAuthMode("login"));
  $("registerTab").addEventListener("click", () => setAuthMode("register"));
  $("authForm").addEventListener("submit", handleAuth);
  $("pairBtn").addEventListener("click", () => connect("pairing"));
  $("qrBtn").addEventListener("click", () => connect("qr"));
  $("disconnectBtn").addEventListener("click", disconnect);
  $("saveSettingsBtn").addEventListener("click", saveSettings);
  $("refreshLogsBtn").addEventListener("click", refreshLogs);
  $("copyCodeBtn").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("pairCode").textContent); toast("Kode disalin."); }
    catch (_) { toast("Tidak dapat menyalin otomatis."); }
  });
  $("logoutBtn").addEventListener("click", async () => {
    await sb.auth.signOut();
    currentSession = null;
    showAuth();
  });

  if (!configured || !window.supabase) {
    $("authMessage").textContent = "Isi SUPABASE_URL dan SUPABASE_ANON_KEY di config.js terlebih dahulu.";
    return;
  }
  sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  sb.auth.getSession().then(({ data }) => {
    currentSession = data.session;
    if (currentSession) showDashboard();
  });
  sb.auth.onAuthStateChange((_event, session) => {
    currentSession = session;
    if (session) showDashboard();
    else showAuth();
  });
})();