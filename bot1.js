const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const schedule = require("node-schedule");
const express = require("express");

// ===== ENV =====
const token = process.env.BOT_TOKEN;
const MONGO = process.env.MONGO_URL;
const PORT = process.env.PORT || 3000;
const TIMEZONE = "Asia/Kolkata";

if (!token) throw new Error("BOT_TOKEN is required");
if (!MONGO) throw new Error("MONGO_URL is required");

// ===== ADMIN =====
const ADMIN_IDS = [6517248246, 7419362470, 8530664171];

// ===== INIT =====
const bot = new TelegramBot(token, { polling: true });
const app = express();

// ===== DB =====
mongoose.connect(MONGO, {
  serverSelectionTimeoutMS: 5000,
  retryWrites: true,
});
mongoose.connection.once("open", () => console.log("✅ MongoDB Connected"));
mongoose.connection.on("error", (err) => console.error("❌ MongoDB Error:", err));

// ===== SCHEMAS =====
const postSchema = new mongoose.Schema({
  chatId: { type: Number, required: true },
  type: { type: String, enum: ["text", "photo", "video"], default: "text" },
  fileId: String,
  text: String,
  time: Date,
  daily: { type: Boolean, default: false },
  hour: Number,
  minute: Number,
  createdAt: { type: Date, default: Date.now },
});

const chatSchema = new mongoose.Schema({
  chatId: { type: Number, unique: true },
  joinedAt: { type: Date, default: Date.now },
});

const Post = mongoose.model("Post", postSchema);
const Chat = mongoose.model("Chat", chatSchema);

// ===== STATE =====
let isPaused = false;
const editState = {}; // { userId: { postId, step } }

// ===== HELPERS =====
const isAdmin = (msg) => ADMIN_IDS.includes(msg?.from?.id);

const nowIST = () =>
  new Date(new Date().toLocaleString("en-US", { timeZone: TIMEZONE }));

const pad = (n) => String(n).padStart(2, "0");

const formatTime = (p) =>
  p.daily
    ? `🔁 Daily @ ${pad(p.hour)}:${pad(p.minute)} IST`
    : `📅 Once @ ${new Date(p.time).toLocaleString("en-IN", { timeZone: TIMEZONE })}`;

const safeReply = async (chatId, text, opts = {}) => {
  try {
    return await bot.sendMessage(chatId, text, opts);
  } catch (err) {
    console.error(`Failed to send message to ${chatId}:`, err.message);
  }
};

// ===== REGISTER USERS =====
bot.on("message", async (msg) => {
  try {
    await Chat.updateOne(
      { chatId: msg.chat.id },
      { $setOnInsert: { chatId: msg.chat.id } },
      { upsert: true }
    );
  } catch {}
});

// ===== /start — CONTROL PANEL =====
bot.onText(/\/start/, (msg) => {
  if (!isAdmin(msg)) return safeReply(msg.chat.id, "👋 Hello! You're now subscribed to updates.");

  safeReply(msg.chat.id, "🚀 *Control Panel*", {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📅 Schedule Post", callback_data: "schedule" }],
        [{ text: "🔁 Daily Post", callback_data: "daily" }],
        [{ text: "🖼 Media Daily", callback_data: "media" }],
        [{ text: "📋 View Posts", callback_data: "list" }],
        [{ text: "📢 Broadcast", callback_data: "broadcast" }],
        [{ text: "📊 Stats", callback_data: "stats" }],
        [
          { text: "⏸ Pause", callback_data: "pause" },
          { text: "▶ Resume", callback_data: "resume" },
        ],
      ],
    },
  });
});

