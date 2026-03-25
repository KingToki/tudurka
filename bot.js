// ============================================================
// ТуДУрка Bot — Telegram бот + Claude AI
// ============================================================
// npm install node-telegram-bot-api @anthropic-ai/sdk dotenv
// ============================================================

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://kingtoki.github.io/tudurka/';
const TG_API = `https://api.telegram.org/bot${TOKEN}`;

// ============================================================
// Telegram API helper
// ============================================================
async function tgCall(method, params = {}) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  return res.json();
}

// ============================================================
// Транскрибировать голосовое через Telegram Bot API
// Работает для Premium пользователей
// ============================================================
async function transcribeVoice(fileId) {
  const result = await tgCall('transcribeAudio', { file_id: fileId });
  if (!result.ok) return null;

  let text = result.result?.text;
  let isFinal = result.result?.is_final;
  const transcriptionId = result.result?.transcription_id;

  if (!transcriptionId) return text || null;

  // Поллим пока не готово — каждые 2 секунды, максимум 16 секунд
  let attempts = 0;
  while (!isFinal && attempts < 8) {
    await new Promise(r => setTimeout(r, 2000));
    const poll = await tgCall('getTranscription', { transcription_id: transcriptionId });
    if (poll.ok) {
      text = poll.result?.text;
      isFinal = poll.result?.is_final;
    }
    attempts++;
  }

  return text || null;
}

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

  const waitMsg = await bot.sendMessage(chatId, '🎙️ Транскрибирую голосовое...', {
    reply_to_message_id: msg.message_id
  });

  try {
    const text = await transcribeVoice(msg.voice.file_id);

    if (!text) {
      bot.editMessageText(
        '⚠️ Не удалось транскрибировать.\n\nТранскрипция доступна только Premium пользователям.\nНапиши задачу *текстом* — я обработаю! ✍️',
        { chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'Markdown' }
      );
      return;
    }

    await bot.editMessageText(`🎙️ _"${text}"_\n\n🤖 Разбираю на задачи...`, {
      chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'Markdown'
    });

    await processText(chatId, text, waitMsg.message_id, true);

  } catch (err) {
    console.error('Voice error:', err.message);
    bot.editMessageText('Ошибка обработки голосового. Попробуй ещё раз.', {
      chat_id: chatId, message_id: waitMsg.message_id
    });
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
async function processText(chatId, text, replyToId, isEdit = false) {
  let processingMsgId;

  if (isEdit) {
    processingMsgId = replyToId;
  } else {
    const m = await bot.sendMessage(chatId, '🤖 ИИ разбирает на задачи...', {
      reply_to_message_id: replyToId
    });
    processingMsgId = m.message_id;
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
        chat_id: chatId, message_id: processingMsgId
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
        message_id: processingMsgId,
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
    console.error('Claude error:', err.message);
    bot.editMessageText('Ошибка обработки. Попробуй ещё раз.', {
      chat_id: chatId, message_id: processingMsgId
    });
  }
}

console.log('🤖 ТуДУрка Bot запущен!');
console.log('📋 Mini App:', MINI_APP_URL);
