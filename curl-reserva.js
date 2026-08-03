const { createWorker } = require('tesseract.js');

const BASE = 'https://sistemas.policia.gob.pe/lunasoscurecidas';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const DNI = '72155722';
const CLAVE = 'jotace';
const SEDE = '1';
const FECHA_OBJETIVO = '25/08/2026';
const HORA_OBJETIVO = '10:00';

let cookieJar = [];

function log(msg) {
  const ts = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });
  console.log(`[${ts}] ${msg}`);
}

function extraerTokens(html) {
  const vs = /name="__VIEWSTATE" id="__VIEWSTATE" value="([^"]*)"/.exec(html);
  const ev = /name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="([^"]*)"/.exec(html);
  const vg = /name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="([^"]*)"/.exec(html);
  return {
    vs: vs ? vs[1] : '',
    ev: ev ? ev[1] : '',
    vg: vg ? vg[1] : '',
  };
}

function extraerTokensDelta(delta) {
  const get = (name) => {
    const re = new RegExp(`\\|\\d+\\|hiddenField\\|${name}\\|([^|]+)\\|`);
    const m = re.exec(delta);
    return m ? m[1] : '';
  };
  return {
    vs: get('__VIEWSTATE'),
    ev: get('__EVENTVALIDATION'),
    vg: get('__VIEWSTATEGENERATOR'),
  };
}

async function req(url, { method = 'GET', form = null, delta = false, referer = BASE + '/Solicitud_Menu.aspx' } = {}) {
  const headers = {
    'user-agent': UA,
    'accept': '*/*',
  };
  if (cookieJar.length) headers['cookie'] = cookieJar.join('; ');
  if (method === 'POST') {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    headers['origin'] = BASE;
    headers['referer'] = referer;
    if (delta) headers['x-microsoftajax'] = 'Delta=true';
  }
  const opts = { method, headers, redirect: 'manual' };
  if (form) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) body.set(k, v);
    opts.body = body.toString();
  }
  const res = await fetch(url, opts);
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of setCookies) cookieJar.push(c.split(';')[0]);
  const body = await res.text();
  return { status: res.status, headers: res.headers, body };
}

async function login() {
  log('1) Obteniendo formulario de login...');
  const g = await req(`${BASE}/Solicitud_Menu.aspx`);
  let tokens = extraerTokens(g.body);
  if (!tokens.vs) throw new Error('No se encontro __VIEWSTATE en el login');

  log('2) Enviando credenciales...');
  const form = {
    __EVENTTARGET: 'BtnContinuar',
    __EVENTARGUMENT: '',
    DdlDocumento: '1',
    TxtCIP: DNI,
    TxtClave: CLAVE,
    __VIEWSTATE: tokens.vs,
    __VIEWSTATEGENERATOR: tokens.vg,
    __EVENTVALIDATION: tokens.ev,
  };
  const p = await req(`${BASE}/Solicitud_Menu.aspx`, { method: 'POST', form });
  if (p.status === 302 || p.headers.get('location')) {
    const loc = p.headers.get('location');
    log(`   Login OK, redirigiendo a ${loc}`);
    const s = await req(BASE + loc.replace(/^\//, '/'));
    if (s.body.includes('Bienvenido')) log('   Sesion iniciada (Bienvenido)');
    return extraerTokens(s.body);
  }
  throw new Error(`Login fallo: status ${p.status}`);
}

function selectEnDelta(delta, name) {
  const re = new RegExp(`<select name="ctl00\\$MainContent\\$idUcitas\\$${name}"[^>]*>(.*?)</select>`, 's');
  const m = re.exec(delta);
  if (!m) return [];
  return [...m[1].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)]
    .map((x) => ({ value: x[1], text: x[2].trim() }))
    .filter((o) => o.value !== '0');
}

async function seleccionarSede(tokens) {
  log(`3) Seleccionando sede ${SEDE}...`);
  const form = {
    'ctl00$ScriptManager1': `ctl00$ScriptManager1|ctl00$MainContent$idUcitas$cbosede`,
    __EVENTTARGET: 'ctl00$MainContent$idUcitas$cbosede',
    __EVENTARGUMENT: '',
    'ctl00$MainContent$idUcitas$cbosede': SEDE,
    __VIEWSTATE: tokens.vs,
    __EVENTVALIDATION: tokens.ev,
  };
  const r = await req(`${BASE}/Seguimiento.aspx`, {
    method: 'POST', form, delta: true,
    referer: `${BASE}/Seguimiento.aspx`,
  });
  const fechas = selectEnDelta(r.body, 'cboFecha');
  const newTokens = extraerTokensDelta(r.body);
  if (fechas.length === 0) {
    const cupos = /id="MainContent_idUcitas_lblcupos"[^>]*>([^<]*)<\/span>/.exec(r.body);
    log(`   SIN CUPOS: ${cupos ? cupos[1].trim() : 'Sin Cupos'} (no hay fechas disponibles)`);
  } else {
    log(`   Fechas con cupos: ${fechas.map((f) => f.text).join(', ')}`);
  }
  return { fechas, tokens: { ...tokens, ...newTokens } };
}

async function seleccionarFecha(tokens, fecha) {
  log(`4) Seleccionando fecha ${fecha.value}...`);
  const form = {
    'ctl00$ScriptManager1': `ctl00$ScriptManager1|ctl00$MainContent$idUcitas$cboFecha`,
    __EVENTTARGET: 'ctl00$MainContent$idUcitas$cboFecha',
    __EVENTARGUMENT: '',
    'ctl00$MainContent$idUcitas$cboFecha': fecha.value,
    __VIEWSTATE: tokens.vs,
    __EVENTVALIDATION: tokens.ev,
  };
  const r = await req(`${BASE}/Seguimiento.aspx`, {
    method: 'POST', form, delta: true,
    referer: `${BASE}/Seguimiento.aspx`,
  });
  const horas = selectEnDelta(r.body, 'cboHora');
  if (horas.length === 0) log('   Sin horas para esa fecha');
  else log(`   Horas: ${horas.map((h) => h.text).join(', ')}`);
  return { horas, tokens: { ...tokens, ...extraerTokensDelta(r.body) } };
}

async function seleccionarHora(tokens, hora) {
  log(`5) Seleccionando hora ${hora.value}...`);
  const form = {
    'ctl00$ScriptManager1': `ctl00$ScriptManager1|ctl00$MainContent$idUcitas$cboHora`,
    __EVENTTARGET: 'ctl00$MainContent$idUcitas$cboHora',
    __EVENTARGUMENT: '',
    'ctl00$MainContent$idUcitas$cboHora': hora.value,
    __VIEWSTATE: tokens.vs,
    __EVENTVALIDATION: tokens.ev,
  };
  const r = await req(`${BASE}/Seguimiento.aspx`, {
    method: 'POST', form, delta: true,
    referer: `${BASE}/Seguimiento.aspx`,
  });
  const img = /src="(data:image[^"]*)"/.exec(r.body);
  if (img) {
    log('   Captcha visible (imagen base64 presente).');
    return { captchaImg: img[1], tokens: { ...tokens, ...extraerTokensDelta(r.body) } };
  }
  log('   No se detecto captcha en la respuesta.');
  return { captchaImg: null, tokens: { ...tokens, ...extraerTokensDelta(r.body) } };
}