// ===== CALLBACK QUERIES =====
bot.on("callback_query", async (q) => {
  if (!ADMIN_IDS.includes(q.from.id)) {
    return bot.answerCallbackQuery(q.id, { text: "⛔ Not authorized" });
  }

  const chatId = q.message.chat.id;
  const data = q.data;

  const helpMessages = {
    schedule: "📅 *One-time post:*\n`/schedule HH:MM Your message`\n\nExample:\n`/schedule 19:00 Good evening everyone!`",
    daily: "🔁 *Daily post:*\n`/daily HH:MM Your message`\n\nExample:\n`/daily 09:00 Good morning!`",
    media: "🖼 *Media daily:*\nSend a photo or video with caption:\n`/daily HH:MM Your caption`",
    broadcast: "📢 *Broadcast to all users:*\n`/broadcast Your message`",
  };

  if (helpMessages[data]) {
    await safeReply(chatId, helpMessages[data], { parse_mode: "Markdown" });
  }

  if (data === "list") {
    const posts = await Post.find().sort({ createdAt: -1 });
    if (!posts.length) return safeReply(chatId, "📭 No scheduled posts.");

    for (const p of posts) {
      const label = p.type !== "text" ? `[${p.type.toUpperCase()}] ` : "";
      await safeReply(
        chatId,
        `🆔 \`${p._id}\`\n${formatTime(p)}\n${label}📄 ${p.text || "(no text)"}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: "✏ Edit", callback_data: `edit_${p._id}` },
              { text: "❌ Delete", callback_data: `del_${p._id}` },
            ]],
          },
        }
      );
    }
  }

  if (data === "stats") {
    const [users, posts] = await Promise.all([
      Chat.countDocuments(),
      Post.countDocuments(),
    ]);
    const status = isPaused ? "⏸ Paused" : "▶ Running";
    await safeReply(chatId, `📊 *Bot Stats*\n\n👥 Users: ${users}\n📬 Scheduled Posts: ${posts}\n🔄 Status: ${status}`, {
      parse_mode: "Markdown",
    });
  }

  if (data.startsWith("edit_")) {
    const id = data.split("_")[1];
    editState[q.from.id] = { postId: id, step: "text" };
    await safeReply(chatId, "✏ Send the *new text* for this post (or type `skip` to keep current):", {
      parse_mode: "Markdown",
    });
  }

  if (data.startsWith("del_")) {
    const id = data.split("_")[1];
    await Post.findByIdAndDelete(id);
    cancelJob(id);
    await safeReply(chatId, "✅ Post deleted.");
  }

  if (data === "pause") {
    isPaused = true;
    await safeReply(chatId, "⏸ Bot *paused*. Posts will not be sent until resumed.", { parse_mode: "Markdown" });
  }

  if (data === "resume") {
    isPaused = false;
    await safeReply(chatId, "▶ Bot *resumed*. Posts will now be sent.", { parse_mode: "Markdown" });
  }

  bot.answerCallbackQuery(q.id).catch(() => {});
});

// ===== EDIT FLOW =====
bot.on("message", async (msg) => {
  if (!isAdmin(msg)) return;

  const state = editState[msg.from.id];
  if (!state) return;

  const { postId, step } = state;

  if (step === "text") {
    if (msg.text.toLowerCase() !== "skip") {
      await Post.findByIdAndUpdate(postId, { text: msg.text });
    }
    editState[msg.from.id].step = "time";
    return safeReply(msg.chat.id, "⏰ Send new time `HH:MM` or type `skip`:", { parse_mode: "Markdown" });
  }

  if (step === "time") {
    if (msg.text.toLowerCase() !== "skip") {
      const match = msg.text.match(/^(\d{1,2}):(\d{2})$/);
      if (!match) return safeReply(msg.chat.id, "❌ Invalid format. Use `HH:MM` or type `skip`.", { parse_mode: "Markdown" });

      const hour = parseInt(match[1]);
      const minute = parseInt(match[2]);

      if (hour > 23 || minute > 59) return safeReply(msg.chat.id, "❌ Invalid time values.");

      await Post.findByIdAndUpdate(postId, { hour, minute });
      cancelJob(postId);

      const updated = await Post.findById(postId);
      if (updated?.daily) scheduleDaily(updated);
    }

    delete editState[msg.from.id];
    return safeReply(msg.chat.id, "✅ Post updated successfully!");
  }
});

// ===== /daily TEXT =====
bot.onText(/\/daily (\d{1,2}):(\d{2}) (.+)/, async (msg, m) => {
  if (!isAdmin(msg)) return;

  const hour = parseInt(m[1]);
  const minute = parseInt(m[2]);
  const text = m[3];

  if (hour > 23 || minute > 59) return safeReply(msg.chat.id, "❌ Invalid time.");

  const post = await Post.create({
    chatId: msg.chat.id,
    type: "text",
    text,
    daily: true,
    hour,
    minute,
  });

  scheduleDaily(post);
  safeReply(msg.chat.id, `✅ Daily post set for *${pad(hour)}:${pad(minute)} IST*`, { parse_mode: "Markdown" });
});

// ===== MEDIA DAILY =====
bot.on("message", async (msg) => {
  if (!isAdmin(msg)) return;
  if (!msg.caption?.startsWith("/daily")) return;
  if (!msg.photo && !msg.video) return;

  const match = msg.caption.match(/\/daily (\d{1,2}):(\d{2}) (.+)/);
  if (!match) return safeReply(msg.chat.id, "❌ Format: `/daily HH:MM Caption`", { parse_mode: "Markdown" });

  const hour = parseInt(match[1]);
  const minute = parseInt(match[2]);
  const text = match[3];

  if (hour > 23 || minute > 59) return safeReply(msg.chat.id, "❌ Invalid time.");

  const type = msg.photo ? "photo" : "video";
  const fileId = msg.photo
    ? msg.photo[msg.photo.length - 1].file_id
    : msg.video.file_id;

  const post = await Post.create({
    chatId: msg.chat.id,
    type,
    fileId,
    text,
    daily: true,
    hour,
    minute,
  });

  scheduleDaily(post);
  safeReply(msg.chat.id, `✅ Media daily set for *${pad(hour)}:${pad(minute)} IST*`, { parse_mode: "Markdown" });
});

// ===== /schedule ONE-TIME =====
bot.onText(/\/schedule (\d{1,2}):(\d{2}) (.+)/, async (msg, m) => {
  if (!isAdmin(msg)) return;

  const hour = parseInt(m[1]);
  const minute = parseInt(m[2]);
  const text = m[3];

  if (hour > 23 || minute > 59) return safeReply(msg.chat.id, "❌ Invalid time.");

  const now = nowIST();
  const date = new Date(now);
  date.setHours(hour, minute, 0, 0);

  if (date <= now) date.setDate(date.getDate() + 1);

  const post = await Post.create({
    chatId: msg.chat.id,
    type: "text",
    text,
    time: date,
    daily: false,
  });

  schedule.scheduleJob(post._id.toString(), date, () => sendPost(post));

  const timeStr = date.toLocaleString("en-IN", { timeZone: TIMEZONE });
  safeReply(msg.chat.id, `📅 Scheduled for *${timeStr}*`, { parse_mode: "Markdown" });
});

// ===== /broadcast =====
bot.onText(/\/broadcast (.+)/, async (msg, m) => {
  if (!isAdmin(msg)) return;

  const message = m[1];
  const users = await Chat.find();

  let sent = 0, failed = 0;

  for (const u of users) {
    try {
      await bot.sendMessage(u.chatId, message);
      sent++;
      // Slight delay to avoid Telegram flood limits
      await new Promise((r) => setTimeout(r, 35));
    } catch {
      failed++;
    }
  }

  safeReply(msg.chat.id, `📢 Broadcast done!\n✅ Sent: ${sent}\n❌ Failed: ${failed}`);
});

// ===== SEND POST =====
async function sendPost(p) {
  if (isPaused) return;

  const users = await Chat.find();
  let sent = 0, failed = 0;

  for (const u of users) {
    try {
      if (p.type === "photo") {
        await bot.sendPhoto(u.chatId, p.fileId, { caption: p.text });
      } else if (p.type === "video") {
        await bot.sendVideo(u.chatId, p.fileId, { caption: p.text });
      } else {
        await bot.sendMessage(u.chatId, p.text);
      }
      sent++;
      await new Promise((r) => setTimeout(r, 35)); // flood-safe delay
    } catch (err) {
      failed++;
      // Remove users who have blocked the bot
      if (err.code === "ETELEGRAM" && err.response?.body?.error_code === 403) {
        await Chat.deleteOne({ chatId: u.chatId });
      }
    }
  }

  console.log(`📨 Post sent: ${sent} success, ${failed} failed`);
}

// ===== SCHEDULE DAILY JOB =====
function scheduleDaily(p) {
  cancelJob(p._id.toString());
  schedule.scheduleJob(p._id.toString(), {
    hour: p.hour,
    minute: p.minute,
    tz: TIMEZONE,
  }, () => sendPost(p));
}

// ===== CANCEL JOB =====
function cancelJob(id) {
  const job = schedule.scheduledJobs[id];
  if (job) job.cancel();
}

// ===== LOAD JOBS ON STARTUP =====
async function loadJobs() {
  const posts = await Post.find();
  const now = new Date();
  let loaded = 0;

  for (const p of posts) {
    if (p.daily) {
      scheduleDaily(p);
      loaded++;
    } else if (p.time && new Date(p.time) > now) {
      schedule.scheduleJob(p._id.toString(), new Date(p.time), () => sendPost(p));
      loaded++;
    } else if (p.time && new Date(p.time) <= now) {
      // Clean up expired one-time posts
      await Post.findByIdAndDelete(p._id);
    }
  }

  console.log(`⏰ Loaded ${loaded} scheduled jobs`);
}

// ===== GLOBAL ERROR HANDLERS =====
bot.on("polling_error", (err) => console.error("Polling error:", err.message));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));

// ===== SERVER =====
app.get("/", (req, res) => res.json({ status: "running", paused: isPaused }));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.listen(PORT, async () => {
  console.log(`🌐 Server running on port ${PORT}`);
  await loadJobs();
});
