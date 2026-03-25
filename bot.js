// ============================================================
// ТуДУрка Bot — Telegram бот + Claude AI
// ============================================================
// npm install node-telegram-bot-api @anthropic-ai/sdk dotenv
// ============================================================

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MINI_APP_URL = process.env.MINI_APP_URL || 'https://kingtoki.github.io/tudurka/';

// Храним голосовые которые ждут транскрипцию от Telegram Premium
// { messageId: { chatId, waitMsgId, processed } }
const pendingVoice = new Map();

// ============================================================
// /start
// ============================================================
bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || 'друг';
  bot.sendMessage(msg.chat.id,
    `Привет, ${name}! 👋\n\nПросто:\n\n🎙️ *Запиши голосовое* — скажи что нужно сделать\n✅ *Я разберу* на задачи с помощью ИИ\n📋 *Открой список* кнопкой ниже\n\n✍️ Или напиши задачу текстом — тоже работает!`, {
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

  // Транскрипция уже есть в сообщении (иногда приходит сразу)
  const text = msg.voice?.transcription?.text || msg.voice_note_transcription?.text;
  if (text) {
    await processText(chatId, text, msg.message_id);
    return;
  }

  // Транскрипция придёт позже через edited_message — ждём
  const waitMsg = await bot.sendMessage(chatId, '🎙️ Жду транскрипцию от Telegram...', {
    reply_to_message_id: msg.message_id
  });

  pendingVoice.set(`${chatId}_${msg.message_id}`, {
    chatId,
    waitMsgId: waitMsg.message_id,
    processed: false
  });

  // Если через 15 секунд транскрипции нет — предлагаем написать текстом
  setTimeout(() => {
    const key = `${chatId}_${msg.message_id}`;
    const pending = pendingVoice.get(key);
    if (pending && !pending.processed) {
      pendingVoice.delete(key);
      bot.editMessageText(
        '⚠️ Telegram не прислал транскрипцию.\n\nНапиши задачу *текстом* — я всё равно обработаю! ✍️',
        { chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'Markdown' }
      );
    }
  }, 15000);
});

// ============================================================
// edited_message — сюда Telegram Premium присылает транскрипцию
// ============================================================
bot.on('edited_message', async (msg) => {
  const text = msg.voice?.transcription?.text || msg.voice_note_transcription?.text;
  if (!text || !msg.voice) return;

  const key = `${msg.chat.id}_${msg.message_id}`;
  const pending = pendingVoice.get(key);

  if (pending && !pending.processed) {
    pending.processed = true;
    pendingVoice.delete(key);

    // Удаляем сообщение "жду транскрипцию"
    try { await bot.deleteMessage(msg.chat.id, pending.waitMsgId); } catch(e) {}

    await processText(msg.chat.id, text, msg.message_id);
  }
});

// ============================================================
// Обычный текст
// ============================================================
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  await processText(msg.chat.id, msg.text, msg.message_id);
});

// ============================================================
// Claude AI: текст → задачи
// ============================================================
async function processText(chatId, text, replyToId) {
  const processingMsg = await bot.sendMessage(chatId, '🤖 ИИ разбирает на задачи...', {
    reply_to_message_id: replyToId
  });

  try {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: `Извлекай задачи из текста пользователя. Отвечай ТОЛЬКО JSON без markdown:
{"tasks":[{"text":"Короткая задача до 70 символов","priority":"high|medium|low"}]}
Правила: задача = конкретное действие, кратко и чётко. high = срочно, medium = обычное, low = когда-нибудь. Не добавляй задач которых нет в тексте.`,
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
        chat_id: chatId, message_id: processingMsg.message_id
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
        message_id: processingMsg.message_id,
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
      chat_id: chatId, message_id: processingMsg.message_id
    });
  }
}

console.log('🤖 ТуДУрка Bot запущен!');
console.log('📋 Mini App:', MINI_APP_URL);
