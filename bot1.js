const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const schedule = require("node-schedule");
const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");

// ===== CONFIG =====
const token = process.env.BOT_TOKEN;
const MONGO = process.env.MONGO_URL;
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(32).toString("hex");
const TIMEZONE = process.env.TIMEZONE || "Asia/Kolkata"; // 🔴 IMPORTANT: CHANGE THIS IF NEEDED

if (!token) throw new Error("❌ BOT_TOKEN is required in .env");
if (!MONGO) throw new Error("❌ MONGO_URL is required in .env");

console.log(`⚙️  TIMEZONE SET TO: ${TIMEZONE}`);

// ===== ADMIN & SETTINGS =====
const ADMIN_IDS = [6517248246, 7419362470, 8530664171];
const BROADCAST_RATE_LIMIT = 50;
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;

// ===== INIT =====
const bot = new TelegramBot(token, { polling: true });
const app = express();
app.use(bodyParser.json());

// ===== LOGGING UTILITY =====
const logger = {
  info: (msg) => console.log(`✅ ${new Date().toLocaleString("en-IN", { timeZone: TIMEZONE })} | ${msg}`),
  warn: (msg) => console.log(`⚠️  ${new Date().toLocaleString("en-IN", { timeZone: TIMEZONE })} | ${msg}`),
  error: (msg) => console.error(`❌ ${new Date().toLocaleString("en-IN", { timeZone: TIMEZONE })} | ${msg}`),
  debug: (msg) => console.log(`🔍 ${new Date().toLocaleString("en-IN", { timeZone: TIMEZONE })} | ${msg}`),
};

// ===== DB CONNECTION =====
mongoose.connect(MONGO, {
  serverSelectionTimeoutMS: 5000,
  retryWrites: true,
});

mongoose.connection.once("open", () => {
  logger.info("MongoDB Connected!");
});

mongoose.connection.on("error", (err) => {
  logger.error(`MongoDB Error: ${err.message}`);
});

mongoose.connection.on("disconnected", () => {
  logger.warn("MongoDB Disconnected!");
});

// ===== SCHEMAS =====
const postSchema = new mongoose.Schema({
  chatId: { type: Number, required: true },
  type: { type: String, enum: ["text", "photo", "video"], default: "text" },
  fileId: String,
  text: { type: String, required: true },
  time: Date,
  daily: { type: Boolean, default: false },
  hour: Number,
  minute: Number,
  tags: [String],
  createdAt: { type: Date, default: Date.now },
  sentCount: { type: Number, default: 0 },
  failCount: { type: Number, default: 0 },
  nextRun: Date, // 🔴 NEW: Track when this post will next run
});

const chatSchema = new mongoose.Schema({
  chatId: { type: Number, unique: true },
  firstName: String,
  username: String,
  joinedAt: { type: Date, default: Date.now },
  tags: [String],
  blocked: { type: Boolean, default: false },
  lastReceived: Date,
});

const analyticsSchema = new mongoose.Schema({
  postId: mongoose.Schema.Types.ObjectId,
  sentAt: Date,
  successCount: Number,
  failCount: Number,
  avgDeliveryMs: Number,
});

const auditSchema = new mongoose.Schema({
  adminId: Number,
  action: String,
  details: mongoose.Schema.Types.Mixed,
  timestamp: { type: Date, default: Date.now },
});

const Post = mongoose.model("Post", postSchema);
const Chat = mongoose.model("Chat", chatSchema);
const Analytics = mongoose.model("Analytics", analyticsSchema);
const Audit = mongoose.model("Audit", auditSchema);

// ===== STATE =====
let isPaused = false;
const editState = {};
const scheduledJobs = {}; // 🔴 NEW: Track scheduled jobs locally

// ===== HELPERS =====
const isAdmin = (msg) => ADMIN_IDS.includes(msg?.from?.id);
const nowIST = () => new Date(new Date().toLocaleString("en-US", { timeZone: TIMEZONE }));
const pad = (n) => String(n).padStart(2, "0");

const formatTime = (p) =>
  p.daily
    ? `🔁 Daily @ ${pad(p.hour)}:${pad(p.minute)} ${TIMEZONE}`
    : `📅 Once @ ${new Date(p.time).toLocaleString("en-IN", { timeZone: TIMEZONE })}`;

