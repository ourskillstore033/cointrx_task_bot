console.log("TOKEN:", process.env.BOT_TOKEN);
console.log("MONGO:", process.env.MONGO_URL);

const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const schedule = require("node-schedule");

// ENV
const token = process.env.BOT_TOKEN;
const MONGO = process.env.MONGO_URL;

// ADMIN ID (PUT YOUR TELEGRAM ID)
const ADMIN_ID = 6517248246;

// BOT INIT
const bot = new TelegramBot(token, { polling: true });

// CONNECT DB
mongoose.connect(MONGO);
mongoose.connection.once("open", () => {
  console.log("✅ MongoDB Connected");
});

// SCHEMAS
const postSchema = new mongoose.Schema({
  chatId: Number,
  type: String,
  content: Object,
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

// SAVE USERS/GROUPS
bot.on("message", async (msg) => {
  const exists = await Chat.findOne({ chatId: msg.chat.id });
  if (!exists) {
    await Chat.create({ chatId: msg.chat.id });
  }
});

// START
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "🤖 Bot Active!");
});

// SCHEDULE MESSAGE
bot.onText(/\/schedule (\d{2}):(\d{2}) (.+)/, async (msg, match) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, "❌ Not authorized");

  const [_, hour, minute, text] = match;
  const now = new Date();
  const date = new Date();

  date.setHours(hour, minute, 0);

  if (date < now) date.setDate(date.getDate() + 1);

  const post = await Post.create({
    chatId: msg.chat.id,
    type: "text",
    content: { text },
    time: date,
    daily: false
  });

  schedule.scheduleJob(date, async () => {
    if (isPaused) return;
    await bot.sendMessage(msg.chat.id, text);
  });

  bot.sendMessage(msg.chat.id, "✅ Scheduled");
});

// DAILY MESSAGE
bot.onText(/\/daily (\d{2}):(\d{2}) (.+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;

  const [_, hour, minute, text] = match;

  await Post.create({
    chatId: msg.chat.id,
    type: "text",
    content: { text },
    daily: true,
    hour,
    minute
  });

  schedule.scheduleJob(`0 ${minute} ${hour} * * *`, async () => {
    if (isPaused) return;
    await bot.sendMessage(msg.chat.id, text);
  });

  bot.sendMessage(msg.chat.id, "🔁 Daily post set");
});

// LIST POSTS
bot.onText(/\/list/, async (msg) => {
  if (!isAdmin(msg)) return;

  const posts = await Post.find();
  let text = "📋 Scheduled Posts:\n";

  posts.forEach(p => {
    text += `ID: ${p._id} | ${p.daily ? "Daily" : p.time}\n`;
  });

  bot.sendMessage(msg.chat.id, text);
});

// DELETE POST
bot.onText(/\/delete (.+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;

  await Post.findByIdAndDelete(match[1]);
  bot.sendMessage(msg.chat.id, "❌ Deleted");
});

// BROADCAST
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;

  const message = match[1];
  const chats = await Chat.find();

  for (let chat of chats) {
    try {
      await bot.sendMessage(chat.chatId, message);
    } catch (err) {}
  }

  bot.sendMessage(msg.chat.id, "📢 Broadcast sent");
});

// STATS
bot.onText(/\/stats/, async (msg) => {
  if (!isAdmin(msg)) return;

  const users = await Chat.countDocuments();
  const posts = await Post.countDocuments();

  bot.sendMessage(msg.chat.id,
    `📊 Stats:\nUsers: ${users}\nPosts: ${posts}`
  );
});

// PAUSE
bot.onText(/\/pause/, (msg) => {
  if (!isAdmin(msg)) return;

  isPaused = true;
  bot.sendMessage(msg.chat.id, "⏸ Bot paused");
});

// RESUME
bot.onText(/\/resume/, (msg) => {
  if (!isAdmin(msg)) return;

  isPaused = false;
  bot.sendMessage(msg.chat.id, "▶ Bot resumed");
});

// LOAD SAVED POSTS
async function loadJobs() {
  const posts = await Post.find();

  posts.forEach(p => {
    if (p.daily) {
      schedule.scheduleJob(`0 ${p.minute} ${p.hour} * * *`, async () => {
        if (isPaused) return;
        await bot.sendMessage(p.chatId, p.content.text);
      });
    } else {
      schedule.scheduleJob(p.time, async () => {
        if (isPaused) return;
        await bot.sendMessage(p.chatId, p.content.text);
      });
    }
  });

  console.log("🚀 All scheduled jobs loaded");
}

loadJobs();
