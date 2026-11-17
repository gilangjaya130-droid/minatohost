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
    await supabase.from("bot_logs").insert({ user_id: userId, event: "bot_activity", message, level });
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
    .select("bot_enabled,anti_link,welcome,goodbye").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data || { bot_enabled: false, anti_link: false, welcome: false, goodbye: false };
}
async function saveSettings(userId, settings) {
  const row = {
    user_id: userId,
    bot_enabled: !!settings.bot_enabled,
    anti_link: !!settings.anti_link,
    welcome: !!settings.welcome,
    goodbye: !!settings.goodbye,
    updated_at: new Date().toISOString()
  };
  const { data, error } = await supabase.from("bot_settings")
    .upsert(row, { onConflict: "user_id" }).select("bot_enabled,anti_link,welcome,goodbye").single();
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
  const sections = [
    ["MAIN", [".menu", ".help", ".ping", ".runtime", ".owner", ".status", ".botinfo", ".profile"]],
    ["GROUP", [".groupinfo", ".membercount", ".listadmin", ".groupname", ".groupdesc", ".grouplink", ".tagall", ".hidetag"]],
    ["ADMIN", [".antilink on/off", ".welcome on/off", ".goodbye on/off", ".kick @tag", ".add nomor", ".promote @tag", ".demote @tag", ".setname teks", ".setdesc teks", ".open", ".close", ".mute", ".unmute", ".revoke", ".resetlink", ".admins", ".delete", ".announce"]],
    ["TOOLS", [".sum", ".average", ".min", ".max", ".square", ".sqrt", ".time", ".date", ".day", ".month", ".year", ".count", ".reverse", ".upper", ".lower", ".title", ".trim", ".length", ".charcount", ".wordcount", ".base64", ".unbase64", ".urlencode", ".urldecode", ".binary", ".hex", ".morse", ".rot13", ".random", ".randombetween", ".choose", ".dice", ".coin", ".percentage"]],
    ["TEXT MAKER", [".quote", ".motivasi", ".pantun", ".fakta", ".jokes", ".say", ".tebal", ".miring", ".garis", ".bubble", ".small", ".emoji", ".clap", ".quote2", ".mock", ".uwu", ".poem", ".bio", ".nickname", ".slogan", ".caption", ".statuswa", ".loveletter", ".thankyou", ".sorry"]],
    ["FUN", [".truth", ".dare", ".ship", ".rate", ".howgay", ".howcute", ".howsmart", ".pickupline", ".roast", ".compliment", ".riddle", ".quiz", ".answer", ".suit", ".tebakangka", ".flip", ".dice2", ".8ball", ".coinflip", ".randomnumber"]],
    ["INFORMASI", [".creator", ".version", ".server", ".runtime", ".uptime", ".support", ".rules", ".donasi", ".contact", ".source"]]
  ];
  return greeting + "\n\nUser: " + (pushName || "WhatsApp User") + "\nStatus: MINATOHOST\nDate: " + date +
    "\nTotal command: 100+\n\n" + sections.map(([name, commands]) => "【 " + name + " 】\n" + commands.join("\n")).join("\n\n") +
    "\n\nMINATOHOST BOT • Gunakan command dengan awalan titik.";
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
    const senderAdmin = isAdmin(metadata, sender);
    const botAdmin = isAdmin(metadata, sock.user?.id || "");
    const settings = await getSettings(userId);
    if (!settings.bot_enabled) return;

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
    const input = args.join(" ");
    const pick = (items) => items[Math.floor(Math.random() * items.length)];
    const utilityReplies = {
      help: () => menuText(msg.pushName),
      botinfo: () => "MINATOHOST BOT\\nMulti-device WhatsApp bot\\nStatus: " + (sock.user ? "connected" : "connecting"),
      profile: () => "Nama: " + (msg.pushName || "WhatsApp User") + "\\nNomor: " + numberFromJid(sender),
      info: () => "MINATOHOST BOT — Asisten WhatsApp dengan fitur grup, teks, dan utilitas.",
      creator: () => "Creator: OWN MINATOHOST\\nWhatsApp: 082180696427",
      version: () => "MINATOHOST BOT v2.0",
      server: () => "Worker: aktif\\nNode.js: " + process.version,
      uptime: () => "Uptime: " + Math.floor(process.uptime()) + " detik",
      support: () => "Hubungi OWN MINATOHOST: 082180696427",
      rules: () => "Gunakan bot dengan bijak. Dilarang spam, penipuan, dan mengganggu grup.",
      donasi: () => "Dukungan MINATOHOST: hubungi OWN MINATOHOST.",
      contact: () => "OWN MINATOHOST — 082180696427",
      source: () => "MINATOHOST BOT",
      time: () => "Waktu server: " + new Date().toLocaleTimeString("id-ID"),
      date: () => "Tanggal: " + new Date().toLocaleDateString("id-ID"),
      day: () => "Hari: " + new Date().toLocaleDateString("id-ID", { weekday: "long" }),
      month: () => "Bulan: " + new Date().toLocaleDateString("id-ID", { month: "long" }),
      year: () => "Tahun: " + new Date().getFullYear(),
      count: () => input ? "Jumlah karakter: " + input.length + "\\nJumlah kata: " + input.trim().split(/\\s+/).filter(Boolean).length : "Contoh: .count MINATOHOST BOT",
      length: () => "Panjang teks: " + input.length + " karakter",
      charcount: () => "Jumlah karakter: " + input.length,
      wordcount: () => "Jumlah kata: " + input.trim().split(/\\s+/).filter(Boolean).length,
      reverse: () => input ? Array.from(input).reverse().join("") : "Masukkan teks. Contoh: .reverse halo",
      upper: () => input ? input.toUpperCase() : "Masukkan teks.",
      lower: () => input ? input.toLowerCase() : "Masukkan teks.",
      title: () => input ? input.toLowerCase().replace(/\\b\\w/g, c => c.toUpperCase()) : "Masukkan teks.",
      trim: () => input.trim() || "Masukkan teks.",
      base64: () => input ? Buffer.from(input, "utf8").toString("base64") : "Masukkan teks.",
      unbase64: () => { try { return Buffer.from(input, "base64").toString("utf8") || "Teks kosong."; } catch (_) { return "Base64 tidak valid."; } },
      urlencode: () => encodeURIComponent(input),
      urldecode: () => { try { return decodeURIComponent(input); } catch (_) { return "Format URL tidak valid."; } },
      binary: () => input ? Array.from(Buffer.from(input)).map(n => n.toString(2).padStart(8, "0")).join(" ") : "Masukkan teks.",
      hex: () => input ? Buffer.from(input).toString("hex") : "Masukkan teks.",
      morse: () => { const m={a:".-",b:"-...",c:"-.-.",d:"-..",e:".",f:"..-.",g:"--.",h:"....",i:"..",j:".---",k:"-.-",l:".-..",m:"--",n:"-.",o:"---",p:".--.",q:"--.-",r:".-.",s:"...",t:"-",u:"..-",v:"...-",w:".--",x:"-..-",y:"-.--",z:"--.."," ":"/"}; return input.toLowerCase().split("").map(c=>m[c]||c).join(" "); },
      rot13: () => input.replace(/[a-z]/gi,c=>String.fromCharCode(c.charCodeAt(0)+(c.toLowerCase()<="m"?13:-13))),
      random: () => "Angka acak: " + (Math.floor(Math.random()*100)+1),
      randombetween: () => { const n=args.map(Number); if(n.length<2||!n.every(Number.isFinite)||n[0]>n[1]) return "Contoh: .randombetween 1 100"; return "Hasil: " + (Math.floor(Math.random()*(n[1]-n[0]+1))+n[0]); },
      choose: () => { const choices=input.split("|").map(x=>x.trim()).filter(Boolean); return choices.length>1 ? "Pilihan: "+pick(choices) : "Pisahkan pilihan dengan tanda |. Contoh: .choose merah|biru"; },
      dice: () => "Dadu: " + (Math.floor(Math.random()*6)+1),
      dice2: () => "Dua dadu: " + (Math.floor(Math.random()*6)+1) + " dan " + (Math.floor(Math.random()*6)+1),
      coin: () => "Koin: " + pick(["ANGKA","GAMBAR"]),
      coinflip: () => "Hasil lempar koin: " + pick(["ANGKA","GAMBAR"]),
      flip: () => "Balik teks: " + Array.from(input).reverse().join(""),
      randomnumber: () => "Angka acak: " + (Math.floor(Math.random()*1000)+1),
      percentage: () => { const n=args.map(Number); return n.length>=2&&n.every(Number.isFinite) ? n[0]+"% dari "+n[1]+" = "+(n[0]*n[1]/100) : "Contoh: .percentage 20 500"; },
      quote: () => pick(["Tetap melangkah walau pelan.","Proses kecil tetap membawa kemajuan.","Konsisten lebih penting daripada terburu-buru."]),
      motivasi: () => pick(["Jangan menyerah hanya karena hari ini sulit.","Mulai dari yang bisa kamu lakukan sekarang.","Belajar dari kesalahan, lalu coba lagi."]),
      pantun: () => pick(["Jalan pagi melihat mentari\\nUdara segar menyejukkan hati\\nTerus berusaha setiap hari\\nSemoga sukses menghampiri","Beli buku di hari Senin\\nBuku dibaca bersama teman\\nTetap semangat meraih ingin\\nJangan lupa jaga kesehatan"]),
      fakta: () => pick(["Lebah berkomunikasi melalui gerakan tarian.","Gurita memiliki tiga jantung.","Satu hari di Venus lebih lama daripada satu tahunnya."]),
      jokes: () => pick(["Kenapa komputer suka dingin? Karena banyak Windows.","Apa yang selalu naik tapi tak pernah turun? Umur.","Kenapa buku matematika sedih? Karena banyak masalah."]),
      say: () => input || "Contoh: .say Halo semuanya!",
      tebal: () => input ? "*"+input+"*" : "Masukkan teks.",
      miring: () => input ? "_"+input+"_" : "Masukkan teks.",
      garis: () => input ? "̶"+Array.from(input).join("̶")+"̶" : "Masukkan teks.",
      bubble: () => input ? "ⓑⓤⓑⓑⓛⓔ: "+input : "Masukkan teks.",
      small: () => input ? input.toLowerCase().replace(/[a-z]/g,c=>"abcdefghijklmnopqrstuvwxyz".includes(c)?String.fromCharCode(0x1D00+"abcdefghijklmnopqrstuvwxyz".indexOf(c)):c) : "Masukkan teks.",
      clap: () => input ? input.split(" ").join(" 👏 ") : "Masukkan teks.",
      mock: () => input ? Array.from(input).map((c,i)=>i%2?c.toLowerCase():c.toUpperCase()).join("") : "Masukkan teks.",
      uwu: () => input ? input.replace(/r|l/g,"w").replace(/R|L/g,"W") : "Masukkan teks.",
      poem: () => "Langit luas membentang biru,\\nLangkah kecil menuju tujuan,\\nTerus belajar menambah ilmu,\\nJangan lelah mengejar impian.",
      bio: () => input ? "Bio: "+input : "Contoh: .bio Pecinta teknologi | Terus berkarya",
      nickname: () => input ? "Ide nickname: "+input.replace(/[^a-z0-9]/gi,"")+"ツ" : "Contoh: .nickname Minato",
      slogan: () => input ? input.toUpperCase()+" — MAKE IT REAL" : "Contoh: .slogan MINATOHOST",
      caption: () => input ? input+" ✨" : "Contoh: .caption Hari yang menyenangkan",
      statuswa: () => input ? "「 "+input+" 」" : "Masukkan teks.",
      loveletter: () => "Hai! Terima kasih sudah menjadi bagian dari hari-hariku. Semoga hal baik selalu menyertaimu.",
      thankyou: () => "Terima kasih banyak! Apresiasi kamu sangat berarti.",
      sorry: () => "Maaf atas kesalahan yang terjadi. Aku akan berusaha memperbaikinya.",
      truth: () => pick(["Apa hal paling berani yang pernah kamu lakukan?","Apa impian yang ingin kamu capai?","Apa pelajaran terbaik tahun ini?"]),
      dare: () => pick(["Ceritakan pengalaman paling lucu.","Kirim emoji yang menggambarkan harimu.","Sebutkan satu hal yang kamu syukuri."]),
      ship: () => { const names=input.split("|").map(x=>x.trim()).filter(Boolean); return names.length===2 ? names[0]+" ❤️ "+names[1]+" — cocok "+(Math.floor(Math.random()*101))+"%" : "Contoh: .ship nama1|nama2"; },
      rate: () => input ? input+" mendapat nilai "+(Math.floor(Math.random()*101))+"/100 (sekadar hiburan)." : "Contoh: .rate MINATOHOST",
      howgay: () => "Persentase random untuk hiburan saja: "+Math.floor(Math.random()*101)+"%. Tidak menggambarkan identitas siapa pun.",
      howcute: () => "Skor lucu random: "+Math.floor(Math.random()*101)+"/100 (sekadar permainan).",
      howsmart: () => "Skor random: "+Math.floor(Math.random()*101)+"/100 (sekadar permainan).",
      pickupline: () => pick(["Kamu seperti notifikasi baik, selalu bikin hari lebih cerah.","Kalau semangat itu bintang, kamu pasti salah satunya."]),
      roast: () => input ? input+", semangat ya, bahkan loading pun akhirnya selesai." : "Contoh: .roast nama",
      compliment: () => input ? input+" punya potensi besar. Terus berkarya!" : "Kamu hebat karena terus mencoba.",
      riddle: () => "Aku punya banyak gigi tetapi tidak bisa menggigit. Apakah aku?\\nKetik .answer untuk jawabannya.",
      answer: () => "Jawabannya: sisir.",
      quiz: () => "Kuis: Planet apa yang dikenal sebagai Planet Merah?\\nKetik .answer untuk melihat jawaban.",
      suit: () => "Suit: " + pick(["BATU","GUNTING","KERTAS"]),
      tebakangka: () => "Tebak angka dari 1 sampai 10: " + (Math.floor(Math.random()*10)+1) + " (angka contoh untuk ronde ini).",
      "8ball": () => pick(["Iya.","Tidak.","Mungkin.","Coba lagi nanti.","Sepertinya begitu."]),
      sum: () => { const n=args.map(Number); return n.length&&n.every(Number.isFinite) ? "Hasil: "+n.reduce((a,b)=>a+b,0) : "Contoh: .sum 10 20 30"; },
      average: () => { const n=args.map(Number); return n.length&&n.every(Number.isFinite) ? "Rata-rata: "+(n.reduce((a,b)=>a+b,0)/n.length) : "Contoh: .average 10 20 30"; },
      min: () => { const n=args.map(Number); return n.length&&n.every(Number.isFinite) ? "Nilai terkecil: "+Math.min(...n) : "Contoh: .min 10 20 30"; },
      max: () => { const n=args.map(Number); return n.length&&n.every(Number.isFinite) ? "Nilai terbesar: "+Math.max(...n) : "Contoh: .max 10 20 30"; },
      square: () => { const n=Number(args[0]); return Number.isFinite(n)&&args.length ? "Kuadrat: "+(n*n) : "Contoh: .square 12"; },
      sqrt: () => { const n=Number(args[0]); return Number.isFinite(n)&&n>=0&&args.length ? "Akar kuadrat: "+Math.sqrt(n) : "Contoh: .sqrt 144"; },
      quote2: () => pick(["Sederhana bukan berarti biasa.","Fokus pada tujuan, bukan gangguan.","Hari ini kesempatan baru untuk belajar."]),
      emoji: () => input ? input+" ✨🌟💫" : "Contoh: .emoji Halo"

    };
    if (utilityReplies[command]) return reply(utilityReplies[command]());


    if (command === "menu") return reply(menuText(msg.pushName));
    if (command === "owner") return reply("OWN MINATOHOST\nWhatsApp: 082180696427");
    if (command === "status") return reply("Status: MINATOHOST");
    if (["grouplink", "groupinfo", "groupname", "groupdesc", "groupmembers", "groupadmins", "groupowner", "groupid", "groupcount"].includes(command)) {
      if (!group) return reply("Command ini hanya bisa digunakan di grup.");
      if (!metadata) return reply("Tidak bisa membaca data grup.");
      if (command === "grouplink") {
        if (!senderAdmin) return reply("Khusus admin grup.");
        if (!botAdmin) return reply("Bot harus menjadi admin untuk mengambil tautan grup.");
        try {
          const code = await sock.groupInviteCode(jid);
          return reply("LINK GRUP\\nhttps://chat.whatsapp.com/" + code);
        } catch (_) {
          return reply("Gagal mengambil tautan grup.");
        }
      }
      if (command === "groupinfo") {
        return reply("INFO GRUP\\nNama: " + (metadata.subject || "-") + "\\nID: " + jid + "\\nAnggota: " + (metadata.participants || []).length + "\\nAdmin: " + (metadata.participants || []).filter((p) => p.admin).length);
      }
      if (command === "groupname") return reply("Nama grup: " + (metadata.subject || "-"));
      if (command === "groupdesc") return reply("Deskripsi grup: " + (metadata.desc || "Belum ada deskripsi."));
      if (command === "groupmembers" || command === "groupcount") return reply("Jumlah anggota grup: " + (metadata.participants || []).length);
      if (command === "groupadmins") {
        const admins = (metadata.participants || []).filter((p) => p.admin);
        return reply("ADMIN GRUP\\n" + (admins.length ? admins.map((p) => "• @" + numberFromJid(p.id)).join("\\n") : "Belum ada data admin."), { mentions: admins.map((p) => p.id) });
      }
      if (command === "groupowner") {
        const creator = metadata.owner || (metadata.participants || []).find((p) => p.admin === "superadmin")?.id;
        return reply("Pembuat grup: " + (creator ? "@" + numberFromJid(creator) : "Tidak diketahui."), creator ? { mentions: [creator] } : {});
      }
      if (command === "groupid") return reply("ID grup: " + jid);
    }

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

    if (["groupinfo","membercount","listadmin","groupname","groupdesc"].includes(command)) {
      if (!group) return reply("Command ini hanya bisa digunakan di grup.");
      if (!metadata) return reply("Tidak bisa membaca data grup.");
      if (command === "groupinfo") return reply("INFO GRUP\\nNama: "+(metadata.subject||"-")+"\\nID: "+jid+"\\nAnggota: "+(metadata.participants||[]).length+"\\nAdmin: "+(metadata.participants||[]).filter(p=>p.admin).length);
      if (command === "membercount") return reply("Jumlah anggota: "+(metadata.participants||[]).length);
      if (command === "listadmin") { const admins=(metadata.participants||[]).filter(p=>p.admin); return reply("ADMIN GRUP\\n"+admins.map(p=>"• @"+numberFromJid(p.id)).join("\\n"),{mentions:admins.map(p=>p.id)}); }
      if (command === "groupname") return reply("Nama grup: "+(metadata.subject||"-"));
      if (command === "groupdesc") return reply("Deskripsi grup: "+(metadata.desc||"Belum ada deskripsi."));
    }
    if (command === "grouplink") {
      if (!group) return reply("Command ini hanya bisa digunakan di grup.");
      if (!senderAdmin) return reply("Khusus admin grup.");
      if (!botAdmin) return reply("Bot harus menjadi admin.");
      const code=await sock.groupInviteCode(jid);
      return reply("LINK GRUP\\nhttps://chat.whatsapp.com/"+code);
    }
    if (["tagall", "hidetag", "kick", "promote", "demote", "add", "setname", "setdesc", "open", "close", "mute", "unmute", "revoke", "resetlink", "delete", "announce"].includes(command)) {
      if (!group) return reply("Command ini hanya bisa digunakan di grup.");
      if (!senderAdmin) return reply("Khusus admin grup.");
      if (!metadata) return reply("Tidak bisa membaca data grup.");
      if (!botAdmin && ["add","setname","setdesc","open","close","mute","unmute","revoke","resetlink","delete","pin","unpin"].includes(command)) return reply("Jadikan bot admin grup terlebih dahulu.");
      if (command === "setname") { if (!input) return reply("Contoh: .setname Nama Grup"); await sock.groupUpdateSubject(jid,input); return reply("Nama grup diperbarui."); }
      if (command === "setdesc") { if (!input) return reply("Contoh: .setdesc Deskripsi grup"); await sock.groupUpdateDescription(jid,input); return reply("Deskripsi grup diperbarui."); }
      if (command === "open" || command === "close") { await sock.groupSettingUpdate(jid,command==="open"?"not_announcement":"announcement"); return reply(command==="open"?"Grup dibuka untuk semua anggota.":"Grup dibatasi untuk admin."); }
      if (command === "mute" || command === "unmute") { await sock.groupSettingUpdate(jid,command==="mute"?"announcement":"not_announcement"); return reply(command==="mute"?"Mode admin-only aktif.":"Semua anggota dapat mengirim pesan."); }
      if (command === "revoke" || command === "resetlink") { const code=await sock.groupRevokeInvite(jid); return reply("Link undangan berhasil diperbarui.\\nhttps://chat.whatsapp.com/"+code); }
      if (command === "add") { const number=(args[0]||"").replace(/\\D/g,""); if(number.length<10) return reply("Contoh: .add 62812xxxx"); await sock.groupParticipantsUpdate(jid,[number+"@s.whatsapp.net"],"add"); return reply("Permintaan tambah anggota diproses."); }
      if (command === "delete") { const key=msg.message?.extendedTextMessage?.contextInfo?.stanzaId; const participant=msg.message?.extendedTextMessage?.contextInfo?.participant; if(!key||!participant) return reply("Balas pesan yang ingin dihapus."); await sock.sendMessage(jid,{delete:{remoteJid:jid,id:key,participant}}); return; }
      if (command === "announce") { if (!input) return reply("Contoh: .announce Pengumuman penting"); return reply("📢 PENGUMUMAN ADMIN\\n"+input); }
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
      const targets = (context.mentionedJid && context.mentionedJid.length) ? context.mentionedJid : (context.participant ? [context.participant] : []);
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