const safeReply = async (chatId, text, opts = {}) => {
  try {
    return await bot.sendMessage(chatId, text, opts);
  } catch (err) {
    logger.error(`Failed to send to ${chatId}: ${err.message}`);
  }
};

const logAudit = async (adminId, action, details = {}) => {
  try {
    await Audit.create({ adminId, action, details });
  } catch (e) {
    logger.error(`Audit log failed: ${e.message}`);
  }
};

// ===== USER REGISTRATION =====
bot.on("message", async (msg) => {
  try {
    await Chat.updateOne(
      { chatId: msg.chat.id },
      {
        $setOnInsert: {
          chatId: msg.chat.id,
          firstName: msg.from.first_name,
          username: msg.from.username,
        },
        lastReceived: new Date(),
      },
      { upsert: true }
    );
  } catch (e) {
    logger.error(`User registration failed: ${e.message}`);
  }
});

// ===== /START CONTROL PANEL =====
bot.onText(/\/start/, (msg) => {
  if (!isAdmin(msg)) return safeReply(msg.chat.id, "👋 Hello! You're subscribed to updates.");

  safeReply(msg.chat.id, "🚀 *Bot Control Panel*", {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📅 Schedule Post", callback_data: "schedule" }],
        [{ text: "🔁 Daily Post", callback_data: "daily" }],
        [{ text: "🖼 Media Daily", callback_data: "media" }],
        [{ text: "📋 View Posts", callback_data: "list" }],
        [{ text: "📢 Broadcast", callback_data: "broadcast" }],
        [{ text: "👥 Users", callback_data: "users" }],
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
    schedule: "📅 *One-time post:*\n`/schedule HH:MM Your message`\n\nExample:\n`/schedule 19:00 Good evening!`",
    daily: "🔁 *Daily post:*\n`/daily HH:MM Your message`\n\nExample:\n`/daily 09:00 Good morning!`",
    media: "🖼 *Media daily:*\nSend photo/video with caption:\n`/daily HH:MM Caption`",
    broadcast: "📢 *Broadcast:*\n`/broadcast message`",
  };

  if (helpMessages[data]) {
    await safeReply(chatId, helpMessages[data], { parse_mode: "Markdown" });
  }

  if (data === "list") {
    const posts = await Post.find().sort({ createdAt: -1 }).limit(10);
    if (!posts.length) return safeReply(chatId, "📭 No posts.");

    for (const p of posts) {
      const nextRun = p.nextRun ? new Date(p.nextRun).toLocaleString("en-IN", { timeZone: TIMEZONE }) : "❌ Not scheduled";
      const label = p.type !== "text" ? `[${p.type.toUpperCase()}] ` : "";
      
      await safeReply(
        chatId,
        `🆔 \`${p._id}\`\n${formatTime(p)}\n⏱ Next run: ${nextRun}\n${label}${p.text}\n✅ Sent: ${p.sentCount} | ❌ Failed: ${p.failCount}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: "✏ Edit", callback_data: `edit_${p._id}` },
              { text: "❌ Delete", callback_data: `del_${p._id}` },
              { text: "🧪 Test", callback_data: `test_${p._id}` },
            ]],
          },
        }
      );
    }
  }

  if (data === "users") {
    const [total, blocked, active] = await Promise.all([
      Chat.countDocuments(),
      Chat.countDocuments({ blocked: true }),
      Chat.countDocuments({ lastReceived: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }),
    ]);
    safeReply(chatId, `👥 *User Stats*\n\n👥 Total: ${total}\n❌ Blocked: ${blocked}\n🟢 Active (7d): ${active}`, {
      parse_mode: "Markdown",
    });
  }

  if (data === "stats") {
    const [users, posts] = await Promise.all([Chat.countDocuments(), Post.countDocuments()]);
    const status = isPaused ? "⏸ Paused" : "🟢 Running";
    const jobCount = Object.keys(scheduledJobs).length;
    
    await safeReply(
      chatId,
      `📊 *Bot Stats*\n\n👥 Users: ${users}\n📬 Posts: ${posts}\n⏰ Active Jobs: ${jobCount}\n🔄 Status: ${status}\n⏱ Timezone: ${TIMEZONE}`,
      { parse_mode: "Markdown" }
    );
  }

  if (data.startsWith("edit_")) {
    const id = data.split("_")[1];
    editState[q.from.id] = { postId: id, step: "text" };
    await safeReply(chatId, "✏ Send new text (or `skip`):", { parse_mode: "Markdown" });
  }

  if (data.startsWith("del_")) {
    const id = data.split("_")[1];
    await Post.findByIdAndDelete(id);
    cancelJob(id);
    logAudit(q.from.id, "DELETE_POST", { postId: id });
    logger.info(`Post deleted: ${id}`);
    await safeReply(chatId, "✅ Post deleted.");
  }

  // 🔴 NEW: Test post immediately
  if (data.startsWith("test_")) {
    const id = data.split("_")[1];
    const post = await Post.findById(id);
    if (post) {
      logger.info(`Testing post: ${id}`);
      await sendPost(post);
      await safeReply(chatId, `🧪 Test sent! Check your messages.`);
    }
  }

  if (data === "pause") {
    isPaused = true;
    logAudit(q.from.id, "PAUSE_BOT", {});
    logger.warn("Bot PAUSED by admin");
    await safeReply(chatId, "⏸ Bot paused.", { parse_mode: "Markdown" });
  }

  if (data === "resume") {
    isPaused = false;
    logAudit(q.from.id, "RESUME_BOT", {});
    logger.warn("Bot RESUMED by admin");
    await safeReply(chatId, "▶ Bot resumed.", { parse_mode: "Markdown" });
  }

  bot.answerCallbackQuery(q.id).catch(() => {});
});

// ===== EDIT FLOW =====
bot.on("message", async (msg) => {
  if (!isAdmin(msg)) return;

  const state = editState[msg.from.id];
  if (!state) return;

  if (state.step === "text") {
    if (msg.text.toLowerCase() !== "skip") {
      await Post.findByIdAndUpdate(state.postId, { text: msg.text });
    }
    editState[msg.from.id].step = "time";
    return safeReply(msg.chat.id, "⏰ Send new time `HH:MM` or `skip`:", { parse_mode: "Markdown" });
  }

  if (state.step === "time") {
    if (msg.text.toLowerCase() !== "skip") {
      const match = msg.text.match(/^(\d{1,2}):(\d{2})$/);
      if (!match) return safeReply(msg.chat.id, "❌ Use `HH:MM`", { parse_mode: "Markdown" });

      const hour = parseInt(match[1]);
      const minute = parseInt(match[2]);
      if (hour > 23 || minute > 59) return safeReply(msg.chat.id, "❌ Invalid time.");

      await Post.findByIdAndUpdate(state.postId, { hour, minute });
      cancelJob(state.postId);
      const updated = await Post.findById(state.postId);
      if (updated?.daily) {
        scheduleDaily(updated);
      }
    }

    delete editState[msg.from.id];
    return safeReply(msg.chat.id, "✅ Updated!");
  }
});

// ===== /DAILY TEXT =====
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
  logger.info(`Daily post created: ${post._id} @ ${pad(hour)}:${pad(minute)}`);
  logAudit(msg.from.id, "CREATE_DAILY", { postId: post._id, text, time: `${hour}:${minute}` });
  safeReply(msg.chat.id, `✅ Daily post set for *${pad(hour)}:${pad(minute)} ${TIMEZONE}*`, { parse_mode: "Markdown" });
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
  const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.video.file_id;

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
  logger.info(`Media daily post created: ${post._id} (${type}) @ ${pad(hour)}:${pad(minute)}`);
  logAudit(msg.from.id, "CREATE_MEDIA_DAILY", { postId: post._id, type });
  safeReply(msg.chat.id, `✅ Media daily set for *${pad(hour)}:${pad(minute)} ${TIMEZONE}*`, { parse_mode: "Markdown" });
});

// ===== /SCHEDULE ONE-TIME =====
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
    nextRun: date,
  });

  schedule.scheduleJob(post._id.toString(), date, () => sendPost(post));
  scheduledJobs[post._id.toString()] = true;
  
  const timeStr = date.toLocaleString("en-IN", { timeZone: TIMEZONE });
  logger.info(`One-time post scheduled: ${post._id} @ ${timeStr}`);
  logAudit(msg.from.id, "SCHEDULE_POST", { postId: post._id, text, scheduledFor: timeStr });

  safeReply(msg.chat.id, `📅 Scheduled for *${timeStr}*`, { parse_mode: "Markdown" });
});

// ===== /BROADCAST WITH TAGS =====
bot.onText(/\/broadcast(?:\s+#(.+?))?\s+(.+)/, async (msg, m) => {
  if (!isAdmin(msg)) return;

  const tags = m[1] ? m[1].split(" ") : [];
  const message = m[2];

  let query = {};
  if (tags.length > 0) {
    query = { tags: { $in: tags }, blocked: false };
  } else {
    query = { blocked: false };
  }

  const users = await Chat.find(query);
  let sent = 0, failed = 0;
  let startTime = Date.now();

  logger.info(`Broadcasting to ${users.length} users...`);

  for (const u of users) {
    try {
      await bot.sendMessage(u.chatId, message);
      sent++;
      await new Promise((r) => setTimeout(r, 1000 / BROADCAST_RATE_LIMIT));
    } catch (err) {
      failed++;
      if (err.response?.body?.error_code === 403) {
        await Chat.updateOne({ chatId: u.chatId }, { blocked: true });
      }
    }
  }

  const deliveryTime = Date.now() - startTime;
  const avgMs = Math.round(deliveryTime / (sent + failed));

  await Analytics.create({
    sentAt: new Date(),
    successCount: sent,
    failCount: failed,
    avgDeliveryMs: avgMs,
  });

  logAudit(msg.from.id, "BROADCAST", { sent, failed, tags });
  logger.info(`Broadcast complete: ${sent} sent, ${failed} failed, ${avgMs}ms avg`);
  
  safeReply(msg.chat.id, `📢 Sent: ${sent} ✅ | Failed: ${failed} ❌ | Avg: ${avgMs}ms ⏱`);
});

// ===== SEND POST =====
async function sendPost(p) {
  if (isPaused) {
    logger.warn(`Post ${p._id} not sent (bot paused)`);
    return;
  }

  const users = await Chat.find({ blocked: false });
  let sent = 0, failed = 0;
  let startTime = Date.now();

  logger.info(`Sending post ${p._id} to ${users.length} users...`);

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
      await new Promise((r) => setTimeout(r, 1000 / BROADCAST_RATE_LIMIT));
    } catch (err) {
      failed++;
      if (err.response?.body?.error_code === 403) {
        await Chat.updateOne({ chatId: u.chatId }, { blocked: true });
      }
    }
  }

  const deliveryTime = Date.now() - startTime;
  const avgMs = Math.round(deliveryTime / (sent + failed));

  await Post.findByIdAndUpdate(p._id, {
    sentCount: sent,
    failCount: failed,
  });

  await Analytics.create({
    postId: p._id,
    sentAt: new Date(),
    successCount: sent,
    failCount: failed,
    avgDeliveryMs: avgMs,
  });

  logger.info(`✅ Post ${p._id} sent: ${sent} success, ${failed} failed, ${avgMs}ms avg`);
}

// ===== SCHEDULE DAILY JOB =====
function scheduleDaily(p) {
  cancelJob(p._id.toString());
  
  const now = nowIST();
  const nextRun = new Date(now);
  nextRun.setHours(p.hour, p.minute, 0, 0);
  
  if (nextRun <= now) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  const job = schedule.scheduleJob(p._id.toString(), {
    hour: p.hour,
    minute: p.minute,
    tz: TIMEZONE,
  }, () => sendPost(p));

  scheduledJobs[p._id.toString()] = true;
  
  logger.info(`Daily job scheduled: ${p._id} @ ${pad(p.hour)}:${pad(p.minute)} (next run: ${nextRun.toLocaleString("en-IN", { timeZone: TIMEZONE })})`);

  // Update next run in DB
  Post.findByIdAndUpdate(p._id, { nextRun }).catch(() => {});
}

// ===== CANCEL JOB =====
function cancelJob(id) {
  const job = schedule.scheduledJobs[id];
  if (job) {
    job.cancel();
    delete scheduledJobs[id];
    logger.debug(`Job cancelled: ${id}`);
  }
}

// ===== LOAD JOBS ON STARTUP =====
async function loadJobs() {
  const posts = await Post.find();
  const now = new Date();
  let loaded = 0, skipped = 0;

  logger.info(`Loading ${posts.length} posts from database...`);

  for (const p of posts) {
    if (p.daily) {
      scheduleDaily(p);
      loaded++;
    } else if (p.time && new Date(p.time) > now) {
      schedule.scheduleJob(p._id.toString(), new Date(p.time), () => sendPost(p));
      scheduledJobs[p._id.toString()] = true;
      loaded++;
    } else {
      skipped++;
    }
  }

  logger.info(`✅ Jobs loaded: ${loaded} active, ${skipped} skipped (expired)`);
}

// ===== REST API - DEBUG ENDPOINTS =====
app.get("/", (req, res) => {
  res.json({
    status: "running",
    paused: isPaused,
    uptime: process.uptime(),
    timezone: TIMEZONE,
    activeJobs: Object.keys(scheduledJobs).length,
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), timezone: TIMEZONE });
});

app.get("/api/stats", async (req, res) => {
  const [users, posts, blocked] = await Promise.all([
    Chat.countDocuments(),
    Post.countDocuments(),
    Chat.countDocuments({ blocked: true }),
  ]);
  res.json({ users, posts, blocked, paused: isPaused, activeJobs: Object.keys(scheduledJobs).length });
});

app.get("/api/posts", async (req, res) => {
  const posts = await Post.find().sort({ createdAt: -1 }).limit(20);
  res.json(posts);
});

app.get("/api/analytics", async (req, res) => {
  const analytics = await Analytics.find().sort({ sentAt: -1 }).limit(10);
  res.json(analytics);
});

// 🔴 NEW: Debug endpoint to see all scheduled jobs
app.get("/api/debug/jobs", async (req, res) => {
  const posts = await Post.find();
  const jobDetails = [];

  for (const p of posts) {
    const isScheduled = !!scheduledJobs[p._id.toString()];
    const now = nowIST();
    let nextRun = "Not scheduled";

    if (p.daily) {
      const next = new Date(now);
      next.setHours(p.hour, p.minute, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      nextRun = next.toLocaleString("en-IN", { timeZone: TIMEZONE });
    } else if (p.time) {
      nextRun = new Date(p.time).toLocaleString("en-IN", { timeZone: TIMEZONE });
    }

    jobDetails.push({
      id: p._id,
      text: p.text.substring(0, 50),
      type: p.type,
      daily: p.daily,
      time: p.daily ? `${pad(p.hour)}:${pad(p.minute)}` : p.time,
      nextRun: nextRun,
      isScheduled: isScheduled,
      sentCount: p.sentCount,
      failCount: p.failCount,
    });
  }

  res.json({
    timezone: TIMEZONE,
    currentTime: nowIST().toLocaleString("en-IN", { timeZone: TIMEZONE }),
    totalJobs: jobDetails.length,
    activeJobs: Object.keys(scheduledJobs).length,
    paused: isPaused,
    jobs: jobDetails,
  });
});

// 🔴 NEW: Debug endpoint to manually test a post
app.post("/api/debug/test-post/:id", async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!post) return res.json({ error: "Post not found" });

  logger.info(`Manual test triggered for post: ${post._id}`);
  await sendPost(post);

  res.json({ status: "Test sent!", postId: post._id });
});

// ===== ERROR HANDLERS =====
bot.on("polling_error", (err) => logger.error(`Polling error: ${err.message}`));
process.on("unhandledRejection", (err) => logger.error(`Unhandled rejection: ${err}`));

// ===== SERVER =====
app.listen(PORT, async () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Timezone: ${TIMEZONE}`);
  logger.info(`Bot Token loaded: ${token.substring(0, 10)}...`);
  logger.info(`MongoDB URL: ${MONGO.substring(0, 40)}...`);
  logger.info(`Dashboard: http://localhost:${PORT}`);
  logger.info(`Debug jobs: http://localhost:${PORT}/api/debug/jobs`);
  
  await loadJobs();
  
  logger.info("🚀 Bot ready!");
});
