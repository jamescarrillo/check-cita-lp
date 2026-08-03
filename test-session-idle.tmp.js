const puppeteer = require('puppeteer');
const fs = require('fs');
const URL = 'https://sistemas.policia.gob.pe/lunasoscurecidas/Solicitud_Menu.aspx';
const DNI = '72155722';
const CLAVE = 'jotace';
const LOG = './session-idle.log';
function log(m) { const line = `[${new Date().toLocaleTimeString('es-PE', { timeZone: 'America/Lima' })}] ${m}`; console.log(line); fs.appendFileSync(LOG, line + '\n'); }
const IDLE_MIN = parseInt(process.argv[2] || '25', 10);

(async () => {
  fs.writeFileSync(LOG, '');
  log(`Inicio. Idle a probar: ${IDLE_MIN} min`);
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const t0 = Date.now();
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.select('#DdlDocumento', '1');
  await page.type('#TxtCIP', DNI);
  await page.type('#TxtClave', CLAVE);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
    page.click('#BtnContinuar'),
  ]);
  log(`Login OK a las ${new Date(t0).toLocaleTimeString('es-PE', { timeZone: 'America/Lima' })}. URL: ${page.url()}`);

  // IDLE: sin ninguna peticion al servidor
  log(`En espera de ${IDLE_MIN} min sin tocar el servidor...`);
  await new Promise(r => setTimeout(r, IDLE_MIN * 60 * 1000));

  // Chequear
  const checkT = Date.now();
  try {
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    const marker = await page.evaluate(() => ({
      hasCerrarSesion: !!document.getElementById('BtnCerrarSesion'),
      hasLoginForm: !!document.getElementById('DdlDocumento'),
      url: location.href,
    }));
    const elapsedMin = ((checkT - t0) / 60000).toFixed(1);
    if (marker.hasCerrarSesion) {
      log(`✅ SESION ACTIVA despues de ${elapsedMin} min. URL: ${marker.url}`);
    } else {
      log(`❌ SESION EXPIRADA. Redirigido a login? loginForm=${marker.hasLoginForm}. URL: ${marker.url}`);
    }
  } catch (e) {
    log(`Error en chequeo: ${e.message}`);
  }
  await browser.close();
  log('FIN');
})().catch(e => { log('ERROR: ' + e.message); process.exit(1); });
