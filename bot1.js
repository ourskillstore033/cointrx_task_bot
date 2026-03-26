console.log("TOKEN:", process.env.BOT_TOKEN);
console.log("MONGO:", process.env.MONGO_URL);

const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const schedule = require("node-schedule");

// ===== ENV =====
const token = process.env.BOT_TOKEN;
const MONGO = process.env.MONGO_URL;

// 👉 PUT YOUR TELEGRAM USER ID (NUMBER ONLY)
const ADMIN_ID = 6517248246;

// ===== INIT =====
const bot = new TelegramBot(token, { polling: true });

// ===== DB CONNECT =====
mongoose.connect(MONGO);
mongoose.connection.once("open", () => {
  console.log("✅ MongoDB Connected");
});

// ===== SCHEMAS =====
const postSchema = new mongoose.Schema({
  chatId: Number,
  text: String,
  time: Date,      // for one-time
  daily: Boolean,  // true/false
  hour: Number,    // for daily (IST)
  minute: Number   // for daily (IST)
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

// ===== STORE CHAT IDS =====
bot.on("message", async (msg) => {
  try {
    const exists = await Chat.findOne({ chatId: msg.chat.id });
    if (!exists) await Chat.create({ chatId: msg.chat.id });
  } catch {}
});

// ===== START + UI =====
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "🤖 CoinTRX Control Panel (IST)", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📅 Schedule Post", callback_data: "schedule" }],
        [{ text: "🔁 Daily Post", callback_data: "daily" }],
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

// ===== BUTTON HANDLER =====
bot.on("callback_query", async (query) => {
  const msg = query.message;
  const data = query.data;

  if (query.from.id !== ADMIN_ID) {
    return bot.answerCallbackQuery(query.id, { text: "❌ Not allowed" });
  }

  if (data === "schedule") {
    await bot.sendMessage(msg.chat.id, "📅 Use:\n/schedule HH:MM message\nExample: /schedule 19:01 Hello 🚀");
  }

  if (data === "daily") {
    await bot.sendMessage(msg.chat.id, "🔁 Use:\n/daily HH:MM message\nExample: /daily 09:00 Good Morning ☀️");
  }

  if (data === "list") {
    const posts = await Post.find();
    if (!posts.length) {
      await bot.sendMessage(msg.chat.id, "No posts found");
    } else {
      let text = "📋 POSTS:\n\n";
      posts.forEach(p => {
        text += `ID: ${p._id}\n`;
        text += p.daily
          ? `Daily (IST): ${String(p.hour).padStart(2,"0")}:${String(p.minute).padStart(2,"0")}\n`
          : `One-time: ${p.time}\n`;
        text += `Msg: ${p.text}\n\n`;
      });
      await bot.sendMessage(msg.chat.id, text);
    }
  }

  if (data === "broadcast") {
    await bot.sendMessage(msg.chat.id, "📢 Use:\n/broadcast your message");
  }

  if (data === "stats") {
    const users = await Chat.countDocuments();
    const posts = await Post.countDocuments();
    await bot.sendMessage(msg.chat.id, `📊 Stats:\nUsers: ${users}\nPosts: ${posts}`);
  }

  if (data === "pause") {
    isPaused = true;
    await bot.sendMessage(msg.chat.id, "⏸ All posts paused");
  }

  if (data === "resume") {
    isPaused = false;
    await bot.sendMessage(msg.chat.id, "▶ Bot resumed");
  }

  bot.answerCallbackQuery(query.id);
});

// ===== ONE-TIME SCHEDULE (IST) =====
bot.onText(/\/schedule (\d{2}):(\d{2}) (.+)/, async (msg, match) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, "❌ Not authorized");

  let [_, hour, minute, text] = match;
  hour = parseInt(hour);
  minute = parseInt(minute);

  const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const date = new Date(nowIST);

  date.setHours(hour, minute, 0);

  if (date < nowIST) date.setDate(date.getDate() + 1);

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

  bot.sendMessage(msg.chat.id, `✅ Scheduled (IST)\nID: ${post._id}`);
});

// ===== DAILY (IST) =====
bot.onText(/\/daily (\d{2}):(\d{2}) (.+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;

  let [_, hour, minute, text] = match;
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

  bot.sendMessage(msg.chat.id, `🔁 Daily post set (IST)\nID: ${post._id}`);
});

// ===== DELETE =====
bot.onText(/\/delete (.+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;

  const id = match[1];
  await Post.findByIdAndDelete(id);

  const job = schedule.scheduledJobs[id];
  if (job) job.cancel();

  bot.sendMessage(msg.chat.id, "❌ Post deleted & stopped");
});

// ===== BROADCAST =====
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;

  const message = match[1];
  const chats = await Chat.find();

  for (let chat of chats) {
    try {
      await bot.sendMessage(chat.chatId, message);
    } catch {}
  }

  bot.sendMessage(msg.chat.id, "📢 Broadcast sent");
});

// ===== STATS =====
bot.onText(/\/stats/, async (msg) => {
  if (!isAdmin(msg)) return;

  const users = await Chat.countDocuments();
  const posts = await Post.countDocuments();

  bot.sendMessage(msg.chat.id, `📊 Stats:\nUsers: ${users}\nPosts: ${posts}`);
});

// ===== PAUSE / RESUME =====
bot.onText(/\/pause/, (msg) => {
  if (!isAdmin(msg)) return;
  isPaused = true;
  bot.sendMessage(msg.chat.id, "⏸ All posts paused");
});

bot.onText(/\/resume/, (msg) => {
  if (!isAdmin(msg)) return;
  isPaused = false;
  bot.sendMessage(msg.chat.id, "▶ Bot resumed");
});

// ===== LOAD SAVED JOBS =====
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

  console.log("🚀 Jobs loaded (IST)");
}

loadJobs();

// ===== GLOBAL ERROR HANDLER =====
process.on("uncaughtException", (err) => {
  console.log("ERROR:", err);
});
