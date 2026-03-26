console.log("TOKEN:", process.env.BOT_TOKEN);
console.log("MONGO:", process.env.MONGO_URL);

const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const schedule = require("node-schedule");
const express = require("express");

// ===== ENV =====
const token = process.env.BOT_TOKEN;
const MONGO = process.env.MONGO_URL;

// 👉 PUT YOUR TELEGRAM USER ID
const ADMIN_ID = 6517248246;

// ===== INIT =====
const bot = new TelegramBot(token, { polling: true });
const app = express();

// ===== DB CONNECT =====
mongoose.connect(MONGO);
mongoose.connection.once("open", () => {
  console.log("✅ MongoDB Connected");
});

// ===== SCHEMAS =====
const postSchema = new mongoose.Schema({
  chatId: Number,
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
function isAdmin(msg) {
  return msg.from.id === ADMIN_ID;
}

let isPaused = false;

// ===== STORE CHAT IDs =====
bot.on("message", async (msg) => {
  try {
    const exists = await Chat.findOne({ chatId: msg.chat.id });
    if (!exists) await Chat.create({ chatId: msg.chat.id });
  } catch {}
});

// ===== START + BUTTON UI =====
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "🤖 CoinTRX Control Panel (IST)", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📅 Schedule", callback_data: "schedule" }],
        [{ text: "🔁 Daily", callback_data: "daily" }],
        [{ text: "📋 Posts", callback_data: "list" }],
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

// ===== BUTTON HANDLER =====
bot.on("callback_query", async (q) => {
  const msg = q.message;

  if (q.from.id !== ADMIN_ID) {
    return bot.answerCallbackQuery(q.id, { text: "❌ Not allowed" });
  }

  if (q.data === "schedule") {
    bot.sendMessage(msg.chat.id, "Use:\n/schedule HH:MM message");
  }

  if (q.data === "daily") {
    bot.sendMessage(msg.chat.id, "Use:\n/daily HH:MM message");
  }

  if (q.data === "list") {
    const posts = await Post.find();
    let text = "📋 POSTS:\n\n";

    posts.forEach(p => {
      text += `ID: ${p._id}\n`;
      text += p.daily
        ? `Daily: ${p.hour}:${p.minute}\n`
        : `One-time\n`;
      text += `Msg: ${p.text}\n\n`;
    });

    bot.sendMessage(msg.chat.id, text || "No posts");
  }

  if (q.data === "broadcast") {
    bot.sendMessage(msg.chat.id, "Use:\n/broadcast message");
  }

  if (q.data === "stats") {
    const users = await Chat.countDocuments();
    const posts = await Post.countDocuments();

    bot.sendMessage(msg.chat.id,
      `📊 Users: ${users}\nPosts: ${posts}`
    );
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

// ===== ONE-TIME SCHEDULE (IST) =====
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
    text,
    time: date,
    daily: false
  });

  schedule.scheduleJob(post._id.toString(), date, async () => {
    if (isPaused) return;
    await bot.sendMessage(post.chatId, post.text);
  });

  bot.sendMessage(msg.chat.id, `✅ Scheduled ID: ${post._id}`);
});

// ===== DAILY (IST) =====
bot.onText(/\/daily (\d{2}):(\d{2}) (.+)/, async (msg, m) => {
  if (!isAdmin(msg)) return;

  let [_, hour, minute, text] = m;
  hour = parseInt(hour);
  minute = parseInt(minute);

  const post = await Post.create({
    chatId: msg.chat.id,
    text,
    daily: true,
    hour,
    minute
  });

  schedule.scheduleJob(post._id.toString(), {
    hour,
    minute,
    tz: "Asia/Kolkata"
  }, async () => {
    if (isPaused) return;
    await bot.sendMessage(post.chatId, post.text);
  });

  bot.sendMessage(msg.chat.id, `🔁 Daily ID: ${post._id}`);
});

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
      }, async () => {
        if (isPaused) return;
        await bot.sendMessage(p.chatId, p.text);
      });
    } else {
      schedule.scheduleJob(p._id.toString(), p.time, async () => {
        if (isPaused) return;
        await bot.sendMessage(p.chatId, p.text);
      });
    }
  });

  console.log("🚀 Jobs Loaded");
}

loadJobs();

// ===== EXPRESS SERVER (FOR 24/7) =====
app.get("/", (req, res) => {
  res.send("Bot is running");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🌐 Server running on port " + PORT);
});

// ===== ERROR HANDLER =====
process.on("uncaughtException", (err) => {
  console.log("ERROR:", err);
});
