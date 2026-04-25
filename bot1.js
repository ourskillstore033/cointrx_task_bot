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
mongoose.connection.once("open", () => console.log("✅ MongoDB Connected"));

// ===== SCHEMA =====
const Post = mongoose.model("Post", new mongoose.Schema({
  type: String,
  fileId: String,
  text: String,
  hour: Number,
  minute: Number,
  daily: Boolean
}));

const Chat = mongoose.model("Chat", new mongoose.Schema({
  chatId: Number
}));

// ===== STATE =====
let isPaused = false;
let editState = {}; // { userId: { postId, step } }

// ===== HELPERS =====
const isAdmin = (msg) => ADMIN_IDS.includes(msg.from.id);

// ===== SAVE USERS =====
bot.on("message", async (msg) => {
  if (!msg.chat) return;

  const exists = await Chat.findOne({ chatId: msg.chat.id });
  if (!exists) await Chat.create({ chatId: msg.chat.id });
});

// ===== ADMIN PANEL =====
bot.onText(/\/start/, (msg) => {
  if (!isAdmin(msg)) return;

  bot.sendMessage(msg.chat.id, "🚀 Admin Dashboard", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ Create Daily Text", callback_data: "create_text" }],
        [{ text: "🖼 Create Media Post", callback_data: "create_media" }],
        [{ text: "📋 Manage Posts", callback_data: "manage_posts" }],
        [
          { text: "⏸ Pause", callback_data: "pause" },
          { text: "▶ Resume", callback_data: "resume" }
        ]
      ]
    }
  });
});

// ===== CALLBACK HANDLER =====
bot.on("callback_query", async (q) => {
  const msg = q.message;
  if (!ADMIN_IDS.includes(q.from.id)) return;

  // CREATE TEXT
  if (q.data === "create_text") {
    return bot.sendMessage(msg.chat.id, "Use:\n/daily 09:00 Your message");
  }

  // CREATE MEDIA
  if (q.data === "create_media") {
    return bot.sendMessage(msg.chat.id, "Send media with:\n/daily 09:00 Caption");
  }

  // VIEW POSTS
  if (q.data === "manage_posts") {
    const posts = await Post.find();

    if (!posts.length) return bot.sendMessage(msg.chat.id, "No posts found");

    for (let p of posts) {
      bot.sendMessage(msg.chat.id,
        `🆔 ${p._id}\n⏰ ${p.hour}:${p.minute}\n📄 ${p.text}`,
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

  // EDIT
  if (q.data.startsWith("edit_")) {
    const id = q.data.split("_")[1];
    editState[q.from.id] = { postId: id, step: "text" };

    return bot.sendMessage(msg.chat.id, "✏ Send new message text");
  }

  // DELETE
  if (q.data.startsWith("del_")) {
    const id = q.data.split("_")[1];

    await Post.findByIdAndDelete(id);

    if (schedule.scheduledJobs[id]) {
      schedule.scheduledJobs[id].cancel();
    }

    return bot.sendMessage(msg.chat.id, "❌ Deleted");
  }

  // PAUSE / RESUME
  if (q.data === "pause") {
    isPaused = true;
    return bot.sendMessage(msg.chat.id, "⏸ Bot Paused");
  }

  if (q.data === "resume") {
    isPaused = false;
    return bot.sendMessage(msg.chat.id, "▶ Bot Resumed");
  }

  bot.answerCallbackQuery(q.id);
});

// ===== EDIT FLOW =====
bot.on("message", async (msg) => {
  if (!isAdmin(msg)) return;

  const state = editState[msg.from.id];
  if (!state) return;

  if (state.step === "text") {
    await Post.findByIdAndUpdate(state.postId, { text: msg.text });

    state.step = "time";
    return bot.sendMessage(msg.chat.id, "⏰ Send new time (HH:MM)");
  }

  if (state.step === "time") {
    const match = msg.text.match(/(\d{1,2}):(\d{2})/);
    if (!match) return bot.sendMessage(msg.chat.id, "❌ Invalid time");

    const hour = parseInt(match[1]);
    const minute = parseInt(match[2]);

    await Post.findByIdAndUpdate(state.postId, { hour, minute });

    // Reschedule
    if (schedule.scheduledJobs[state.postId]) {
      schedule.scheduledJobs[state.postId].cancel();
    }

    const updated = await Post.findById(state.postId);
    schedulePost(updated);

    delete editState[msg.from.id];

    return bot.sendMessage(msg.chat.id, "✅ Post updated");
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
    hour,
    minute,
    daily: true
  });

  schedulePost(post);

  bot.sendMessage(msg.chat.id, "✅ Daily text created");
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
      type,
      fileId,
      text,
      hour,
      minute,
      daily: true
    });

    schedulePost(post);

    bot.sendMessage(msg.chat.id, "✅ Media post created");
  }
});

// ===== SCHEDULER =====
function schedulePost(p) {
  schedule.scheduleJob(p._id.toString(), {
    hour: p.hour,
    minute: p.minute,
    tz: "Asia/Kolkata"
  }, () => sendPost(p));
}

// ===== SEND TO ALL USERS =====
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

// ===== SERVER =====
app.get("/", (req, res) => res.send("Bot Running"));
app.listen(process.env.PORT || 3000);
