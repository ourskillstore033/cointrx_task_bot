# 🚀 Telegram Bot Control Center

An advanced Telegram bot system with web dashboard, Mario platformer game, and comprehensive post management.

---

## ✨ FEATURES

### Original Features (All Preserved)
✅ **Schedule Posts** - One-time posts at specific times  
✅ **Daily Posts** - Recurring posts every day  
✅ **Media Daily** - Schedule photos/videos with captions  
✅ **View All Posts** - List, edit, delete posts  
✅ **Broadcast** - Send messages to all users  
✅ **Pause/Resume** - Control bot operation  

### NEW Features Added
✨ **User Management**
- Track total users, active users, blocked users
- Auto-remove blocked users from broadcasts
- User tags and segmentation

✨ **Post Analytics**
- Track sent/failed counts per post
- Monitor delivery time metrics
- Historical broadcast statistics
- Post creation timestamps

✨ **Templates System**
- Save message templates for reuse
- Quick template access from control panel

✨ **Broadcast Enhancements**
- Tag-based user targeting (#vip, #announcements, etc.)
- Rate limiting to prevent Telegram flood bans
- Detailed send/fail statistics
- Delivery time tracking

✨ **Audit Logging**
- Track all admin actions
- Timestamps for compliance
- Detailed action history

✨ **Web Dashboard**
- Beautiful retro-arcade UI
- Real-time bot statistics
- Post management interface
- User analytics
- Playable Mario platformer game (Easter egg!)

✨ **Better Error Handling**
- Graceful failure handling
- Automatic cleanup of expired posts
- Webhook support ready
- Connection retry logic

✨ **REST API Endpoints**
- `/api/stats` - Current bot statistics
- `/api/posts` - Recent scheduled posts
- `/api/analytics` - Broadcast analytics
- `/health` - Server health check

---

## 🎮 MARIO GAME

A retro-style platformer built into the dashboard!

**How to Play:**
- **← →** Arrow Keys to move
- **↑ / SPACE** to jump
- **Collect coins** for points
- **Jump on enemies** to defeat them
- **Reach the flag** to level up
- **Avoid falls** - you have 3 lives

**Scoring:**
- Coin: +100 points
- Enemy defeated: +500 points
- High scores saved locally

---

## 📋 BOT COMMANDS

### Admin Commands

#### Schedule Posts
```
/schedule HH:MM Message text here
```
Example: `/schedule 19:00 Good evening everyone!`

#### Daily Text Posts
```
/daily HH:MM Message text here
```
Example: `/daily 09:00 Good morning!`

#### Daily Media (Photo/Video)
Send photo or video with caption:
```
/daily HH:MM Caption text
```

#### Broadcast to All Users
```
/broadcast Message to send
```
With tags:
```
/broadcast #vip #important Special offer for VIP members!
```

#### View Control Panel
```
/start
```
Shows interactive button menu

#### Edit Posts
- Click "View Posts" in `/start` menu
- Click "✏ Edit" on any post
- Update text and/or time

#### Delete Posts
- Click "View Posts" in `/start` menu
- Click "❌ Delete" to remove

#### Pause Bot
- Click "⏸ Pause" in `/start` menu
- Posts will not be sent until resumed

#### Resume Bot
- Click "▶ Resume" in `/start` menu
- Posts will resume sending

---

## 🔧 INSTALLATION

### Prerequisites
- Node.js 14+
- MongoDB
- Telegram Bot Token (from @BotFather)

### Step 1: Install Dependencies
```bash
npm install telegram-bot-api mongoose schedule express body-parser
```

### Step 2: Environment Variables
Create `.env` file:
```
BOT_TOKEN=your_telegram_bot_token
MONGO_URL=mongodb+srv://user:pass@cluster.mongodb.net/botdb
PORT=3000
WEBHOOK_SECRET=your_random_secret_key
```

### Step 3: Run Bot
```bash
node bot-advanced.js
```

### Step 4: Serve Dashboard
Serve `dashboard.html` via Express or any static server:

```javascript
app.use(express.static('public'));
app.get('/dashboard', (req, res) => res.sendFile('dashboard.html'));
```

Or open `dashboard.html` locally in browser.

### Step 5: Test
1. Start bot in Telegram: `/start`
2. Open dashboard in browser: `http://localhost:3000/dashboard`
3. Play game: Click "GAME" tab
4. Send test post: `/schedule 12:00 Test message`

---

## 📊 DASHBOARD TABS

### 🎮 GAME
- Playable Mario platformer
- Real-time score tracking
- Lives/health display
- Level progression

### 📊 DASHBOARD
- Bot statistics (users, posts, blocked)
- Recent broadcast stats
- Server uptime counter
- Quick action buttons

### 📋 POSTS
- List all scheduled posts
- Display post type (text/photo/video)
- Show sent/failed counts
- Quick edit/delete buttons

### 📢 BROADCAST
- Compose broadcast messages
- Optional tag targeting
- Send to all or specific segments
- Delivery confirmation

### 👥 USERS
- Total user count
- Active users (last 7 days)
- Inactive users
- Blocked user tracking

---

## 🗄️ DATABASE SCHEMAS

### Post
```javascript
{
  chatId: Number,
  type: "text" | "photo" | "video",
  fileId: String,
  text: String,
  time: Date,              // One-time posts
  daily: Boolean,
  hour: Number,            // Daily posts
  minute: Number,
  tags: [String],
  templateName: String,
  createdAt: Date,
  sentCount: Number,
  failCount: Number
}
```

### Chat
```javascript
{
  chatId: Number,
  firstName: String,
  username: String,
  joinedAt: Date,
  tags: [String],
  blocked: Boolean,
  lastReceived: Date
}
```

### Analytics
```javascript
{
  postId: ObjectId,
  sentAt: Date,
  successCount: Number,
  failCount: Number,
  avgDeliveryMs: Number
}
```

### Audit
```javascript
{
  adminId: Number,
  action: String,
  details: Object,
  timestamp: Date
}
```

---

## 🔐 SECURITY FEATURES

✅ Admin ID whitelist  
✅ Automatic blocked user removal  
✅ Audit logging of all actions  
✅ Rate limiting on broadcasts  
✅ Flood-safe delays (1000ms / rate limit)  
✅ Error isolation (failures don't crash bot)  
✅ Connection retry with timeouts  
✅ Webhook secret support  

---

## ⚙️ ADVANCED CONFIG

### Rate Limiting
Edit `BROADCAST_RATE_LIMIT` in `bot-advanced.js`:
```javascript
const BROADCAST_RATE_LIMIT = 50; // messages per second
```

### Auto-Cleanup
Expired one-time posts auto-delete after 30 days:
```javascript
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
```

### Timezone
Default is Asia/Kolkata. Change in code:
```javascript
const TIMEZONE = "America/New_York";
```

---

## 📈 MONITORING

### Health Check Endpoint
```bash
curl http://localhost:3000/health
```

### Bot Stats API
```bash
curl http://localhost:3000/api/stats
```

### Posts List
```bash
curl http://localhost:3000/api/posts
```

### Analytics History
```bash
curl http://localhost:3000/api/analytics
```

---

## 🐛 TROUBLESHOOTING

**Bot not responding?**
- Check `BOT_TOKEN` in .env
- Ensure MongoDB is connected
- Check bot is not paused

**Posts not sending?**
- Verify users haven't blocked bot
- Check time zone is correct
- See audit log for errors

**Dashboard not loading?**
- Ensure Express server is running
- Check port 3000 is available
- Clear browser cache

**Game not working?**
- Use modern browser (Chrome, Firefox, Safari)
- Ensure JavaScript is enabled
- Check console for errors

---

## 📝 USAGE EXAMPLES

### Example 1: Daily Morning Greeting
```
/daily 08:00 Good morning! 🌅 Have a productive day!
```

### Example 2: One-time Announcement
```
/schedule 14:30 🔔 New feature release at 15:00!
```

### Example 3: Targeted Broadcast (VIP only)
```
/broadcast #vip Exclusive offer: 50% off for VIP members! 🎁
```

### Example 4: Media Post
Send an image with caption:
```
/daily 19:00 Sunset photo of the day! 🌄
```

### Example 5: Emergency Pause
In Telegram: Click `/start` → Click `⏸ Pause`
(No posts will send until resumed)

---

## 🎯 ROADMAP (Future Features)

- [ ] User preferences (opt-in/out channels)
- [ ] Message templates with variables
- [ ] A/B testing for broadcasts
- [ ] Webhook integration
- [ ] Redis caching for performance
- [ ] Multi-language support
- [ ] Admin role management
- [ ] Advanced game with leaderboards
- [ ] Export analytics to CSV
- [ ] Scheduled maintenance windows

---

## 📄 LICENSE

Free to use and modify.

---

## 🤝 SUPPORT

For issues:
1. Check MongoDB connection
2. Verify Telegram token
3. Review audit logs
4. Check browser console
5. Enable verbose logging

---

**Built with ❤️ for Telegram automation**  
Last Updated: April 2026
