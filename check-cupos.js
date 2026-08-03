const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { playAlert } = require('./alert');

const URL = 'https://sistemas.policia.gob.pe/lunasoscurecidas/Solicitud_Menu.aspx';
const DNI = '72155722';
const DNI_MASK = DNI.slice(0, 3) + '*'.repeat(5);
const CLAVE = 'jotace';
const SEDE_VAL = '1';
const SEDE_TXT = 'LIMA-LA VICTORIA';
const EXPEDIENTE = '30709';
const LOG_FILE = path.join(__dirname, 'logs.txt');

function log(msg) {
  const line = `[${timestamp()}] ${msg}`;
  console.log(msg);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function logRaw(msg) {
  console.log(msg);
  fs.appendFileSync(LOG_FILE, msg + '\n');
}

function timestamp() {
  return new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function horaPeru() {
  const now = new Date();
  const opts = { timeZone: 'America/Lima', hour: '2-digit', hour12: false, hourCycle: 'h23' };
  return parseInt(now.toLocaleString('es-PE', opts), 10);
}

function enHorarioLaboral() {
  const h = horaPeru();
  return h >= 9 && h < 24;
}

async function checkCupos() {
  logRaw(`\n═══════════════════════════════════════════════`);
  logRaw(`  Iteracion: ${timestamp()}`);
  logRaw(`═══════════════════════════════════════════════`);

  let browser;
  try {
    browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // 1. Login
    log(`Iniciando sesion para el usuario DNI:${DNI_MASK}...`);
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(500);

    await page.select('#DdlDocumento', '1');
    await delay(500);
    await page.type('#TxtCIP', DNI);
    await delay(500);
    await page.type('#TxtClave', CLAVE);
    await delay(500);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.click('#BtnContinuar'),
    ]);
    await delay(500);
    log('Sesion iniciada correctamente.');

    // 2. Find expediente row and click action
    log(`Ingresando a expediente ${EXPEDIENTE}...`);
    const actionLinkId = '#MainContent_gvProgramacion_btnAccion_0';
    await page.waitForSelector(actionLinkId, { timeout: 10000 });
    await delay(500);
    await page.click(actionLinkId);
    await delay(500);

    // Wait for detail panel with "Reservar Cita" button
    await page.waitForSelector('#MainContent_btnCita', { timeout: 10000 });
    await delay(500);
    log(`Detalle del expediente ${EXPEDIENTE} cargado.`);

    // 3. Click "Reservar Cita"
    log('Abriendo reserva de cita...');
    await page.click('#MainContent_btnCita');
    await delay(500);

    // 4. Select sede
    log(`Buscando Cupos Disponibles en ${SEDE_TXT}...`);
    await page.select('#MainContent_idUcitas_cbosede', SEDE_VAL);
    await delay(500);

    // 5. Read cupos from label
    const cuposLabel = await page.$('#MainContent_idUcitas_lblcupos');
    let cuposText = '';
    if (cuposLabel) {
      cuposText = await cuposLabel.evaluate(el => el.textContent.trim());
    }

    const fechaSelect = await page.$('#MainContent_idUcitas_cboFecha');
    let fechaOptions = [];
    if (fechaSelect) {
      fechaOptions = await fechaSelect.evaluate(el =>
        Array.from(el.options).map(o => o.text)
      );
    }

    const hayCupos = cuposText && cuposText.toLowerCase() !== 'sin cupos' && cuposText !== '';

    log(`Cupos: "${cuposText}" | Fechas: [${fechaOptions.join(', ')}]`);

    if (hayCupos) {
      if (enHorarioLaboral()) {
        logRaw('\n========================================');
        logRaw('  🎉  ¡CUPOS DISPONIBLES!  🎉');
        log(`  Cupos: ${cuposText}`);
        logRaw('========================================\n');

        for (const fecha of fechaOptions) {
          if (fecha === 'Sin Cupos' || fecha === '') continue;
          await page.select('#MainContent_idUcitas_cboFecha', fecha);
          await delay(500);

          const horaSelect = await page.$('#MainContent_idUcitas_cboHora');
          if (horaSelect) {
            const horas = await horaSelect.evaluate(el =>
              Array.from(el.options).map(o => o.text).filter(h => h !== '')
            );
            log(`  ${fecha}: [${horas.join(', ')}]`);
          }
        }

        await playAlert();

        logRaw('\nNavegador abierto para que agendes la cita. Cerrando en 5 minutos...\n');
        await delay(5 * 60 * 1000);
      } else {
        log('Cupos disponibles pero fuera de horario laboral (9:00-23:59). Navegador cerrado.');
      }
    } else {
      log(`Sin cupos en ${SEDE_TXT}`);
    }

  } catch (err) {
    log(`Error durante la verificacion: ${err.message}`);
  } finally {
    if (browser) await browser.close();
  }
}

const intervalArg = process.argv.find(a => a.startsWith('--interval='));
const intervalSec = intervalArg
  ? parseInt(intervalArg.split('=')[1], 10)
  : 120;

if (intervalSec > 0) {
  log(`Modo bucle: verificando cada ${intervalSec} segundo(s).`);
  checkCupos();
  setInterval(checkCupos, intervalSec * 1000);
} else {
  checkCupos().then(() => process.exit(0));
}
