import "dotenv/config";
import express from "express";
import cors from "cors";
import pino from "pino";
import QRCode from "qrcode";
import fs from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error("Missing environment variable: " + key);
    process.exit(1);
  }
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});
const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_DIR = process.env.SESSION_DIR || path.join(process.cwd(), "sessions");
const sessions = new Map();

app.use(cors({
  origin: process.env.CORS_ORIGIN || "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: "1mb" }));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jidBase = (jid = "") => String(jid).replace(/:\d+/, "");
const numberFromJid = (jid = "") => jidBase(jid).split("@")[0];

async function logActivity(userId, message, level = "info") {
  try {
    await supabase.from("bot_logs").insert({ user_id: userId, message, level });
  } catch (error) {
    console.error("Log error:", error.message);
  }
}
async function setSessionRecord(userId, status, phone = "") {
  const row = { user_id: userId, status, phone: phone || null, updated_at: new Date().toISOString() };
  const { error } = await supabase.from("bot_sessions").upsert(row, { onConflict: "user_id" });
  if (error) console.error("Session database error:", error.message);
}
async function getSettings(userId) {
  const { data, error } = await supabase.from("bot_settings")
    .select("anti_link,welcome,goodbye").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data || { anti_link: false, welcome: false, goodbye: false };
}
async function saveSettings(userId, settings) {
  const row = {
    user_id: userId,
    anti_link: !!settings.anti_link,
    welcome: !!settings.welcome,
    goodbye: !!settings.goodbye,
    updated_at: new Date().toISOString()
  };
  const { data, error } = await supabase.from("bot_settings")
    .upsert(row, { onConflict: "user_id" }).select("anti_link,welcome,goodbye").single();
  if (error) throw error;
  return data;
}

async function requireUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "Silakan masuk terlebih dahulu." });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: "Sesi login tidak valid." });
    req.user = data.user;
    next();
  } catch (error) {
    res.status(401).json({ error: "Tidak dapat memverifikasi akun." });
  }
}

