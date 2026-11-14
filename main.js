const fs = require('fs/promises');
const path = require('path');
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
  } catch (err) {
    console.error(`Помилка запуску: ${err.message}`);
    process.exit(1);
  }
}

main();