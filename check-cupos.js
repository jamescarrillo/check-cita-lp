const puppeteer = require('puppeteer');
const { playAlert } = require('./alert');

const URL = 'https://sistemas.policia.gob.pe/lunasoscurecidas/Solicitud_Menu.aspx';
const DNI = '77777777';
const DNI_MASK = DNI.slice(0, 3) + '*'.repeat(5);
const CLAVE = 'tu_clave';
const SEDE_VAL = '1';
const SEDE_TXT = 'LIMA-LA VICTORIA';
const EXPEDIENTE = '11111';

function timestamp() {
  return new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function checkCupos() {
  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`  Iteracion: ${timestamp()}`);
  console.log(`═══════════════════════════════════════════════`);

  let browser;
  try {
    browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // 1. Login
    console.log(`Iniciando sesion para el usuario DNI:${DNI_MASK}...`);
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
    console.log('Sesion iniciada correctamente.');

    // 2. Find expediente row and click action
    console.log(`Ingresando a expediente ${EXPEDIENTE}...`);
    const actionLinkId = '#MainContent_gvProgramacion_btnAccion_0';
    await page.waitForSelector(actionLinkId, { timeout: 10000 });
    await delay(500);
    await page.click(actionLinkId);
    await delay(500);

    // Wait for detail panel with "Reservar Cita" button
    await page.waitForSelector('#MainContent_btnCita', { timeout: 10000 });
    await delay(500);
    console.log(`Detalle del expediente ${EXPEDIENTE} cargado.`);

    // 3. Click "Reservar Cita"
    console.log('Abriendo reserva de cita...');
    await page.click('#MainContent_btnCita');
    await delay(500);

    // 4. Select sede
    console.log(`Buscando Cupos Disponibles en ${SEDE_TXT}...`);
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

    const hayCupos = fechaOptions.some(o => o !== 'Sin Cupos' && o !== '') ||
                     (cuposText && cuposText.toLowerCase() !== 'sin cupos' && cuposText !== '');

    console.log(`Cupos: "${cuposText}" | Fechas: [${fechaOptions.join(', ')}]`);

    if (hayCupos) {
      console.log('\n========================================');
      console.log('  🎉  ¡CUPOS DISPONIBLES!  🎉');
      console.log(`  Fechas: ${fechaOptions.join(', ')}`);
      console.log(`  Cupos: ${cuposText}`);
      console.log('========================================\n');
      await playAlert();
    } else {
      console.log(`[${timestamp()}] Sin cupos en ${SEDE_TXT}`);
    }

  } catch (err) {
    console.error(`[${timestamp()}] Error durante la verificacion:`, err.message);
  } finally {
    if (browser) await browser.close();
  }
}

const intervalArg = process.argv.find(a => a.startsWith('--interval='));
const intervalMin = intervalArg
  ? parseInt(intervalArg.split('=')[1], 10)
  : 5;

if (intervalMin > 0) {
  console.log(`Modo bucle: verificando cada ${intervalMin} minuto(s).`);
  checkCupos();
  setInterval(checkCupos, intervalMin * 60 * 1000);
} else {
  checkCupos().then(() => process.exit(0));
}
