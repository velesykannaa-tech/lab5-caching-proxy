const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { once } = require('events');
const superagent = require('superagent');
const { buffer } = require('stream/consumers');
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
// Повертає шлях до файлу кешу для коду: <тека кешу>/<код>.jpg
function cacheFilePath(cacheDir, code) {
  return path.join(cacheDir, `${code}.jpg`);
}

// Читає картинку з кешу. Якщо файлу немає, повертає null, інші помилки пробрасує далі
async function readFromCache(cacheDir, code) {
  try {
    return await fs.readFile(cacheFilePath(cacheDir, code));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

// Відправляє двійкові дані картинки з правильним Content-Type
function sendImage(res, status, data, source) {
  res.writeHead(status, {
    'Content-Type': 'image/jpeg',
    'Content-Length': data.length,
    'X-Cache': source, // наш додатковий заголовок: звідки взято картинку
  });
  res.end(data);
}
// Завантажує картинку з http.cat. Будь-яка помилка (404, мережа, таймаут) дає null
async function fetchFromHttpCat(code) {
  try {
    const response = await superagent
      .get(`https://http.cat/${code}`)
      .responseType('blob') // у Node це означає: віддати тіло як Buffer, без перетворення в текст
      .timeout(10000); // не чекаємо відповіді довше 10 секунд
    const data = response.body;
    if (!Buffer.isBuffer(data) || data.length === 0) {
      return null;
    }
    return data;
  } catch (err) {
    // superagent відхиляє проміс для кодів 4xx/5xx (є err.status) і для мережевих помилок
    console.error(`http.cat недоступний для коду ${code}: ${err.status || err.message}`);
    return null;
  }
}
// Безпечно записує файл у кеш: спочатку у тимчасовий файл, потім перейменування.
// Так у кеші ніколи не буде наполовину записаного (пошкодженого) файлу.
async function saveToCache(cacheDir, code, data) {
  const target = cacheFilePath(cacheDir, code);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
// Видаляє картинку з кешу. Повертає true, якщо файл був, і false, якщо його не було
async function deleteFromCache(cacheDir, code) {
  try {
    await fs.unlink(cacheFilePath(cacheDir, code));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
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

                  // 3. GET: спочатку кеш, потім http.cat
      if (req.method === 'GET') {
        const cached = await readFromCache(cacheDir, code);
        if (cached !== null) {
          sendImage(res, 200, cached, 'HIT');
          return;
        }

        const fetched = await fetchFromHttpCat(code);
        if (fetched === null) {
          // не знайдено ні в кеші, ні на http.cat: нічого не зберігаємо
          sendText(res, 404, 'Not Found: image is not in cache and not on http.cat');
          return;
        }

        // спочатку зберігаємо в кеш, потім відповідаємо клієнту
               await saveToCache(cacheDir, code, fetched);
        sendImage(res, 200, fetched, 'MISS');
        return;
      }
            // 4. PUT: записуємо картинку з тіла запиту в кеш
      if (req.method === 'PUT') {
        const body = await buffer(req); // тіло запиту цілком, як Buffer
        if (body.length === 0) {
          sendText(res, 400, 'Bad Request: empty body');
          return;
        }
        await saveToCache(cacheDir, code, body);
        sendText(res, 201, 'Created');
        return;
      }
            // 5. DELETE: видаляємо картинку з кешу
      if (req.method === 'DELETE') {
        const deleted = await deleteFromCache(cacheDir, code);
        if (!deleted) {
          sendText(res, 404, 'Not Found: image is not in cache');
          return;
        }
        sendText(res, 200, 'OK');
        return;
      }

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