function messageText(message) {
  const m = message.message || {};
  return m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    "";
}
async function groupInfo(sock, groupJid) {
  try { return await sock.groupMetadata(groupJid); }
  catch (_) { return null; }
}
function isAdmin(metadata, jid) {
  if (!metadata) return false;
  const target = jidBase(jid);
  const participant = metadata.participants?.find((p) => jidBase(p.id) === target);
  return !!participant?.admin;
}
async function sendReply(sock, jid, msg, text, extra = {}) {
  return sock.sendMessage(jid, { text, ...extra }, { quoted: msg });
}
function menuText(pushName) {
  const hour = new Date().getHours();
  const greeting = hour < 11 ? "Selamat Pagi" : hour < 15 ? "Selamat Siang" : hour < 18 ? "Selamat Sore" : "Selamat Malam";
  const date = new Date().toLocaleDateString("id-ID");
  return greeting + "\n\n" +
    "User: " + (pushName || "WhatsApp User") + "\n" +
    "Status: MINATOHOST\n" +
    "Date: " + date + "\n\n" +
    "MAIN\n" +
    "• .menu\n• .ping\n• .runtime\n• .owner\n• .status\n\n" +
    "GROUP ADMIN\n" +
    "• .antilink on/off\n• .welcome on/off\n• .goodbye on/off\n" +
    "• .tagall [pesan]\n• .hidetag [pesan]\n" +
    "• .kick @tag\n• .promote @tag\n• .demote @tag";
}
async function handleMessage(userId, sock, msg) {
  try {
    if (!msg.message || msg.key.remoteJid === "status@broadcast") return;
    const jid = msg.key.remoteJid;
    const text = messageText(msg).trim();
    if (!text) return;
    const group = jid.endsWith("@g.us");
    const sender = group ? (msg.key.participant || "") : jid;
    const metadata = group ? await groupInfo(sock, jid) : null;
    const senderAdmin = msg.key.fromMe || isAdmin(metadata, sender);
    const botAdmin = isAdmin(metadata, sock.user?.id || "");
    const settings = await getSettings(userId);

    if (group && settings.anti_link && !msg.key.fromMe && !senderAdmin &&
        /(https?:\/\/|www\.|chat\.whatsapp\.com\/)/i.test(text)) {
      if (botAdmin) {
        await sock.sendMessage(jid, { delete: msg.key });
        await logActivity(userId, "Anti-link menghapus pesan tautan di grup.");
      } else {
        await logActivity(userId, "Anti-link aktif, tetapi bot belum menjadi admin grup.", "warning");
      }
      return;
    }

    if (!text.startsWith(".")) return;
    const parts = text.slice(1).trim().split(/\s+/);
    const command = (parts.shift() || "").toLowerCase();
    const args = parts;
    const reply = (value, extra) => sendReply(sock, jid, msg, value, extra || {});

    if (command === "menu") return reply(menuText(msg.pushName));
    if (command === "owner") return reply("OWN MINATOHOST\nWhatsApp: 082180696427");
    if (command === "status") return reply("Status: MINATOHOST");
    if (command === "ping") return reply("Pong! MINATOHOST aktif.");
    if (command === "runtime") {
      const seconds = Math.floor(process.uptime());
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return reply("Runtime worker: " + hours + " jam " + minutes + " menit.");
    }

    const settingCommands = {
      antilink: "anti_link",
      welcome: "welcome",
      goodbye: "goodbye"
    };
    if (settingCommands[command]) {
      if (!group) return reply("Command ini hanya bisa digunakan di grup.");
      if (!senderAdmin) return reply("Khusus admin grup.");
      const value = (args[0] || "").toLowerCase();
      if (!["on", "off"].includes(value)) return reply("Gunakan ." + command + " on atau ." + command + " off.");
      const next = { ...settings, [settingCommands[command]]: value === "on" };
      await saveSettings(userId, next);
      await logActivity(userId, command + " " + value + " diaktifkan melalui grup.");
      return reply(command + " " + (value === "on" ? "aktif." : "nonaktif."));
    }

    if (["tagall", "hidetag", "kick", "promote", "demote"].includes(command)) {
      if (!group) return reply("Command ini hanya bisa digunakan di grup.");
      if (!senderAdmin) return reply("Khusus admin grup.");
      if (!metadata) return reply("Tidak bisa membaca data grup.");
      if (command === "tagall" || command === "hidetag") {
        const members = metadata.participants || [];
        if (members.length > 150) return reply("Jumlah anggota terlalu banyak untuk ditandai sekaligus.");
        const mentions = members.map((p) => p.id);
        const names = mentions.map((id) => "@" + numberFromJid(id));
        const caption = args.join(" ").trim();
        const body = command === "tagall"
          ? "TAG ALL\n" + (caption ? caption + "\n" : "") + names.join(" ")
          : (caption || "Info grup") + "\n";
        await sock.sendMessage(jid, { text: body, mentions }, { quoted: msg });
        await logActivity(userId, "." + command + " digunakan.");
        return;
      }
      if (!botAdmin) return reply("Jadikan bot admin grup terlebih dahulu.");
      const context = msg.message?.extendedTextMessage?.contextInfo || {};
      const targets = context.mentionedJid || (context.participant ? [context.participant] : []);
      if (!targets.length && args[0]) targets.push(args[0].replace(/\D/g, "") + "@s.whatsapp.net");
      if (!targets.length) return reply("Tag anggota yang ingin diproses.");
      const action = command === "kick" ? "remove" : command;
      await sock.groupParticipantsUpdate(jid, targets, action);
      await logActivity(userId, "Command ." + command + " dijalankan.");
      return reply("Berhasil menjalankan ." + command + ".");
    }
  } catch (error) {
    console.error("Message handler error:", error);
    await logActivity(userId, "Gagal memproses pesan bot: " + error.message, "error");
  }
}

async function createSocket(userId, phone = "", mode = "restore") {
  const existing = sessions.get(userId);
  if (existing && ["connecting", "waiting_qr", "connected"].includes(existing.status)) return existing;
  const directory = path.join(SESSION_DIR, userId);
  await fs.mkdir(directory, { recursive: true });
  const auth = await useMultiFileAuthState(directory);
  const sock = makeWASocket({
    auth: auth.state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["MINATOHOST", "Chrome", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false
  });
  const session = {
    userId, sock, phone, status: "connecting",
    qr: null, pairingCode: null, lastError: null, closing: false
  };
  sessions.set(userId, session);
  await setSessionRecord(userId, "connecting", phone);
  sock.ev.on("creds.update", auth.saveCreds);

  sock.ev.on("connection.update", async (update) => {
    try {
      if (update.qr) {
        session.qr = await QRCode.toDataURL(update.qr);
        session.status = "waiting_qr";
        await setSessionRecord(userId, "waiting_qr", phone);
      }
      if (update.connection === "open") {
        session.status = "connected";
        session.qr = null;
        session.pairingCode = null;
        const connectedPhone = numberFromJid(sock.user?.id || "") || phone;
        session.phone = connectedPhone;
        await setSessionRecord(userId, "connected", connectedPhone);
        await logActivity(userId, "WhatsApp berhasil terhubung.");
      }
      if (update.connection === "close") {
        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        session.status = "disconnected";
        session.qr = null;
        await setSessionRecord(userId, "disconnected", phone);
        await logActivity(userId, loggedOut ? "Sesi WhatsApp keluar. Hubungkan ulang." : "Koneksi WhatsApp terputus.", "warning");
        if (sessions.get(userId) === session) sessions.delete(userId);
        if (!session.closing && !loggedOut) {
          setTimeout(() => {
            if (!sessions.has(userId)) createSocket(userId, phone, "restore").catch((e) => console.error("Reconnect error:", e));
          }, 5000);
        }
      }
    } catch (error) {
      session.lastError = error.message;
      console.error("Connection update error:", error);
    }
  });
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages || []) await handleMessage(userId, sock, msg);
  });
  sock.ev.on("group-participants.update", async (event) => {
    try {
      const settings = await getSettings(userId);
      const joining = event.action === "add";
      const leaving = event.action === "remove" || event.action === "leave";
      if ((joining && settings.welcome) || (leaving && settings.goodbye)) {
        for (const participant of event.participants || []) {
          const name = "@" + numberFromJid(participant);
          const text = joining ? "Selamat datang " + name + "!" : name + " telah keluar dari grup.";
          await sock.sendMessage(event.id, { text, mentions: [participant] });
        }
      }
    } catch (error) {
      await logActivity(userId, "Gagal mengirim welcome/goodbye: " + error.message, "error");
    }
  });

  if (mode === "pairing" && phone && !auth.state.creds.registered) {
    await delay(1800);
    const code = await sock.requestPairingCode(phone);
    session.pairingCode = code;
    session.qr = null;
    session.status = "connecting";
  }
  return session;
}

