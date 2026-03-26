console.log("TOKEN:", process.env.BOT_TOKEN);
console.log("MONGO:", process.env.MONGO_URL);

const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');
const mongoose = require('mongoose');

// ENV VARIABLES
const token = process.env.BOT_TOKEN;
const MONGO = process.env.MONGO_URL;

// BOT INIT
const bot = new TelegramBot(token, { polling: true });

// CONNECT MONGODB
mongoose.connect(MONGO);

mongoose.connection.once('open', () => {
  console.log("✅ MongoDB Connected");
});

// SCHEMA
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

// TEMP STORAGE
let tempContent = {};

// STORE ACTIVE JOBS
global.jobs = {};

// 📩 CAPTURE CONTENT
bot.on('message', (msg) => {
  if (msg.text && msg.text.startsWith("/")) return;

  tempContent[msg.chat.id] = msg;

  bot.sendMessage(msg.chat.id,
    "✅ Content saved.\n\nUse:\n/schedule YYYY-MM-DD HH:MM\n/daily HH:MM"
  );
});

// 📅 ONE-TIME SCHEDULE
bot.onText(/\/schedule (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;

  if (!tempContent[chatId]) {
    return bot.sendMessage(chatId, "❌ Send content first");
  }

  const time = new Date(match[1]);

  const post = await Post.create({
    chatId,
    type: getType(tempContent[chatId]),
    content: tempContent[chatId],
    time,
    daily: false
  });

  scheduleJob(post);

  bot.sendMessage(chatId, `📅 Scheduled!\nID: ${post._id}`);
});

// ⏱ DAILY SCHEDULE
bot.onText(/\/daily (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;

  if (!tempContent[chatId]) {
    return bot.sendMessage(chatId, "❌ Send content first");
  }

  const [hour, minute] = match[1].split(":");

  const post = await Post.create({
    chatId,
    type: getType(tempContent[chatId]),
    content: tempContent[chatId],
    time: new Date(),
    daily: true,
    hour: parseInt(hour),
    minute: parseInt(minute)
  });

  scheduleDaily(post);

  bot.sendMessage(chatId, `⏱ Daily post set!\nID: ${post._id}`);
});

// 📋 LIST POSTS
bot.onText(/\/list/, async (msg) => {
  const posts = await Post.find({ chatId: msg.chat.id });

  if (!posts.length) {
    return bot.sendMessage(msg.chat.id, "📭 No scheduled posts");
  }

  let text = "📋 Scheduled Posts:\n\n";

  posts.forEach(p => {
    text += `ID: ${p._id}\n`;
    text += p.daily
      ? `Type: Daily at ${p.hour}:${p.minute}\n`
      : `Time: ${p.time}\n`;
    text += "-------------------\n";
  });

  bot.sendMessage(msg.chat.id, text);
});

// ❌ DELETE POST
bot.onText(/\/delete (.+)/, async (msg, match) => {
  const id = match[1];

  await Post.findByIdAndDelete(id);

  if (global.jobs[id]) {
    global.jobs[id].cancel();
  }

  bot.sendMessage(msg.chat.id, "❌ Deleted successfully");
});

// 🔧 HELPER FUNCTIONS

function getType(msg) {
  if (msg.text) return "text";
  if (msg.photo) return "photo";
  if (msg.video) return "video";
}

// 📅 SCHEDULE ONCE
function scheduleJob(post) {
  const job = schedule.scheduleJob(post.time, () => {
    sendPost(post);
  });

  global.jobs[post._id] = job;
}

// ⏱ DAILY
function scheduleDaily(post) {
  const job = schedule.scheduleJob(
    { hour: post.hour, minute: post.minute },
    () => sendPost(post)
  );

  global.jobs[post._id] = job;
}

// 📤 SEND CONTENT
function sendPost(post) {
  const msg = post.content;

  if (post.type === "text") {
    bot.sendMessage(post.chatId, msg.text);
  }

  else if (post.type === "photo") {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    bot.sendPhoto(post.chatId, fileId, {
      caption: msg.caption || ""
    });
  }

  else if (post.type === "video") {
    bot.sendVideo(post.chatId, msg.video.file_id, {
      caption: msg.caption || ""
    });
  }
}

// 🔄 LOAD ALL JOBS ON START
async function loadJobs() {
  const posts = await Post.find();

  posts.forEach(p => {
    if (p.daily) scheduleDaily(p);
    else scheduleJob(p);
  });

  console.log("🚀 All scheduled jobs loaded");
}

loadJobs();
