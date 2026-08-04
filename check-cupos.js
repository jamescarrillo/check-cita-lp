const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { createWorker } = require('tesseract.js');
const { playAlert } = require('./alert');

const URL = 'https://sistemas.policia.gob.pe/lunasoscurecidas/Solicitud_Menu.aspx';
const DNI = '77777777';
const DNI_MASK = DNI.slice(0, 3) + '*'.repeat(5);
const CLAVE = 'tu_clave';
const SEDE_VAL = '1';
const SEDE_TXT = 'LIMA-LA VICTORIA';
const EXPEDIENTE = '99999';
const LOG_FILE = path.join(__dirname, 'logs.txt');
const CAPTCHA_DIR = path.join(__dirname, 'captchas');
const CONF_MIN = 90;
const MAX_VENTANAS = 6;

let ventanasActivas = 0;
let esperandoCaptchaManual = false;

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

function filenameTimestamp() {
  const s = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima', hour12: false });
  return s.replace(/[/:,]/g, '-').replace(/\s+/g, '_');
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

    const variantes = await page.evaluate(async (dataUrl) => {
      const upscale = (scale) => new Promise((resolve) => {
        const img = new Image();
        img.src = dataUrl;
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width * scale;
          canvas.height = img.height * scale;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => resolve(null);
      });
      return {
        original: dataUrl,
        scale3x: await upscale(3),
        scale4x: await upscale(4),
      };
    }, src);

    fs.mkdirSync(CAPTCHA_DIR, { recursive: true });
    const fileName = path.join(CAPTCHA_DIR, `${filenameTimestamp()}.png`);
    const base64 = src.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(fileName, Buffer.from(base64, 'base64'));
    log(`  Captcha guardado en captchas/${path.basename(fileName)}`);

    const worker = await getWorker();
    await worker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    });
    const candidatos = [];
    for (const [nombre, dataUrl] of Object.entries(variantes)) {
      if (!dataUrl) continue;
      const buffer = Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      for (const psm of [7, 8, 13]) {
        await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
        const { data } = await worker.recognize(buffer);
        const text = (data.text || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        if (!text) continue;
        candidatos.push({ text, conf: data.confidence, via: nombre });
        if (data.confidence >= CONF_MIN) {
          log(`  OCR candidato rapido: "${text}" (${data.confidence.toFixed(0)}) via ${nombre}/psm${psm}`);
          return { text, conf: data.confidence };
        }
      }
    }
    candidatos.sort((a, b) => b.conf - a.conf || b.text.length - a.text.length);
    const limpio = candidatos[0]?.text || '';
    const conf = candidatos[0]?.conf || 0;
    log(`  OCR candidatos: ${candidatos.map(c => `"${c.text}"(${c.conf.toFixed(0)})`).join(' ')}`);
    return { text: limpio, conf };
  } catch (err) {
    log(`  Error OCR captcha: ${err.message}`);
    return { text: '', conf: 0 };
  }
}

const ERROR_RE = /incorrecto|inv[aá]lido|error|agot|no.*(pudo|cupo)|ya.*(registrad|tiene)/i;

async function esperarCaptchaManual(page) {
  log('  >>> COMPLETA LA CITA EN EL NAVEGADOR: escribe el captcha y haz click.');
  log('  >>> Las demas iteraciones estan DETENIDAS hasta que completes o cierres el navegador.');
  log('  >>> Cierra la ventana del navegador si no puedes registrar la cita.');
  let ultimaAlerta = 0;
  while (true) {
    if (page.isClosed()) {
      log('  Ventana cerrada por el usuario. Reanudando monitoreo.');
      return { ok: false, msg: 'Ventana cerrada por el usuario' };
    }
    let estado;
    try {
      estado = await leerEstadoDespuesDeEnvio(page);
    } catch (err) {
      log('  Ventana cerrada por el usuario. Reanudando monitoreo.');
      return { ok: false, msg: 'Ventana cerrada por el usuario' };
    }
    if (estado.success && !ERROR_RE.test(estado.msg)) {
      log(`  ✅ ${estado.msg}`);
      return { ok: true, msg: estado.msg };
    }
    if (estado.noCupos) {
      log(`  Cupos agotados mientras esperabas: ${estado.msg}`);
      return { ok: false, msg: estado.msg };
    }
    if (Date.now() - ultimaAlerta > 30000) {
      log('  🔔 INGRESA CAPTCHA...');
      await playAlert('INGRESA EL CAPTCHA EN EL NAVEGADOR PARA COMPLETAR TU CITA.', 1);
      ultimaAlerta = Date.now();
    }
    await delay(5000);
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
    const bodyText = (document.body?.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 500);
    if (/no hay cupos|sin cupos/i.test(bodyText)) {
      return { success: false, noCupos: true, msg: bodyText.slice(0, 300) || 'No hay cupos disponibles' };
    }
    return { success: false, msg: bodyText || 'Estado no detectado tras enviar captcha' };
  });
}

