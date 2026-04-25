const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const schedule = require("node-schedule");
const express = require("express");

// ===== ENV =====
const token = process.env.BOT_TOKEN;
const MONGO = process.env.MONGO_URL;

// ===== ADMIN =====
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
  type: String,
  fileId: String,
  text: String,
  daily: Boolean,
  hour: Number,
  minute: Number
}));

const Chat = mongoose.model("Chat", new mongoose.Schema({
  chatId: Number
}));

// ===== HELPERS =====
const isAdmin = (msg) => ADMIN_IDS.includes(msg.from.id);
let isPaused = false;
let editMode = {}; // userId => postId

// ===== SAVE USERS =====
bot.on("message", async (msg) => {
  const exists = await Chat.findOne({ chatId: msg.chat.id });
  if (!exists) await Chat.create({ chatId: msg.chat.id });
});

// ===== ADMIN PANEL =====
bot.onText(/\/start/, (msg) => {
  if (!isAdmin(msg)) return;

  bot.sendMessage(msg.chat.id, "🚀 Admin Panel", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📅 Daily Text", callback_data: "daily_text" }],
        [{ text: "🖼 Daily Media", callback_data: "daily_media" }],
        [{ text: "📋 View Posts", callback_data: "list" }],
        [{ text: "⏸ Pause", callback_data: "pause" }, { text: "▶ Resume", callback_data: "resume" }]
      ]
    }
  });
});

// ===== BUTTONS =====
bot.on("callback_query", async (q) => {
  if (!ADMIN_IDS.includes(q.from.id)) return;

  const msg = q.message;

  if (q.data === "daily_text") {
    bot.sendMessage(msg.chat.id, "Use:\n/daily 09:00 Hello");
  }

  if (q.data === "daily_media") {
    bot.sendMessage(msg.chat.id, "Send photo/video with caption:\n/daily 09:00 Message");
  }

  if (q.data === "list") {
    const posts = await Post.find();

    if (!posts.length) return bot.sendMessage(msg.chat.id, "No posts");

    for (let p of posts) {
      bot.sendMessage(msg.chat.id,
        `ID: ${p._id}\nTime: ${p.hour}:${p.minute}\nText: ${p.text}`,
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
    bot.sendMessage(msg.chat.id, "✏ Send new text for this post");
  }

  if (q.data.startsWith("del_")) {
    const id = q.data.split("_")[1];

    await Post.findByIdAndDelete(id);

    const job = schedule.scheduledJobs[id];
    if (job) job.cancel();

    bot.sendMessage(msg.chat.id, "❌ Deleted");
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
    type: "text",
    text,
    daily: true,
    hour,
    minute
  });

  schedulePost(post);

  bot.sendMessage(msg.chat.id, "✅ Daily text set");
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

    let type = msg.photo ? "photo" : "video";
    let fileId = msg.photo
      ? msg.photo[msg.photo.length - 1].file_id
      : msg.video.file_id;

    const post = await Post.create({
      type,
      fileId,
      text,
      daily: true,
      hour,
      minute
    });

    schedulePost(post);

    bot.sendMessage(msg.chat.id, "✅ Media daily set");
  }
});

// ===== SCHEDULE =====
function schedulePost(p) {
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

// ===== LOAD JOBS =====
async function loadJobs() {
  const posts = await Post.find();
  posts.forEach(schedulePost);
}
loadJobs();

// ===== EXPRESS =====
app.get("/", (req, res) => res.send("Bot running"));

app.listen(process.env.PORT || 3000);
