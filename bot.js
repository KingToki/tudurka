// ============================================================
// ТуДУрка Bot — Telegram бот + Claude AI
// ============================================================
// Зависимости: npm install node-telegram-bot-api @anthropic-ai/sdk dotenv
// ============================================================

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// URL твоего мини-апп (замени на свой хостинг)
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://yourdomain.com/tudurka';

// ============================================================
// Стартовое сообщение
// ============================================================
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || 'друг';

  bot.sendMessage(chatId, `Привет, ${name}! 👋\n\nЯ твой помощник для задач. Просто:\n\n🎙️ *Запиши голосовое* — скажи что нужно сделать\n✅ *Я разберу* на задачи с помощью ИИ\n📋 *Открой список* кнопкой ниже\n\n_Требуется Telegram Premium для транскрипции голоса._`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        {
          text: '📋 Открыть список задач',
          web_app: { url: MINI_APP_URL }
        }
      ]]
    }
  });
});

// ============================================================
// Обработка голосовых сообщений
// ============================================================
bot.on('voice', async (msg) => {
  const chatId = msg.chat.id;
  const voice = msg.voice;

  // Проверяем есть ли транскрипция (Telegram Premium автоматически добавляет)
  if (msg.voice_note_transcription || (voice && voice.transcription)) {
    const transcription = msg.voice_note_transcription?.text || voice.transcription?.text;
    await processTranscription(chatId, transcription, msg);
    return;
  }

  // Если нет транскрипции — ждём её или запрашиваем файл
  // Telegram Premium транскрибирует автоматически, проверим через update
  const waitMsg = await bot.sendMessage(chatId, '🎙️ Обрабатываю голосовое...', {
    reply_to_message_id: msg.message_id
  });

  // Скачиваем аудио и транскрибируем через Telegram API
  try {
    const file = await bot.getFile(voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    // Если нет Premium транскрипции — говорим пользователю
    bot.editMessageText(
      '⚠️ Транскрипция голоса доступна только с *Telegram Premium*.\n\nИли напиши задачу текстом — я всё равно её обработаю! 📝',
      { chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error(err);
    bot.editMessageText('Произошла ошибка. Попробуй ещё раз.', {
      chat_id: chatId, message_id: waitMsg.message_id
    });
  }
});

// ============================================================
// Telegram Premium: автоматическая транскрипция голоса
// ============================================================
// Telegram шлёт update с transcription когда Premium обрабатывает голос
bot.on('message', async (msg) => {
  // Транскрипция приходит как отдельное поле в сообщении с голосом
  if (msg.voice && msg.voice_note_transcription) {
    const text = msg.voice_note_transcription.text;
    if (text && text.trim()) {
      await processTranscription(msg.chat.id, text, msg);
    }
  }

  // Обычный текст — тоже обрабатываем
  if (msg.text && !msg.text.startsWith('/')) {
    await processTranscription(msg.chat.id, msg.text, msg);
  }
});

// ============================================================
// Claude AI анализирует текст → задачи
// ============================================================
async function processTranscription(chatId, text, originalMsg) {
  const processingMsg = await bot.sendMessage(chatId, '🤖 ИИ разбирает на задачи...', {
    reply_to_message_id: originalMsg?.message_id
  });

  try {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: `Ты помощник который извлекает задачи из текста пользователя.
Из входного текста (может быть голосовое/расшифровка или просто текст) нужно извлечь список конкретных задач.

Правила:
1. Каждая задача — это конкретное действие которое нужно выполнить
2. Формулируй кратко и чётко (до 80 символов)
3. Если задача одна — верни одну задачу
4. Если задач несколько — раздели их
5. Определи приоритет: high (срочно/важно), medium (обычное), low (когда-нибудь)
6. Не добавляй лишних задач которых нет в тексте

Отвечай ТОЛЬКО JSON без markdown блоков:
{"tasks": [{"text": "Текст задачи", "priority": "high|medium|low"}]}`,
      messages: [{ role: 'user', content: `Извлеки задачи из этого текста: "${text}"` }]
    });

    const content = response.content[0].text.trim();
    let parsed;

    try {
      parsed = JSON.parse(content);
    } catch {
      // Попробуем вытащить JSON из текста
      const match = content.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    }

    if (!parsed?.tasks?.length) {
      bot.editMessageText('Не удалось извлечь задачи из текста. Попробуй сформулировать иначе.', {
        chat_id: chatId, message_id: processingMsg.message_id
      });
      return;
    }

    const tasks = parsed.tasks;

    // Формируем красивый ответ
    const priorityEmoji = { high: '🔴', medium: '🟡', low: '🟢' };
    const taskLines = tasks.map(t => `${priorityEmoji[t.priority] || '🟡'} ${t.text}`).join('\n');
    const count = tasks.length;
    const word = count === 1 ? 'задача' : count < 5 ? 'задачи' : 'задач';

    await bot.editMessageText(
      `✅ *${count} ${word} добавлено в список:*\n\n${taskLines}`,
      {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            {
              text: '📋 Открыть список',
              web_app: { url: `${MINI_APP_URL}?tasks=${encodeURIComponent(JSON.stringify(tasks))}` }
            }
          ]]
        }
      }
    );

  } catch (err) {
    console.error('Claude API error:', err);
    bot.editMessageText('Ошибка обработки. Попробуй позже.', {
      chat_id: chatId, message_id: processingMsg.message_id
    });
  }
}

// ============================================================
// Команда /help
// ============================================================
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, `*Как пользоваться ТуДУрка:*\n\n1. 🎤 Отправь голосовое сообщение\n   _(нужен Telegram Premium для авто-транскрипции)_\n\n2. ✍️ Или просто напиши текст:\n   _"Нужно купить молоко и записаться к врачу"_\n\n3. 🤖 ИИ разберёт на отдельные задачи\n\n4. 📋 Открой список и отмечай выполненные\n\n*Команды:*\n/start — начало\n/list — открыть список задач\n/help — помощь`, {
    parse_mode: 'Markdown'
  });
});

// ============================================================
// Команда /list
// ============================================================
bot.onText(/\/list/, (msg) => {
  bot.sendMessage(msg.chat.id, '📋 Твой список задач:', {
    reply_markup: {
      inline_keyboard: [[
        { text: '📋 Открыть список', web_app: { url: MINI_APP_URL } }
      ]]
    }
  });
});

console.log('🤖 ТуДУрка Bot запущен!');
console.log('📋 Mini App URL:', MINI_APP_URL);
