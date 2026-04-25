const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const schedule = require("node-schedule");
const express = require("express");

// ===== ENV =====
const token = process.env.BOT_TOKEN;
const MONGO = process.env.MONGO_URL;

// ===== ADMINS =====
const ADMIN_IDS = [6517248246, 7419362470, 8530664171];

// ===== INIT =====
const bot = new TelegramBot(token, { polling: true });
const app = express();

// ===== DB =====
mongoose.connect(MONGO);
mongoose.connection.once("open", () => {
  console.log("✅ MongoDB Connected");
});

// ===== SCHEMA =====
const Post = mongoose.model("Post", new mongoose.Schema({
  chatId: Number,
  type: String,
  fileId: String,
  text: String,
  time: Date,
  daily: Boolean,
  hour: Number,
  minute: Number
}));

const Chat = mongoose.model("Chat", new mongoose.Schema({
  chatId: Number
}));

// ===== STATE =====
let isPaused = false;
let editMode = {}; // userId -> postId

// ===== HELPERS =====
const isAdmin = (msg) => ADMIN_IDS.includes(msg.from.id);

// ===== SAVE USERS =====
bot.on("message", async (msg) => {
  try {
    const exists = await Chat.findOne({ chatId: msg.chat.id });
    if (!exists) await Chat.create({ chatId: msg.chat.id });
  } catch {}
});

// ===== START PANEL =====
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "🚀 Control Panel", {
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

// ===== CALLBACK =====
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

    if (!posts.length) {
      return bot.sendMessage(msg.chat.id, "No posts found");
    }

    for (let p of posts) {
      bot.sendMessage(msg.chat.id,
        `ID: ${p._id}\n${p.daily ? `Daily: ${p.hour}:${p.minute}` : "One-time"}\n${p.text}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✏ Edit", callback_data: `edit_${p._id}` },
                { text: "❌ Delete", callback_data: `del_${p._id}` }
              ]
            ]
          }
        }
      );
    }
  }

  if (q.data.startsWith("edit_")) {
    const id = q.data.split("_")[1];
    editMode[q.from.id] = id;
    bot.sendMessage(msg.chat.id, "✏ Send new message text");
  }

  if (q.data.startsWith("del_")) {
    const id = q.data.split("_")[1];

    await Post.findByIdAndDelete(id);

    const job = schedule.scheduledJobs[id];
    if (job) job.cancel();

    bot.sendMessage(msg.chat.id, "❌ Deleted");
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

// ===== EDIT HANDLER =====
bot.on("message", async (msg) => {
  if (!isAdmin(msg)) return;

  if (editMode[msg.from.id]) {
    const postId = editMode[msg.from.id];

    await Post.findByIdAndUpdate(postId, { text: msg.text });

    editMode[msg.from.id] = null;

    bot.sendMessage(msg.chat.id, "✅ Post updated");
  }
});

// ===== DAILY TEXT =====
bot.onText(/\/daily (\d{1,2}):(\d{2}) (.+)/, async (msg, m) => {
  if (!isAdmin(msg)) return;

  const hour = parseInt(m[1]);
  const minute = parseInt(m[2]);
  const text = m[3];

  const post = await Post.create({
    chatId: msg.chat.id,
    type: "text",
    text,
    daily: true,
    hour,
    minute
  });

  scheduleDaily(post);

  bot.sendMessage(msg.chat.id, "✅ Daily text set");
});

// ===== SCHEDULE TEXT =====
bot.onText(/\/schedule (\d{2}):(\d{2}) (.+)/, async (msg, m) => {
  if (!isAdmin(msg)) return;

  let hour = parseInt(m[1]);
  let minute = parseInt(m[2]);
  let text = m[3];

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

  schedule.scheduleJob(post._id.toString(), date, () => sendPost(post));

  bot.sendMessage(msg.chat.id, "📅 Scheduled");
});

// ===== MEDIA DAILY =====
bot.on("message", async (msg) => {
  if (!isAdmin(msg)) return;

  if (msg.caption && msg.caption.startsWith("/daily") && (msg.photo || msg.video)) {

    const match = msg.caption.match(/\/daily (\d{1,2}):(\d{2}) (.+)/);
    if (!match) return;

    const hour = parseInt(match[1]);
    const minute = parseInt(match[2]);
    const text = match[3];

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
      minute
    });

    scheduleDaily(post);

    bot.sendMessage(msg.chat.id, "✅ Media daily set");
  }
});

// ===== SCHEDULE DAILY =====
function scheduleDaily(p) {
  schedule.scheduleJob(p._id.toString(), {
    hour: p.hour,
    minute: p.minute,
    tz: "Asia/Kolkata"
  }, () => sendPost(p));
}

// ===== SEND =====
async function sendPost(p) {
  if (isPaused) return;

  const users = await Chat.find();

  for (let u of users) {
    try {
      if (p.type === "photo") {
        await bot.sendPhoto(u.chatId, p.fileId, { caption: p.text });
      } else if (p.type === "video") {
        await bot.sendVideo(u.chatId, p.fileId, { caption: p.text });
      } else {
        await bot.sendMessage(u.chatId, p.text);
      }
    } catch {}
  }
}

// ===== BROADCAST =====
bot.onText(/\/broadcast (.+)/, async (msg, m) => {
  if (!isAdmin(msg)) return;

  const users = await Chat.find();

  for (let u of users) {
    try {
      await bot.sendMessage(u.chatId, m[1]);
    } catch {}
  }

  bot.sendMessage(msg.chat.id, "📢 Sent");
});

// ===== LOAD JOBS =====
async function loadJobs() {
  const posts = await Post.find();

  posts.forEach(p => {
    if (p.daily) scheduleDaily(p);
    else if (p.time) {
      schedule.scheduleJob(p._id.toString(), p.time, () => sendPost(p));
    }
  });
}
loadJobs();

// ===== SERVER =====
app.get("/", (req, res) => res.send("Bot running"));
app.listen(process.env.PORT || 3000);