async function resolverCaptchaBase64(src) {
  const worker = await createWorker('eng');
  const { data } = await worker.recognize(src);
  await worker.terminate();
  return (data.text || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

async function enviarCaptcha(tokens, captcha) {
  log(`6) Enviando captcha OCR: "${captcha}"...`);
  const form = {
    'ctl00$ScriptManager1': `ctl00$ScriptManager1|ctl00$MainContent$idUcitas$btgSiguiente`,
    __EVENTTARGET: 'ctl00$MainContent$idUcitas$btgSiguiente',
    __EVENTARGUMENT: '',
    'ctl00$MainContent$idUcitas$txtimg': captcha,
    __VIEWSTATE: tokens.vs,
    __EVENTVALIDATION: tokens.ev,
  };
  const r = await req(`${BASE}/Seguimiento.aspx`, {
    method: 'POST', form, delta: true,
    referer: `${BASE}/Seguimiento.aspx`,
  });
  const text = r.body
    .replace(/^[\s\S]*?updatePanel\|[^|]*\|/, '')
    .replace(/\|[0-9]+\|updatePanel\|[^|]*\|/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  log(`   Respuesta: ${text.slice(0, 300)}`);
  return r.body;
}

async function main() {
  let tokens = await login();
  const { fechas, tokens: t2 } = await seleccionarSede(tokens);
  tokens = t2;

  if (fechas.length === 0) {
    log('RESULTADO: No hay cupos en este momento. Nada que reservar.');
    return;
  }

  const fecha = fechas.find((f) => f.text === FECHA_OBJETIVO) || fechas[0];
  if (fecha.text !== FECHA_OBJETIVO) log(`   Fecha objetivo ${FECHA_OBJETIVO} no disponible; usando ${fecha.text}`);

  const { horas, tokens: t3 } = await seleccionarFecha(tokens, fecha);
  tokens = t3;
  if (horas.length === 0) {
    log('RESULTADO: La fecha no tiene horas disponibles.');
    return;
  }

  const hora = horas.find((h) => h.text === HORA_OBJETIVO) || horas[0];
  if (hora.text !== HORA_OBJETIVO) log(`   Hora objetivo ${HORA_OBJETIVO} no disponible; usando ${hora.text}`);

  const { captchaImg, tokens: t4 } = await seleccionarHora(tokens, hora);
  tokens = t4;
  if (!captchaImg) {
    log('RESULTADO: No aparecio captcha.');
    return;
  }

  const captcha = await resolverCaptchaBase64(captchaImg);
  await enviarCaptcha(tokens, captcha);
  log('RESULTADO: Flujo de reserva ejecutado. Revisar respuesta arriba.');
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