async function intentarConCaptcha(page, fechaTxt, horaTxt) {
  for (let intento = 1; intento <= 5; intento++) {
    const res = await resolverCaptcha(page);
    let captcha = res.text;
    if (!captcha || res.conf < CONF_MIN) {
      log(`      OCR poco confiable (conf ${res.conf.toFixed(0)}).`);
      log(`      >>> Dejando la cita en la pagina para que la completes manualmente.`);
      return { ok: false, manual: true, msg: 'OCR no confiable, intervencion manual' };
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
  return { ok: false, manual: true, msg: `No se resolvio el captcha en 5 intentos para ${fechaTxt} ${horaTxt}` };
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
      if (resultado.manual) {
        return { ok: false, manual: true, msg: `${fecha.text} ${hora.text}` };
      }
      if (resultado.email) {
        log(`    Respuesta del sistema: ${resultado.msg}`);
        return { ok: false, email: true, msg: resultado.msg };
      }
      if (resultado.noCupos) {
        log(`    Cupos agotados para esta fecha: ${resultado.msg}`);
        break;
      }
      log(`    Respuesta del sistema: ${resultado.msg}`);
    }
  }
  return { ok: false, msg: 'No se logro agendar ninguna cita' };
}

async function checkCupos() {
  logRaw(`\n═══════════════════════════════════════════════`);
  logRaw(`  Iteracion: ${timestamp()}`);
  logRaw(`═══════════════════════════════════════════════\n`);

  if (esperandoCaptchaManual) {
    log('>>> Esperando ingreso manual del captcha. Iteraciones DETENIDAS, navegador abierto.');
    return;
  }

  if (ventanasActivas >= MAX_VENTANAS) {
    log(`Limite de ${MAX_VENTANAS} ventanas activas alcanzado, saltando esta iteracion.`);
    return;
  }

  ventanasActivas++;

  let browser;

  try {
    browser = await puppeteer.launch({ headless: false });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // =====================================================
    // LOGIN
    // =====================================================
    log(`Iniciando sesion para el usuario DNI:${DNI_MASK}...`);

    await page.goto(URL, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    await page.select('#DdlDocumento', '1');
    await page.type('#TxtCIP', DNI);
    await page.type('#TxtClave', CLAVE);

    await Promise.all([
      page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 20000
      }),
      page.click('#BtnContinuar')
    ]);

    log('Sesion iniciada correctamente.');

    // =====================================================
    // ABRIR EXPEDIENTE
    // =====================================================
    log(`Ingresando al expediente ${EXPEDIENTE}...`);

    const actionLinkId = '#MainContent_gvProgramacion_btnAccion_0';

    await page.waitForSelector(actionLinkId, {
      timeout: 10000
    });

    await page.click(actionLinkId);

    // =====================================================
    // ABRIR RESERVA DE CITA
    // =====================================================
    const btnCitaSelector = '#MainContent_btnCita';

    const btnCita = await page.$(btnCitaSelector);

    if (!btnCita) {
      log('El expediente no esta en etapa de agendamiento.');
      return;
    }

    log(`Detalle del expediente ${EXPEDIENTE} cargado.`);
    log('Abriendo reserva de cita...');

    await btnCita.click();

    const sedeSelector = '#MainContent_idUcitas_cbosede';

    try {
      await page.waitForSelector(sedeSelector, {
        timeout: 8000
      });
    } catch {
      log('No fue posible abrir la ventana de reserva de cita.');
      return;
    }

    // =====================================================
    // BUSCAR CUPOS
    // =====================================================
    log(`Buscando cupos disponibles en ${SEDE_TXT}...`);

    await page.select(sedeSelector, SEDE_VAL);

    await delay(500);

    const cuposText = await page
      .$eval(
        '#MainContent_idUcitas_lblcupos',
        el => el.textContent.trim()
      )
      .catch(() => '');

    const fechaOptions = await page
      .$eval(
        '#MainContent_idUcitas_cboFecha',
        el =>
          [...el.options]
            .filter(o => o.text && o.text !== 'Sin Cupos')
            .map(o => ({
              text: o.text,
              value: o.value
            }))
      )
      .catch(() => []);

    const hayCupos =
      cuposText !== '' &&
      cuposText.toLowerCase() !== 'sin cupos';

    log(
      `Cupos: "${cuposText}" | Fechas: [${fechaOptions
        .map(f => f.text)
        .join(', ')}]`
    );

    // =====================================================
    // SI HAY CUPOS
    // =====================================================
    if (hayCupos) {

      if (!enHorarioLaboral()) {
        log('Cupos disponibles pero fuera de horario laboral (9:00-23:59).');
        return;
      }

      logRaw('\n========================================');
      logRaw('  🎉  ¡CUPOS DISPONIBLES!  🎉');
      log(`  Cupos: ${cuposText}`);
      logRaw('========================================\n');

      playAlert(`Cupos disponibles: ${cuposText}. Intentando agendar tu cita.`);

      log('Intentando agendar automaticamente...');

      const resultado = await intentarAgendar(page, fechaOptions);

      // =====================================================
      // CAPTCHA MANUAL
      // =====================================================
      if (resultado.manual) {

        esperandoCaptchaManual = true;

        logRaw('\n========================================');
        logRaw('  🙋 CAPTCHA MANUAL 🙋');
        logRaw('========================================\n');

        log(`Completa la cita en el navegador: ${resultado.msg}`);
        log('Las iteraciones quedan detenidas hasta completar el captcha.');

        await playAlert(
          'Hay cupos disponibles pero el captcha no se resolvio. COMPLETA LA CITA EN EL NAVEGADOR AHORA.',
          3
        );

        const manual = await esperarCaptchaManual(page);

        esperandoCaptchaManual = false;

        if (manual.ok) {

          logRaw('\n========================================');
          logRaw('  ✅ CITA AGENDADA (MANUAL) ✅');
          logRaw('========================================\n');

          log(`Detalle: ${manual.msg}`);

          await playAlert(
            `Cita agendada con exito: ${manual.msg}`,
            3
          );

          logRaw('\nNavegador abierto para verificacion. Cerrando en 5 minutos...\n');

          await delay(5 * 60 * 1000);

        } else {

          log(`No se completo la cita manualmente: ${manual.msg}`);
          log('Reanudando monitoreo.');

        }

      }
      // =====================================================
      // AGENDADO AUTOMATICO
      // =====================================================
      else if (resultado.ok) {

        logRaw('\n========================================');
        logRaw('  ✅ CITA AGENDADA ✅');
        logRaw('========================================\n');

        log(`Detalle: ${resultado.msg}`);

        await playAlert(
          `Cita agendada con exito: ${resultado.msg}`
        );

        logRaw('\nNavegador abierto para verificacion. Cerrando en 5 minutos...\n');

        await delay(5 * 60 * 1000);

      }
      // =====================================================
      // ERROR AL AGENDAR
      // =====================================================
      else {

        log(`No se pudo agendar: ${resultado.msg}`);

        await playAlert(
          `No se pudo agendar la cita. ${resultado.msg}`
        );

        log('Continuando el monitoreo...');

      }

    } else {

      log(`Sin cupos en ${SEDE_TXT}`);

    }

  } catch (err) {

    log(`Error durante la verificacion: ${err.message}`);

  } finally {

    if (browser) {
      await browser.close();
    }

    ventanasActivas--;

  }
}

const intervalArg = process.argv.find(a => a.startsWith('--interval='));
const intervalSec = intervalArg
  ? parseInt(intervalArg.split('=')[1], 10)
  : 30;

if (intervalSec > 0) {
  log(`Modo bucle: verificando cada ${intervalSec} segundo(s).`);
  checkCupos();
  setInterval(checkCupos, intervalSec * 1000);
} else {
  checkCupos().then(() => process.exit(0));
}
