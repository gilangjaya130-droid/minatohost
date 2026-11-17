(() => {
  const cfg = window.MINATO_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const toast = (message) => {
    $("toast").textContent = message;
    $("toast").classList.add("show");
    setTimeout(() => $("toast").classList.remove("show"), 2800);
  };
  const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
    !String(cfg.SUPABASE_URL).startsWith("ISI_") &&
    !String(cfg.SUPABASE_ANON_KEY).startsWith("ISI_");
  let sb = null;
  let currentSession = null;
  let currentSettings = { bot_enabled: false, anti_link: false, welcome: false, goodbye: false };
  let pollHandle = null;
  let pairPageDismissed = false;

  async function api(path, body) {
    if (!cfg.BOT_API_URL || String(cfg.BOT_API_URL).startsWith("ISI_")) {
      throw new Error("Worker bot belum dipasang. URL worker belum diatur.");
    }
    const tokenResult = await sb.auth.getSession();
    const token = tokenResult.data.session && tokenResult.data.session.access_token;
    if (!token) throw new Error("Sesi tamu tidak ditemukan. Muat ulang halaman.");
    const response = await fetch(String(cfg.BOT_API_URL).replace(/\/$/, "") + path, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Permintaan gagal (" + response.status + ").");
    return data;
  }

  function showDashboard() {
    $("dashboardView").classList.remove("hidden");
    $("accountEmail").textContent = "Mode tamu • tanpa login dan daftar";
    loadSettings();
    refreshStatus();
    refreshLogs();
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = setInterval(() => { refreshStatus(); }, 3000);
  }

  async function loadSettings() {
    try {
      const data = await api("/api/settings");
      currentSettings = { ...currentSettings, ...(data.settings || {}) };
      renderBotState();
    } catch (error) {
      $("botMessage").textContent = error.message;
    }
  }

  function renderBotState() {
    const active = !!currentSettings.bot_enabled;
    $("botState").textContent = active ? "BOT AKTIF" : "BOT NONAKTIF";
    $("botState").classList.toggle("connected", active);
    $("startBtn").disabled = active || $("connectionState").textContent !== "TERHUBUNG";
    $("stopBtn").disabled = !active;
  }

  async function setBotActive(active) {
    const button = active ? $("startBtn") : $("stopBtn");
    button.disabled = true;
    button.textContent = active ? "STARTING..." : "STOPPING...";
    $("botMessage").textContent = "";
    try {
      const next = { ...currentSettings, bot_enabled: active };
      const data = await api("/api/settings", next);
      currentSettings = { ...currentSettings, ...(data.settings || next) };
      renderBotState();
      $("botMessage").textContent = active ? "Bot berhasil diaktifkan." : "Bot dihentikan. Koneksi WhatsApp tetap tertaut.";
      toast(active ? "MINATOHOST BOT aktif." : "MINATOHOST BOT dihentikan.");
    } catch (error) {
      $("botMessage").textContent = error.message;
      toast(error.message);
    } finally {
      button.textContent = active ? "START" : "STOP";
      renderBotState();
    }
  }

  async function connectQR() {
    const phone = $("phone").value.replace(/[^0-9]/g, "");
    if (phone && (phone.length < 10 || phone.length > 15)) {
      toast("Periksa nomor WhatsApp. Gunakan kode negara, contoh 62812xxxx.");
      return;
    }
    $("qrBox").classList.add("hidden");
    $("pairPage").classList.add("hidden");
    $("qrBtn").disabled = true;
    $("qrBtn").textContent = "MEMBUAT QR...";
    try {
      await api("/api/connect", { mode: "qr", phone });
      toast("Permintaan QR dikirim. Tunggu QR muncul.");
      setTimeout(refreshStatus, 900);
    } catch (error) {
      toast(error.message);
    } finally {
      $("qrBtn").disabled = false;
      $("qrBtn").textContent = "GUNAKAN QR";
    }
  }

  async function connectPairing() {
    pairPageDismissed = false;
    const phone = $("phone").value.replace(/[^0-9]/g, "");
    if (phone.length < 10 || phone.length > 15) {
      toast("Masukkan nomor dengan kode negara, contoh 62812xxxx.");
      return;
    }
    $("pairPage").classList.add("hidden");
    $("qrBox").classList.add("hidden");
    $("pairBtn").disabled = true;
    $("pairBtn").textContent = "MEMINTA KODE...";
    try {
      await api("/api/connect", { mode: "pairing", phone });
      toast("Permintaan pairing dikirim. Tunggu kode muncul.");
      setTimeout(refreshStatus, 1200);
    } catch (error) {
      toast(error.message);
    } finally {
      $("pairBtn").disabled = false;
      $("pairBtn").textContent = "PAIRING CODE";
    }
  }

  async function refreshStatus() {
    if (!currentSession) return;
    try {
      const data = await api("/api/status");
      const status = data.status || "disconnected";
      $("connectionState").textContent =
        status === "connected" ? "TERHUBUNG" :
        status === "connecting" ? "MENGHUBUNGKAN" :
        status === "waiting_qr" ? "MENUNGGU QR" : "BELUM TERHUBUNG";
      $("connectionState").classList.toggle("connected", status === "connected");
      $("disconnectBtn").classList.toggle("hidden", status === "disconnected");
      $("qrBtn").disabled = ["connected", "connecting", "waiting_qr"].includes(status);
      if (data.pairingCode) {
        $("pairCode").textContent = data.pairingCode;
        if (!pairPageDismissed) $("pairPage").classList.remove("hidden");
      } else if (status === "connected" || status === "disconnected") {
        $("pairPage").classList.add("hidden");
      }
      if (data.qr) {
        $("qrImage").src = data.qr;
        $("qrBox").classList.remove("hidden");
      } else if (status === "connected" || status === "disconnected") {
        $("qrBox").classList.add("hidden");
      }
      if (data.phone) $("phone").value = data.phone;
      renderBotState();
    } catch (error) {
      $("connectionState").textContent = "API BELUM SIAP";
      $("botMessage").textContent = error.message;
      renderBotState();
    }
  }

  async function disconnect() {
    if (!confirm("Putuskan tautan WhatsApp dari MINATOHOST?")) return;
    try {
      await api("/api/disconnect", {});
      currentSettings.bot_enabled = false;
      $("qrBox").classList.add("hidden");
      $("botMessage").textContent = "WhatsApp sudah diputuskan.";
      toast("Sesi WhatsApp diputuskan.");
      await refreshStatus();
    } catch (error) {
      toast(error.message);
    }
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
    } catch (_) {
      $("logsList").innerHTML = '<p class="muted">Log belum tersedia.</p>';
    }
  }

  $("pairBtn").addEventListener("click", connectPairing);
  $("qrBtn").addEventListener("click", connectQR);
  $("copyCodeBtn").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("pairCode").textContent); $("copyCodeBtn").textContent = "TERSALIN"; toast("Kode berhasil disalin."); }
    catch (_) { toast("Gagal menyalin kode."); }
  });
  $("backPairBtn").addEventListener("click", () => { pairPageDismissed = true; $("pairPage").classList.add("hidden"); });
  $("disconnectBtn").addEventListener("click", disconnect);
  $("startBtn").addEventListener("click", () => setBotActive(true));
  $("stopBtn").addEventListener("click", () => setBotActive(false));
  $("refreshLogsBtn").addEventListener("click", refreshLogs);

  if (!configured || !window.supabase) {
    toast("Konfigurasi dashboard belum lengkap. Bot belum dapat dihubungkan.");
    $("botMessage").textContent = "Pengelola perlu melengkapi konfigurasi koneksi dan URL worker.";
    return;
  }
  sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  (async () => {
    try {
      const existing = await sb.auth.getSession();
      currentSession = existing.data.session;
      if (!currentSession) {
        const guest = await sb.auth.signInAnonymously();
        if (guest.error) throw guest.error;
        currentSession = guest.data.session;
      }
      if (!currentSession) throw new Error("Sesi tamu tidak berhasil dibuat.");
      showDashboard();
    } catch (error) {
      toast("Mode tamu gagal dibuat: " + (error.message || "Periksa konfigurasi dashboard."));
      $("botMessage").textContent = "Aktifkan akses pengguna tamu pada layanan autentikasi.";
    }
  })();
  sb.auth.onAuthStateChange((_event, session) => {
    if (session) {
      currentSession = session;
      showDashboard();
    }
  });
})();
