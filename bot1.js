console.log("TOKEN:", process.env.BOT_TOKEN);
console.log("MONGO:", process.env.MONGO_URL);

const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const schedule = require("node-schedule");
const express = require("express");

// ===== ENV =====
const token = process.env.BOT_TOKEN;
const MONGO = process.env.MONGO_URL;

// 👉 ADD ADMINS
const ADMIN_IDS = [6517248246,
                   7419362470,
                   8530664171];

// ===== INIT =====
const bot = new TelegramBot(token, { polling: true });
const app = express();

// ===== DB =====
mongoose.connect(MONGO);
mongoose.connection.once("open", () => {
  console.log("✅ MongoDB Connected");
});

// ===== SCHEMA =====
const postSchema = new mongoose.Schema({
  chatId: Number,
  type: String, // text, photo, video
  fileId: String,
  text: String,
  time: Date,
  daily: Boolean,
  hour: Number,
  minute: Number
});
const Post = mongoose.model("Post", postSchema);

const chatSchema = new mongoose.Schema({
  chatId: Number
});
const Chat = mongoose.model("Chat", chatSchema);

// ===== HELPERS =====
const isAdmin = (msg) => ADMIN_IDS.includes(msg.from.id);
let isPaused = false;

// ===== STORE CHAT =====
bot.on("message", async (msg) => {
  try {
    const exists = await Chat.findOne({ chatId: msg.chat.id });
    if (!exists) await Chat.create({ chatId: msg.chat.id });
  } catch {}
});

// ===== UI =====
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "🚀 CoinTRX Control Panel", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📅 Schedule Post", callback_data: "schedule" }],
        [{ text: "🔁 Daily Post", callback_data: "daily" }],
        [{ text: "🖼 Send Media Daily", callback_data: "media" }],
        [{ text: "📋 View Posts", callback_data: "list" }],
        [{ text: "📢 Broadcast", callback_data: "broadcast" }],
        [{ text: "📊 Stats", callback_data: "stats" }],
        [
          { text: "⏸ Pause", callback_data: "pause" },
          { text: "▶ Resume", callback_data: "resume" }
        ]
      ]
    }
  });
});

// ===== BUTTON ACTION =====
bot.on("callback_query", async (q) => {
  if (!ADMIN_IDS.includes(q.from.id)) return;

  const msg = q.message;

  const messages = {
    schedule: "Use:\n/schedule 19:01 Hello",
    daily: "Use:\n/daily 09:00 Good Morning",
    media: "Send photo/video with caption:\n/daily 19:00 Message",
    broadcast: "Use:\n/broadcast message"
  };

  if (messages[q.data]) {
    bot.sendMessage(msg.chat.id, messages[q.data]);
  }

  if (q.data === "list") {
    const posts = await Post.find();
    let text = "📋 POSTS:\n\n";

    posts.forEach(p => {
      text += `ID: ${p._id}\n`;
      text += p.daily
        ? `Daily: ${p.hour}:${p.minute}\n`
        : `One-time\n`;
      text += `Type: ${p.type}\nMsg: ${p.text}\n\n`;
    });

    bot.sendMessage(msg.chat.id, text || "No posts");
  }

  if (q.data === "stats") {
    const users = await Chat.countDocuments();
    const posts = await Post.countDocuments();
    bot.sendMessage(msg.chat.id, `📊 Users: ${users}\nPosts: ${posts}`);
  }

  if (q.data === "pause") {
    isPaused = true;
    bot.sendMessage(msg.chat.id, "⏸ Paused");
  }

  if (q.data === "resume") {
    isPaused = false;
    bot.sendMessage(msg.chat.id, "▶ Resumed");
  }

  bot.answerCallbackQuery(q.id);
});