app.get("/health", (_req, res) => res.json({ ok: true, name: "MINATOHOST BOT" }));

app.post("/api/connect", requireUser, async (req, res) => {
  try {
    const mode = req.body?.mode;
    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    if (!["pairing", "qr"].includes(mode)) return res.status(400).json({ error: "Metode koneksi tidak valid." });
    if (mode === "pairing" && (phone.length < 10 || phone.length > 15)) {
      return res.status(400).json({ error: "Nomor harus memakai kode negara, contoh 62812xxxx." });
    }
    const current = sessions.get(req.user.id);
    if (current && ["connecting", "waiting_qr", "connected"].includes(current.status)) {
      return res.status(409).json({ error: "Sesi sedang aktif. Putuskan sesi lama terlebih dahulu." });
    }
    const session = await createSocket(req.user.id, phone, mode);
    return res.json({ ok: true, status: session.status, pairingCode: session.pairingCode });
  } catch (error) {
    console.error("Connect error:", error);
    await logActivity(req.user.id, "Gagal memulai koneksi: " + error.message, "error");
    return res.status(500).json({ error: error.message || "Gagal memulai koneksi WhatsApp." });
  }
});

app.get("/api/status", requireUser, (req, res) => {
  const session = sessions.get(req.user.id);
  if (!session) return res.json({ status: "disconnected" });
  res.json({
    status: session.status,
    qr: session.qr,
    pairingCode: session.pairingCode,
    phone: session.phone,
    error: session.lastError
  });
});

app.post("/api/disconnect", requireUser, async (req, res) => {
  const session = sessions.get(req.user.id);
  if (session) {
    session.closing = true;
    try { await session.sock.logout(); } catch (_) { try { session.sock.end(undefined); } catch (_) {} }
    sessions.delete(req.user.id);
    await fs.rm(path.join(SESSION_DIR, req.user.id), { recursive: true, force: true });
  }
  await setSessionRecord(req.user.id, "disconnected", "");
  await logActivity(req.user.id, "Sesi WhatsApp diputuskan dari dashboard.");
  res.json({ ok: true });
});

app.get("/api/settings", requireUser, async (req, res) => {
  try { res.json({ settings: await getSettings(req.user.id) }); }
  catch (error) { res.status(500).json({ error: "Tidak dapat membaca pengaturan: " + error.message }); }
});
app.post("/api/settings", requireUser, async (req, res) => {
  try {
    const settings = await saveSettings(req.user.id, req.body || {});
    await logActivity(req.user.id, "Pengaturan bot diperbarui dari dashboard.");
    res.json({ ok: true, settings });
  } catch (error) { res.status(500).json({ error: "Tidak dapat menyimpan pengaturan: " + error.message }); }
});
app.get("/api/logs", requireUser, async (req, res) => {
  const { data, error } = await supabase.from("bot_logs").select("level,message,created_at")
    .eq("user_id", req.user.id).order("created_at", { ascending: false }).limit(30);
  if (error) return res.status(500).json({ error: "Tidak dapat memuat log." });
  res.json({ logs: data || [] });
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log("MINATOHOST worker listening on port " + PORT);
  try {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    const { data, error } = await supabase.from("bot_sessions")
      .select("user_id,phone,status").in("status", ["connected", "connecting", "waiting_qr"]);
    if (error) throw error;
    for (const row of data || []) {
      createSocket(row.user_id, row.phone || "", "restore")
        .catch((e) => logActivity(row.user_id, "Gagal memulihkan sesi: " + e.message, "error"));
    }
  } catch (error) {
    console.error("Session restore error:", error.message);
  }
});
