console.log("TOKEN:", process.env.BOT_TOKEN);
console.log("MONGO:", process.env.MONGO_URL);

const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const schedule = require("node-schedule");

// ENV
const token = process.env.BOT_TOKEN;
const MONGO = process.env.MONGO_URL;

// 👉 PUT YOUR TELEGRAM USER ID
const ADMIN_ID = 6517248246;

// INIT BOT
const bot = new TelegramBot(token, { polling: true });

// CONNECT DB
mongoose.connect(MONGO);
mongoose.connection.once("open", () => {
  console.log("✅ MongoDB Connected");
});

// SCHEMAS
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

// ADMIN CHECK
function isAdmin(msg) {
  return msg.from.id === ADMIN_ID;
}

// PAUSE FLAG
let isPaused = false;

// SAVE CHAT IDs
bot.on("message", async (msg) => {
  const exists = await Chat.findOne({ chatId: msg.chat.id });
  if (!exists) await Chat.create({ chatId: msg.chat.id });
});

// START
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "🤖 Bot Active (IST Timezone)");
});


// ============================
// 📅 ONE-TIME SCHEDULE (IST)
// ============================
bot.onText(/\/schedule (\d{2}):(\d{2}) (.+)/, async (msg, match) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, "❌ Not authorized");

  let [_, hour, minute, text] = match;

  hour = parseInt(hour);
  minute = parseInt(minute);

  const now = new Date();

  const date = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );

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

  bot.sendMessage(msg.chat.id, `✅ Scheduled (IST)\nID: ${post._id}`);
});


// ============================
// 🔁 DAILY (IST FIXED)
// ============================
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
    hour: hour,
    minute: minute,
    tz: "Asia/Kolkata"
  }, async () => {
    if (isPaused) return;
    await bot.sendMessage(post.chatId, post.text);
  });

  bot.sendMessage(msg.chat.id, `🔁 Daily post set (IST)\nID: ${post._id}`);
});


// ============================
// 📋 LIST POSTS
// ============================
bot.onText(/\/list/, async (msg) => {
  if (!isAdmin(msg)) return;

  const posts = await Post.find();

  if (!posts.length) return bot.sendMessage(msg.chat.id, "No posts");

  let text = "📋 POSTS:\n\n";

  posts.forEach(p => {
    text += `ID: ${p._id}\n`;
    text += `Type: ${p.daily ? "Daily" : "One-time"}\n`;
    text += p.daily
      ? `Time (IST): ${p.hour}:${p.minute}\n`
      : `Date: ${p.time}\n`;
    text += `Msg: ${p.text}\n\n`;
  });

  bot.sendMessage(msg.chat.id, text);
});


// ============================
// ❌ DELETE POST
// ============================
bot.onText(/\/delete (.+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;

  const id = match[1];

  await Post.findByIdAndDelete(id);

  const job = schedule.scheduledJobs[id];
  if (job) job.cancel();

  bot.sendMessage(msg.chat.id, "❌ Post deleted & stopped");
});


// ============================
// 📢 BROADCAST
// ============================
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


// ============================
// 📊 STATS
// ============================
bot.onText(/\/stats/, async (msg) => {
  if (!isAdmin(msg)) return;

  const users = await Chat.countDocuments();
  const posts = await Post.countDocuments();

  bot.sendMessage(msg.chat.id,
    `📊 Stats:\nUsers: ${users}\nPosts: ${posts}`
  );
});


// ============================
// ⏸ PAUSE
// ============================
bot.onText(/\/pause/, (msg) => {
  if (!isAdmin(msg)) return;

  isPaused = true;
  bot.sendMessage(msg.chat.id, "⏸ All posts paused");
});


// ============================
// ▶ RESUME
// ============================
bot.onText(/\/resume/, (msg) => {
  if (!isAdmin(msg)) return;

  isPaused = false;
  bot.sendMessage(msg.chat.id, "▶ Bot resumed");
});


// ============================
// 🔄 LOAD SAVED JOBS (IST)
// ============================
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

  console.log("🚀 All jobs loaded (IST)");
}

loadJobs();
