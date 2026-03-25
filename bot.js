// ============================================================
// ТуДУрка Bot — Telegram бот + Claude AI
// ============================================================
// npm install node-telegram-bot-api @anthropic-ai/sdk dotenv
// ============================================================

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://kingtoki.github.io/tudurka/';

// ВАЖНО: allowedUpdates включает edited_message — именно туда
// Telegram Premium присылает транскрипцию голосового
const bot = new TelegramBot(TOKEN, {
  polling: {
    params: {
      allowed_updates: ['message', 'edited_message', 'callback_query']
    }
  }
});

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Голосовые которые ждут транскрипцию { chatId_msgId: { chatId, waitMsgId } }
const pending = new Map();

// ============================================================
// /start
// ============================================================
bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || 'друг';
  bot.sendMessage(msg.chat.id,
    `Привет, ${name}! 👋\n\n🎙️ *Запиши голосовое* — скажи что нужно сделать\n✅ *ИИ разберёт* на задачи автоматически\n📋 *Открой список* кнопкой ниже\n\n✍️ Или просто напиши текст — тоже работает!`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '📋 Открыть ТуДУрку', web_app: { url: MINI_APP_URL } }]] }
  });
});

// ============================================================
// /list
// ============================================================
bot.onText(/\/list/, (msg) => {
  bot.sendMessage(msg.chat.id, '📋 Твой список задач:', {
    reply_markup: { inline_keyboard: [[{ text: '📋 Открыть ТуДУрку', web_app: { url: MINI_APP_URL } }]] }
  });
});

// ============================================================
// Голосовое сообщение
// ============================================================
bot.on('voice', async (msg) => {
  const chatId = msg.chat.id;
  const key = `${chatId}_${msg.message_id}`;

  // Иногда транскрипция уже есть прямо в сообщении
  const immediateText = msg.voice?.transcription?.text;
  if (immediateText) {
    await processText(chatId, immediateText, msg.message_id, false);
    return;
  }

  // Показываем что ждём и сохраняем в pending
  const waitMsg = await bot.sendMessage(chatId, '🎙️ Жду транскрипцию...', {
    reply_to_message_id: msg.message_id
  });

  pending.set(key, { chatId, waitMsgId: waitMsg.message_id });

  // Таймаут 20 секунд — если транскрипция не пришла, предлагаем текст
  setTimeout(() => {
    if (pending.has(key)) {
      pending.delete(key);
      bot.editMessageText(
        '⚠️ Транскрипция не пришла от Telegram.\n\nНапиши задачу *текстом* — я обработаю! ✍️',
        { chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'Markdown' }
      );
    }
  }, 20000);
});

// ============================================================
// edited_message — сюда Telegram Premium присылает транскрипцию
// После отправки голосового Telegram редактирует сообщение
// добавляя поле transcription с готовым текстом
// ============================================================
bot.on('edited_message', async (msg) => {
  if (!msg.voice) return;

  const text = msg.voice?.transcription?.text || msg.voice?.transcription;
  if (!text || typeof text !== 'string') return;

  const key = `${msg.chat.id}_${msg.message_id}`;
  const p = pending.get(key);

  if (p) {
    pending.delete(key);
    // Обновляем сообщение-заглушку
    await bot.editMessageText(`🎙️ _"${text}"_\n\n🤖 Разбираю на задачи...`, {
      chat_id: p.chatId, message_id: p.waitMsgId, parse_mode: 'Markdown'
    });
    await processText(p.chatId, text, p.waitMsgId, true);
  }
});

// ============================================================
// Обычный текст
// ============================================================
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  await processText(msg.chat.id, msg.text, msg.message_id, false);
});

// ============================================================
// Claude AI: текст → задачи
// ============================================================
async function processText(chatId, text, msgId, isEdit) {
  let processingId;

  if (isEdit) {
    processingId = msgId;
  } else {
    const m = await bot.sendMessage(chatId, '🤖 ИИ разбирает на задачи...', {
      reply_to_message_id: msgId
    });
    processingId = m.message_id;
  }

  try {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: `Извлекай задачи из текста пользователя. Отвечай ТОЛЬКО JSON без markdown:
{"tasks":[{"text":"Короткая задача до 70 символов","priority":"high|medium|low"}]}
Правила: задача = конкретное действие, кратко и чётко. high = срочно/важно, medium = обычное, low = когда-нибудь. Не добавляй задач которых нет в тексте.`,
      messages: [{ role: 'user', content: `Извлеки задачи из: "${text}"` }]
    });

    const raw = response.content[0].text.trim();
    let parsed;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : raw);
    } catch(e) {
      parsed = { tasks: [{ text: text.slice(0, 70), priority: 'medium' }] };
    }

    const tasks = (parsed.tasks || []).filter(t => t.text?.trim());
    if (!tasks.length) {
      bot.editMessageText('Не смог извлечь задачи. Попробуй сформулировать иначе.', {
        chat_id: chatId, message_id: processingId
      });
      return;
    }

    const emoji = { high: '🔴', medium: '🟡', low: '🟢' };
    const lines = tasks.map(t => `${emoji[t.priority] || '🟡'} ${t.text}`).join('\n');
    const n = tasks.length;
    const word = n === 1 ? 'задача' : n < 5 ? 'задачи' : 'задач';

    await bot.editMessageText(
      `✅ *${n} ${word} добавлено:*\n\n${lines}`,
      {
        chat_id: chatId,
        message_id: processingId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{
            text: '📋 Открыть ТуДУрку',
            web_app: { url: `${MINI_APP_URL}?tasks=${encodeURIComponent(JSON.stringify(tasks))}` }
          }]]
        }
      }
    );

  } catch(err) {
    console.error('Ошибка:', err.message);
    bot.editMessageText('Ошибка обработки. Попробуй ещё раз.', {
      chat_id: chatId, message_id: processingId
    });
  }
}

console.log('🤖 ТуДУрка Bot запущен!');
console.log('📋 Mini App:', MINI_APP_URL);
