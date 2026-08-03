const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { createWorker } = require('tesseract.js');
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

let workerPromise;

function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng');
  }
  return workerPromise;
}

async function resolverCaptcha(page) {
  try {
    const src = await page.$eval('#MainContent_idUcitas_Image1', el => el.src);
    if (!src || !src.startsWith('data:image')) {
      log('  Captcha no disponible (imagen vacia).');
      return '';
    }
    const worker = await getWorker();
    const { data } = await worker.recognize(src);
    const limpio = (data.text || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    return limpio;
  } catch (err) {
    log(`  Error OCR captcha: ${err.message}`);
    return '';
  }
}

async function leerHoras(page) {
  const horaSelect = await page.$('#MainContent_idUcitas_cboHora');
  if (!horaSelect) return [];
  return await horaSelect.evaluate(el =>
    Array.from(el.options)
      .filter(o => o.text && o.text !== 'Sin Cupos')
      .map(o => ({ text: o.text, value: o.value }))
  );
}

async function esperarCaptcha(page, timeout = 8000) {
  try {
    await page.waitForFunction(
      () => {
        const div = document.getElementById('MainContent_idUcitas_divcontiene2');
        return div && getComputedStyle(div).display !== 'none';
      },
      { timeout }
    );
    return true;
  } catch (err) {
    return false;
  }
}

async function refrescarCaptcha(page) {
  try {
    await page.click('#MainContent_idUcitas_lbkrefresca1');
    await delay(1000);
  } catch (err) {
    log(`  Error refrescando captcha: ${err.message}`);
  }
}

async function leerEstadoDespuesDeEnvio(page) {
  return await page.evaluate(() => {
    if (location.href.toLowerCase().includes('cita.aspx')) {
      return { success: true, msg: 'Redirigido a Cita.aspx (cita registrada)' };
    }
    const swal = document.querySelector('.swal2-container');
    if (swal && getComputedStyle(swal).display !== 'none') {
      const t = (document.querySelector('.swal2-title')?.innerText || '').trim();
      const h = (document.querySelector('.swal2-html-container')?.innerText || '').trim();
      const txt = (t + ' ' + h).trim();
      return { success: true, msg: txt || 'Mensaje de exito (Swal)' };
    }
    const lblMsj = document.getElementById('MainContent_idUcitas_lblmensajess');
    if (lblMsj && lblMsj.innerText.trim()) {
      const txt = lblMsj.innerText.trim();
      return { success: /satisfactoria|registrado/i.test(txt), msg: txt };
    }
    const content = document.getElementById('MainContent_idUcitas_content_mensaje');
    if (content && getComputedStyle(content).display !== 'none') {
      return { success: false, noCupos: true, msg: content.innerText.trim() };
    }
    const lblValida = document.getElementById('MainContent_idUcitas_lblmensajevalida');
    if (lblValida && lblValida.innerText.trim()) {
      return { success: false, email: true, msg: lblValida.innerText.trim() };
    }
    return { success: false, msg: 'Estado no detectado tras enviar captcha' };
  });
}

async function intentarConCaptcha(page, fechaTxt, horaTxt) {
  for (let intento = 1; intento <= 5; intento++) {
    const captcha = await resolverCaptcha(page);
    if (!captcha) {
      await refrescarCaptcha(page);
      continue;
    }
    log(`      Captcha OCR intento ${intento}: "${captcha}"`);
    await page.$eval('#MainContent_idUcitas_txtimg', el => { el.value = ''; });
    await page.type('#MainContent_idUcitas_txtimg', captcha);
    await delay(300);
    await page.click('#MainContent_idUcitas_btgSiguiente');
    await delay(3000);

    const estado = await leerEstadoDespuesDeEnvio(page);
    log(`      Resultado: ${estado.msg}`);

    if (estado.success) return { ok: true, msg: estado.msg };
    if (estado.email) return { ok: false, email: true, msg: estado.msg };
    if (estado.noCupos) return { ok: false, noCupos: true, msg: estado.msg };

    // Captcha incorrecto u otro error: limpiar y refrescar para reintentar
    await page.$eval('#MainContent_idUcitas_txtimg', el => { el.value = ''; });
    await refrescarCaptcha(page);
    await delay(500);
  }
  return { ok: false, msg: `Agotados 5 intentos de captcha para ${fechaTxt} ${horaTxt}` };
}

async function intentarAgendar(page, fechaOptions) {
  let totalIntentos = 0;
  for (const fecha of fechaOptions) {
    log(`  Probando fecha: ${fecha.text}...`);
    await page.select('#MainContent_idUcitas_cboFecha', fecha.value);
    await delay(1500);

    const horas = await leerHoras(page);
    if (!horas.length) {
      log(`    Sin horas disponibles para ${fecha.text}.`);
      continue;
    }
    log(`    Horas disponibles: [${horas.map(h => h.text).join(', ')}]`);

    for (const hora of horas) {
      if (++totalIntentos > 30) {
        log('  Limite de 30 intentos de reserva alcanzado.');
        return { ok: false, msg: 'Limite de intentos' };
      }
      log(`    Intentando reservar ${fecha.text} ${hora.text}...`);
      await page.select('#MainContent_idUcitas_cboHora', hora.value);
      await delay(1500);

      const captchaVisible = await esperarCaptcha(page);
      if (!captchaVisible) {
        log('    El bloque de captcha no aparecio.');
        continue;
      }

      const resultado = await intentarConCaptcha(page, fecha.text, hora.text);
      if (resultado.ok) {
        return { ok: true, msg: `${fecha.text} ${hora.text} - ${resultado.msg}` };
      }
      if (resultado.email) {
        return { ok: false, email: true, msg: resultado.msg };
      }
      if (resultado.noCupos) {
        log('    Cupos agotados para esta fecha, pasando a la siguiente...');
        break;
      }
    }
  }
  return { ok: false, msg: 'No se logro agendar ninguna cita' };
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
        Array.from(el.options)
          .filter(o => o.text && o.text !== 'Sin Cupos')
          .map(o => ({ text: o.text, value: o.value }))
      );
    }

    const hayCupos = cuposText && cuposText.toLowerCase() !== 'sin cupos' && cuposText !== '';

    log(`Cupos: "${cuposText}" | Fechas: [${fechaOptions.map(f => f.text).join(', ')}]`);

    if (hayCupos) {
      if (enHorarioLaboral()) {
        logRaw('\n========================================');
        logRaw('  🎉  ¡CUPOS DISPONIBLES!  🎉');
        log(`  Cupos: ${cuposText}`);
        logRaw('========================================\n');

        log('Citas disponibles, intentando agendar automaticamente...');
        const resultado = await intentarAgendar(page, fechaOptions);

        if (resultado.ok) {
          logRaw('\n========================================');
          logRaw('  ✅  CITA AGENDADA  ✅');
          logRaw('========================================\n');
          log('Cita agendada con exito, revisa el detalle del tramite.');
          log(`  Detalle: ${resultado.msg}`);
          await playAlert('Cita agendada con exito, revisa el detalle del tramite.');
          logRaw('\nNavegador abierto para que verifiques tu cita. Cerrando en 5 minutos...\n');
          await delay(5 * 60 * 1000);
        } else {
          log(`No se pudo agendar: ${resultado.msg}`);
          log('Las citas se agotaron o el captcha no se resolvio. Continuando el monitoreo...');
        }
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
