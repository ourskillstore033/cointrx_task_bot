const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const schedule = require("node-schedule");
const express = require("express");

// ===== ENV & CONFIG =====
const token = process.env.BOT_TOKEN;
const MONGO = process.env.MONGO_URL;
const ADMIN_IDS = [6517248246, 7419362470, 8530664171];
const TIMEZONE = "Asia/Kolkata";

// ===== INIT =====
const bot = new TelegramBot(token, { polling: true });
const app = express();

// ===== DB CONNECTION =====
mongoose.connect(MONGO, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ DB Error:", err));

// ===== SCHEMAS =====
const PostSchema = new mongoose.Schema({
  chatId: Number,
  type: { type: String, enum: ['text', 'photo', 'video'], default: 'text' },
  fileId: String,
  text: String,
  time: Date,
  daily: { type: Boolean, default: false },
  hour: Number,
  minute: Number,
  status: { type: String, default: 'active' }
});

const ChatSchema = new mongoose.Schema({
  chatId: { type: Number, unique: true },
  username: String,
  joinedAt: { type: Date, default: Date.now }
});

const Post = mongoose.model("Post", PostSchema);
const Chat = mongoose.model("Chat", ChatSchema);

// ===== STATE & MIDDLEWARE =====
let isPaused = false;
let editState = {}; 

const isAdmin = (userId) => ADMIN_IDS.includes(userId);

// Rate-limited sender to avoid Telegram bans
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function smartSend(chatId, p) {
  if (isPaused) return;
  try {
    if (p.type === "photo") return await bot.sendPhoto(chatId, p.fileId, { caption: p.text });
    if (p.type === "video") return await bot.sendVideo(chatId, p.fileId, { caption: p.text });
    return await bot.sendMessage(chatId, p.text);
  } catch (err) {
    if (err.response && err.response.statusCode === 403) {
      // User blocked the bot, remove them
      await Chat.deleteOne({ chatId });
    }
  }
}

// ===== CORE LOGIC =====

// Save New Users & Auto-cleanup
bot.on("message", async (msg) => {
  if (msg.chat.type !== 'private') return;
  try {
    await Chat.findOneAndUpdate(
      { chatId: msg.chat.id },
      { username: msg.from.username },
      { upsert: true }
    );
  } catch (e) {}
});

// Main Panel
bot.onText(/\/start/, (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "👋 Hello! Subscribe for updates.");
  
  bot.sendMessage(msg.chat.id, "🛠 **Admin Control Panel**\nStatus: " + (isPaused ? "⏸ Paused" : "▶ Running"), {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📅 Schedule Once", callback_data: "schedule" }, { text: "🔁 Daily Text", callback_data: "daily" }],
        [{ text: "🖼 Daily Media", callback_data: "media" }, { text: "📢 Broadcast", callback_data: "broadcast" }],
        [{ text: "📋 Manage Posts", callback_data: "list" }, { text: "📊 Live Stats", callback_data: "stats" }],
        [
          { text: isPaused ? "▶ Resume Bot" : "⏸ Pause Bot", callback_data: "toggle_pause" }
        ]
      ]
    }
  });
});

// ===== CALLBACK HANDLER =====
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  if (!isAdmin(q.from.id)) return bot.answerCallbackQuery(q.id, { text: "Unauthorized" });

  if (q.data === "toggle_pause") {
    isPaused = !isPaused;
    bot.editMessageText(`Bot is now ${isPaused ? "Paused" : "Running"}`, {
      chat_id: chatId,
      message_id: q.message.message_id,
      reply_markup: { inline_keyboard: [[{ text: "⬅ Back", callback_data: "back_to_start" }]] }
    });
  }

  if (q.data === "list") {
    const posts = await Post.find().limit(10);
    if (!posts.length) return bot.sendMessage(chatId, "📭 No scheduled posts.");
    
    for (let p of posts) {
      const typeIcon = p.type === 'text' ? '📝' : '🖼';
      bot.sendMessage(chatId, `${typeIcon} **ID:** \`${p._id}\`\n**Timing:** ${p.daily ? `Daily at ${p.hour}:${p.minute}` : p.time}\n**Content:** ${p.text || '[Media]'}`, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "✏ Edit", callback_data: `edit_${p._id}` },
            { text: "🗑 Delete", callback_data: `del_${p._id}` }
          ]]
        }
      });
    }
  }

  if (q.data === "stats") {
    const userCount = await Chat.countDocuments();
    const postCount = await Post.countDocuments();
    bot.answerCallbackQuery(q.id);
    bot.sendMessage(chatId, `📈 **Live Statistics**\n\n👥 Total Subscribers: ${userCount}\n📅 Active Schedules: ${postCount}\n⏳ System Status: Online`, { parse_mode: "Markdown" });
  }

  if (q.data.startsWith("del_")) {
    const id = q.data.split("_")[1];
    await Post.findByIdAndDelete(id);
    if (schedule.scheduledJobs[id]) schedule.scheduledJobs[id].cancel();
    bot.answerCallbackQuery(q.id, { text: "Post Deleted" });
    bot.deleteMessage(chatId, q.message.message_id);
  }
  
  bot.answerCallbackQuery(q.id);
});

// ===== BROADCAST ENGINE (UPGRADED) =====
bot.onText(/\/broadcast/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  
  const text = msg.text.replace("/broadcast ", "");
  if (!text || text === "/broadcast") return bot.sendMessage(msg.chat.id, "❌ Usage: `/broadcast Your message here`", { parse_mode: "Markdown" });

  const users = await Chat.find();
  bot.sendMessage(msg.chat.id, `🚀 Starting broadcast to ${users.length} users...`);

  let success = 0;
  for (const user of users) {
    const res = await smartSend(user.chatId, { type: 'text', text });
    if (res) success++;
    await sleep(50); // Prevent hitting 30 msg/sec limit
  }

  bot.sendMessage(msg.chat.id, `✅ **Broadcast Complete**\nSent to: ${success}/${users.length} active users.`, { parse_mode: "Markdown" });
});

// ===== SCHEDULING HELPERS =====
function scheduleDaily(p) {
  schedule.scheduleJob(p._id.toString(), { hour: p.hour, minute: p.minute, tz: TIMEZONE }, () => broadcastToAll(p));
}

async function broadcastToAll(p) {
  const users = await Chat.find();
  for (const user of users) {
    await smartSend(user.chatId, p);
    await sleep(50);
  }
}

// Initial Load
(async () => {
  const posts = await Post.find();
  posts.forEach(p => {
    if (p.daily) scheduleDaily(p);
    else if (p.time && p.time > new Date()) {
      schedule.scheduleJob(p._id.toString(), p.time, () => broadcastToAll(p));
    }
  });
  console.log(`📡 Loaded ${posts.length} jobs into memory.`);
})();

// Health Check Server
app.get("/", (req, res) => res.status(200).json({ status: "running", paused: isPaused }));
app.listen(process.env.PORT || 3000);
