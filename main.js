const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { once } = require('events');
const { Command } = require('commander');

const program = new Command();

// -h за замовчуванням зайнятий під довідку, тому вимикаємо стандартну довідку
program.helpOption('--help', 'показати довідку');

program
  .requiredOption('-h, --host <address>', 'адреса, на якій працює сервер')
  .requiredOption('-p, --port <number>', 'порт сервера')
  .requiredOption('-c, --cache <path>', 'шлях до теки кешу');

program.parse();
const options = program.opts();

const ALLOWED_METHODS = ['GET', 'PUT', 'DELETE'];

// Відправляє текстову відповідь із потрібним кодом стану
function sendText(res, status, text, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    ...extraHeaders,
  });
  res.end(text);
}

// Дістає код стану зі шляху URL: "/200" -> 200. Якщо шлях некоректний, повертає null
function parseCode(url) {
  const pathname = new URL(url, 'http://localhost').pathname;
  const match = /^\/(\d{3})$/.exec(pathname);
  if (!match) {
    return null;
  }
  const code = Number(match[1]);
  if (code < 100 || code > 599) {
    return null;
  }
  return code;
}

// Створює обробник запитів (єдиний дозволений колбек, тому async-функція)
function createHandler(cacheDir) {
  return async (req, res) => {
    try {
      // 1. Метод перевіряємо першим: усе, крім GET/PUT/DELETE, дає 405
      if (!ALLOWED_METHODS.includes(req.method)) {
        sendText(res, 405, 'Method Not Allowed', {
          Allow: ALLOWED_METHODS.join(', '),
        });
        return;
      }

      // 2. Перевіряємо шлях: має бути рівно "/<код стану>"
      const code = parseCode(req.url);
      if (code === null) {
        sendText(res, 404, 'Not Found: use path like /200');
        return;
      }

      // 3. Заглушка: реалізуємо в наступних комітах
      sendText(res, 501, `Not implemented yet: ${req.method} ${code}`);
    } catch (err) {
      // Будь-яка непередбачена помилка не повинна валити сервер
      console.error(`Помилка обробки запиту: ${err.message}`);
      if (!res.headersSent) {
        sendText(res, 500, 'Internal Server Error');
      } else {
        res.end();
      }
    }
  };
}

async function main() {
  try {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error('Помилка: порт має бути цілим числом від 1 до 65535');
      process.exit(1);
    }

    const cacheDir = path.resolve(options.cache);
    await fs.mkdir(cacheDir, { recursive: true });
    console.log(`Тека кешу готова: ${cacheDir}`);

    const server = http.createServer(createHandler(cacheDir));
    server.listen(port, options.host);
    // once() повертає проміс: виконається на 'listening', відхилиться на 'error'
    await once(server, 'listening');
    console.log(`Сервер запущено: http://${options.host}:${port}`);
  } catch (err) {
    console.error(`Помилка запуску: ${err.message}`);
    process.exit(1);
  }
}

main();