// ===== DAILY TEXT =====
bot.onText(/\/daily (\d{2}):(\d{2}) (.+)/, async (msg, m) => {
  if (!isAdmin(msg)) return;

  let [_, hour, minute, text] = m;
  hour = parseInt(hour);
  minute = parseInt(minute);

  const post = await Post.create({
    chatId: msg.chat.id,
    type: "text",
    text,
    daily: true,
    hour,
    minute
  });

  schedule.scheduleJob(post._id.toString(), {
    hour,
    minute,
    tz: "Asia/Kolkata"
  }, async () => sendPost(post));

  bot.sendMessage(msg.chat.id, `🔁 Daily set ID: ${post._id}`);
});

// ===== SCHEDULE TEXT =====
bot.onText(/\/schedule (\d{2}):(\d{2}) (.+)/, async (msg, m) => {
  if (!isAdmin(msg)) return;

  let [_, hour, minute, text] = m;
  hour = parseInt(hour);
  minute = parseInt(minute);

  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );

  const date = new Date(now);
  date.setHours(hour, minute, 0);
  if (date < now) date.setDate(date.getDate() + 1);

  const post = await Post.create({
    chatId: msg.chat.id,
    type: "text",
    text,
    time: date,
    daily: false
  });

  schedule.scheduleJob(post._id.toString(), date, async () => sendPost(post));

  bot.sendMessage(msg.chat.id, `📅 Scheduled ID: ${post._id}`);
});

// ===== MEDIA DAILY =====
bot.on("message", async (msg) => {
  if (!isAdmin(msg)) return;

  if (msg.caption?.startsWith("/daily")) {
    const parts = msg.caption.split(" ");
    const [hour, minute] = parts[1].split(":").map(Number);
    const text = msg.caption.replace(`/daily ${parts[1]}`, "").trim();

    let type = null;
    let fileId = null;

    if (msg.photo) {
      type = "photo";
      fileId = msg.photo[msg.photo.length - 1].file_id;
    } else if (msg.video) {
      type = "video";
      fileId = msg.video.file_id;
    }

    if (!type) return;

    const post = await Post.create({
      chatId: msg.chat.id,
      type,
      fileId,
      text,
      daily: true,
      hour,
      minute
    });

    schedule.scheduleJob(post._id.toString(), {
      hour,
      minute,
      tz: "Asia/Kolkata"
    }, async () => sendPost(post));

    bot.sendMessage(msg.chat.id, `✅ Media daily set ID: ${post._id}`);
  }
});

// ===== SEND POST =====
async function sendPost(p) {
  if (isPaused) return;

  if (p.type === "photo") {
    await bot.sendPhoto(p.chatId, p.fileId, { caption: p.text });
  } else if (p.type === "video") {
    await bot.sendVideo(p.chatId, p.fileId, { caption: p.text });
  } else {
    await bot.sendMessage(p.chatId, p.text);
  }
}

// ===== DELETE =====
bot.onText(/\/delete (.+)/, async (msg, m) => {
  if (!isAdmin(msg)) return;

  const id = m[1];
  await Post.findByIdAndDelete(id);

  const job = schedule.scheduledJobs[id];
  if (job) job.cancel();

  bot.sendMessage(msg.chat.id, "❌ Deleted");
});

// ===== BROADCAST =====
bot.onText(/\/broadcast (.+)/, async (msg, m) => {
  if (!isAdmin(msg)) return;

  const chats = await Chat.find();

  for (let c of chats) {
    try {
      await bot.sendMessage(c.chatId, m[1]);
    } catch {}
  }

  bot.sendMessage(msg.chat.id, "📢 Sent");
});

// ===== LOAD JOBS =====
async function loadJobs() {
  const posts = await Post.find();

  posts.forEach(p => {
    if (p.daily) {
      schedule.scheduleJob(p._id.toString(), {
        hour: p.hour,
        minute: p.minute,
        tz: "Asia/Kolkata"
      }, async () => sendPost(p));
    } else {
      schedule.scheduleJob(p._id.toString(), p.time, async () => sendPost(p));
    }
  });

  console.log("🚀 Jobs Loaded");
}
loadJobs();

// ===== EXPRESS SERVER =====
app.get("/", (req, res) => {
  res.send("Bot is running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🌐 Server running on port " + PORT);
});
